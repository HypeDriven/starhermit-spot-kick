'use strict';

/*
 * Spot Kick rooms client — StarHermit realtime rooms (host-routed), hosted
 * mode only. The lobby is REST (create / quick-join / open / result / leave /
 * mine); the transport is ws(s)://<host>/ws/v1/realtime?roomId=<id>&
 * access_token=<token>. The platform prefixes every routed binary frame with
 * a 16-byte sender participant id (stripped here); guest frames reach the
 * host only, host frames reach everyone. 8 KB/frame cap, JSON text control
 * frames <=4 KB (guests: ready only).
 *
 * The game's EXISTING shootout JSON rides the channel unchanged: guests send
 * their command objects (same shape the dev server validates) as binary
 * frames; the HOST runs the authoritative sim with the same rules/session
 * modules the dev server uses and broadcasts sanitized snapshots (the
 * committed dive stays hidden until the kick resolves), carrying the
 * kick-resolved event so both sides play the same resolution animation.
 * Roster/presence pushes drive lobby arrival and peer-left detection.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickRooms = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const SENDER_PREFIX = 16;         // bytes, platform participant id prefix
  const MAX_BINARY_FRAME = 8192;    // 8 KB cap per frame
  const MAX_TEXT_FRAME = 4096;      // JSON control frames stay <=4 KB
  const GUEST_INPUT_INTERVAL = 40;  // <=30 msg/s

  function encodeJsonFrame(obj) {
    return new TextEncoder().encode(JSON.stringify(obj));
  }
  function decodeJsonFrame(bytes) {
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return null; }
  }

  class RoomsClient {
    /**
     * @param platform SpotKickPlatform (token, gameSlug, profileFor)
     * @param hooks    { rules, session, build, contentVersion, onEvent }
     *                 onEvent(op, msg) receives: open, peer-joined, peer-left,
     *                 start, snap, cmd-rejected, result, error, disconnected,
     *                 auth-lost (token renewal refused; reconnecting stopped).
     */
    constructor(platform, hooks) {
      this.platform = platform;
      this.hooks = hooks;
      this.rules = hooks.rules;
      this.session = hooks.session;
      this.ws = null;
      this.connected = false;
      this.roomId = null;
      this.selfId = null;           // own participant id (when the room tells us)
      this.isHost = false;
      this.closed = false;          // intentional leave: no reconnect
      this.hostMatch = null;        // host-side authoritative session
      this._reconnects = 0;
      this._lastInputAt = 0;
      this._guestSender = null;     // participant id prefix of the seated guest
      this._guestSeen = false;      // a guest has been seated this match
      this._sawHost = false;
      this.renewing = false;        // true while renewing the token before a reconnect
    }

    _emit(op, msg) { if (this.hooks.onEvent) this.hooks.onEvent(op, msg || {}); }

    _api(path, opts) { return this.platform._fetchJson(path, opts, 0); }

    // ---- lobby (REST) -----------------------------------------------------------

    /** Host: create a 1v1 room and open it for quick-join. */
    async createRoom() {
      const res = await this._api('/realtime/rooms', {
        method: 'POST',
        body: {
          teamCount: 1,
          seatsPerTeam: 2,
          metadata: { gameSlug: this.platform.gameSlug, mode: '1v1' }
        }
      });
      if (!res.ok) throw new Error(res.error || 'rooms-unavailable');
      const room = res.data || {};
      this.roomId = room.id || room.roomId || null;
      this.selfId = room.selfId || room.participantId || (room.me && room.me.id) || room.hostId || null;
      if (!this.roomId) throw new Error('rooms-unavailable');
      this.isHost = true;
      await this._api('/realtime/rooms/' + encodeURIComponent(this.roomId) + '/open', { method: 'POST' })
        .catch(() => { /* open is best-effort; quick-join may still work */ });
      await this._connectWs();
      this._emit('open', { roomId: this.roomId, isHost: true });
    }

    /** Guest: quick-join an open match for this game. Returns false on 404. */
    async quickJoin() {
      const res = await this._api('/realtime/rooms/quick-join', {
        method: 'POST',
        body: { gameSlug: this.platform.gameSlug, seats: 1 }
      });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(res.error || 'rooms-unavailable');
      const room = res.data || {};
      this.roomId = room.roomId || room.id || (room.room && room.room.id) || null;
      this.selfId = room.selfId || room.participantId || (room.me && room.me.id) || null;
      if (!this.roomId) throw new Error('rooms-unavailable');
      this.isHost = false;
      await this._connectWs();
      this._emit('open', { roomId: this.roomId, isHost: false });
      return true;
    }

    // ---- transport ----------------------------------------------------------------

    _wsUrl() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      return proto + '://' + location.host + '/ws/v1/realtime?roomId=' +
        encodeURIComponent(this.roomId) + '&access_token=' + encodeURIComponent(this.platform.token);
    }

    _connectWs() {
      if (this.ws && this.ws.readyState <= 1) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(this._wsUrl());
        ws.binaryType = 'arraybuffer';
        const fail = () => reject(new Error('connect-failed'));
        ws.onerror = fail;
        ws.onclose = () => {
          const was = this.connected;
          this.connected = false;
          this.ws = null;
          if (was && !this.closed && this.roomId) this._scheduleReconnect();
        };
        ws.onopen = () => {
          this.connected = true;
          this._reconnects = 0;
          this.ws = ws;
          if (!this.isHost) this._sendControl({ op: 'ready' }); // guests: ready only
          resolve();
        };
        ws.onmessage = (e) => this._onMessage(e);
      });
    }

    _scheduleReconnect() {
      if (this.closed) return;
      if (this._reconnects >= 5) return this._emit('disconnected', {});
      const delay = Math.min(8000, 500 * Math.pow(2, this._reconnects++));
      setTimeout(async () => {
        // A failed reconnect may be an expired launch token (refused before
        // the upgrade, seen only as 1006): renew first, then rebuild the URL
        // from the current token. 'retry' backs off without reopening the old
        // URL; 'relaunch' means the token is dead — stop for good.
        const renewal = await this._renewForReconnect();
        if (this.closed || !this.roomId) return;
        if (renewal === 'relaunch') return this._authLost();
        if (renewal !== 'renewed') return this._scheduleReconnect();
        this.platform._fetchJson('/realtime/rooms/mine', {}, 0)
          .then(async (res) => {
            if (!res.ok) throw new Error('rooms-mine-failed');
            const m = res.data || {};
            const rid = m.roomId || m.id || (m.room && m.room.id) || null;
            if (!rid) throw new Error('not-in-room');
            this.roomId = rid;
            await this._connectWs();
            if (!this.isHost) this._emit('resumed', { roomId: this.roomId });
          })
          .catch(() => this._scheduleReconnect());
      }, delay);
    }

    async _renewForReconnect() {
      this.renewing = true;
      try { return await this.platform.renewForReconnect(); } catch (_) { return 'retry'; } finally { this.renewing = false; }
    }

    /** Renewal refused: drop the room locally (REST would 401) and surface relaunch. */
    _authLost() {
      this.closed = true;
      this.hostMatch = null;
      this.roomId = null;
      this._guestSender = null;
      try { if (this.ws) this.ws.close(); } catch (_) { /* already closed */ }
      this.ws = null;
      this._emit('auth-lost', {});
    }

    _sendControl(obj) {
      const text = JSON.stringify(obj);
      if (text.length > MAX_TEXT_FRAME) return;
      if (this.ws && this.ws.readyState === 1) this.ws.send(text);
    }

    _sendBinary(bytes) {
      if (bytes.byteLength > MAX_BINARY_FRAME) return;   // 8 KB cap
      if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
    }

    leave() {
      this.closed = true;
      const room = this.roomId;
      this.hostMatch = null;
      this.roomId = null;
      this._guestSender = null;
      try { if (this.ws) this.ws.close(); } catch (_) { /* already closed */ }
      this.ws = null;
      if (room) {
        this.platform._fetchJson('/realtime/rooms/' + encodeURIComponent(room) + '/leave', { method: 'POST' }, 0)
          .catch(() => { /* seat is released by the room TTL anyway */ });
      }
    }

    // ---- gameplay -----------------------------------------------------------------

    /** Host: begin the authoritative match once a peer is seated. */
    beginMatch(seed) {
      if (!this.isHost || this.hostMatch) return;
      this.hostMatch = this.session.createSession({
        seed: seed >>> 0, rounds: 5,
        build: this.hooks.build, contentVersion: this.hooks.contentVersion,
        mode: 'hosted', ai: null, timestampOffset: 0
      });
      this.session.begin(this.hostMatch, Date.now());
      this._guestSeen = false;
      this._sendControl({ op: 'start', seed: seed >>> 0, rounds: 5 });
      this._broadcastSnap(null);
      this._emit('start', { seed: seed >>> 0, rounds: 5 });
    }

    /**
     * Host: apply a command from either seat to the authoritative sim,
     * then broadcast the sanitized snapshot. Returns the rules result.
     */
    hostApplyCommand(cmd) {
      const m = this.hostMatch;
      if (!m || m.state.over) return { ok: false, reason: 'match-over' };
      const res = this.session.submit(m, cmd.type, cmd.player, cmd.params);
      if (res.ok) {
        const kick = res.events ? res.events.find(e => e.type === 'kick-resolved') : null;
        this._broadcastSnap(kick || null);
        if (m.state.over) this._finishMatch();
      }
      return res;
    }

    /** Guest: send a command frame to the host (<=30 msg/s, <=8 KB). */
    sendCommand(cmd) {
      if (this.isHost) return;
      const now = Date.now();
      if (now - this._lastInputAt < GUEST_INPUT_INTERVAL) return;
      this._lastInputAt = now;
      this._sendBinary(encodeJsonFrame({ t: 'cmd', cmd: cmd }));
    }

    _broadcastSnap(kick) {
      const m = this.hostMatch;
      if (!m) return;
      const st = this.rules.clone(m.state);
      // Hidden information: the committed dive stays hidden from everyone
      // (each keeper already sees their own choice locally) until the shot
      // resolves it — the dev server hides it from the shooter the same way.
      if (st.pendingDive) st.pendingDive = { hidden: true };
      const msg = { t: 'snap', state: st, waitingFor: this._waitingFor(st), kick: kick || null };
      this._sendBinary(encodeJsonFrame(msg));
      this._emit('snap', msg);   // host renders through the same path
    }

    _waitingFor(st) {
      if (st.over) return null;
      return st.phase === 'keeper' ? this.rules.keeperSide(st) : st.shooter;
    }

    _finishMatch() {
      const m = this.hostMatch;
      if (!m || !m.state.over) return;
      const st = m.state;
      const result = {
        winner: st.winner,
        terminalReason: st.terminalReason,
        breakdown: this.rules.breakdown(st),
        hash: this.rules.hashState(st)
      };
      this._sendControl({ op: 'result', result: result });
      if (this.roomId) {
        this.platform._fetchJson('/realtime/rooms/' + encodeURIComponent(this.roomId) + '/result', {
          method: 'POST', body: { result: result }
        }, 0).catch(() => { /* result frame already delivered the outcome */ });
      }
      this._emit('result', { result: result });
    }

    // ---- receive --------------------------------------------------------------------

    _onMessage(e) {
      if (typeof e.data === 'string') return this._onControl(e.data);
      const buf = new Uint8Array(e.data);
      if (buf.byteLength <= SENDER_PREFIX) return;
      const payload = buf.slice(SENDER_PREFIX);        // strip 16-byte sender id
      if (payload.byteLength > MAX_BINARY_FRAME) return;
      if (this.isHost) return this._onGuestBinary(buf.slice(0, SENDER_PREFIX), payload);
      const msg = decodeJsonFrame(payload);
      if (msg && msg.t === 'snap') this._emit('snap', msg);
    }

    _onGuestBinary(senderIdBytes, payload) {
      const msg = decodeJsonFrame(payload);
      if (!msg || msg.t !== 'cmd' || !msg.cmd || typeof msg.cmd !== 'object') return;
      if (!this.hostMatch) return;                     // lobby: no sim yet
      const cmd = msg.cmd;
      if (cmd.player !== 'B') return this._sendControl({ op: 'error', error: 'not-your-side' });
      const sender = Array.from(senderIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      if (this._guestSeen && sender !== this._guestSender && this.hostMatch.state.over) {
        return this._sendControl({ op: 'error', error: 'match-over' });
      }
      if (!this._guestSeen || sender !== this._guestSender) {
        // A (possibly reconnected) guest is seated in side B.
        this._guestSeen = true;
        this._guestSender = sender;
        this._emit('peer-joined', { seat: 'B' });
      }
      const res = this.hostApplyCommand(cmd);
      if (!res.ok && !res.countedInvalid) {
        this._sendControl({ op: 'error', error: res.reason || 'rejected' });
      }
    }

    _onControl(text) {
      if (text.length > MAX_TEXT_FRAME) return;
      let msg;
      try { msg = JSON.parse(text); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (typeof msg.op === 'string') return this._onOp(msg);
      // Roster/presence pushes (platform shape): drive lobby + departure.
      const list = msg.participants || msg.roster || msg.members || (Array.isArray(msg) ? msg : null);
      if (Array.isArray(list)) this._onRoster(list);
    }

    _onRoster(list) {
      const everyone = list.filter(p => p && typeof p === 'object');
      const idOf = (p) => p && (p.id || p.participantId || p.userId);
      // Without a self id we cannot tell ourselves apart from the peer; the
      // roster then still contains every participant, so a 2-seat room with a
      // seated peer lists >=2 entries.
      const others = this.selfId ? everyone.filter(p => idOf(p) !== this.selfId) : everyone;
      const peerCount = this.selfId ? others.length : Math.max(0, everyone.length - 1);
      if (this.isHost) {
        if (!this.hostMatch && peerCount >= 1) {
          const nick = (this.selfId ? others : everyone).map(p => p.nickname || p.name || p.displayName).filter(Boolean)[0];
          this._guestSeen = true;
          this._emit('peer-joined', { seat: 'B', name: nick || 'Opponent' });
          this.beginMatch((Math.random() * 0xffffffff) >>> 0);
        } else if (this.hostMatch && !this.hostMatch.state.over && this._guestSeen && peerCount === 0) {
          this._emit('peer-left', { seat: 'B' });
        }
      } else if (this.roomId) {
        if (peerCount >= 1) this._sawHost = true;
        else if (this._sawHost) this._emit('peer-left', { seat: 'A' });  // host gone
      }
    }

    _onOp(msg) {
      switch (msg.op) {
        case 'ready':
          // Guest (re)announced itself while a match runs: catch it up.
          if (this.isHost && this.hostMatch && !this.hostMatch.state.over) this._broadcastSnap(null);
          break;
        case 'start':
          this._emit('start', msg);
          break;
        case 'result':
          this._emit('result', msg);
          break;
        case 'error':
          this._emit('cmd-rejected', msg);
          break;
        default:
          this._emit(msg.op, msg);
      }
    }
  }

  return { RoomsClient: RoomsClient };
});
