'use strict';

/*
 * Spot Kick session — local match orchestration: validated commands with
 * idempotent IDs, deterministic AI opponent, snapshot stack (practice undo),
 * replay envelope with periodic hashes, and cloud-save document helpers.
 * Runs in Node and the browser; no DOM access here.
 */
(function (root, factory) {
  const rules = (typeof module !== 'undefined' && module.exports) ? require('./rules') : root.SpotKickRules;
  const api = factory(rules);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickSession = api;
})(typeof self !== 'undefined' ? self : this, function (rules) {

  let cmdCounter = 0;
  function nextCommandId(sessionId) {
    cmdCounter = (cmdCounter + 1) >>> 0;
    return sessionId + '-' + cmdCounter.toString(36);
  }

  function randomSessionId(rand) {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const b = new Uint8Array(6); crypto.getRandomValues(b);
      return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
    }
    return Math.floor((rand || Math.random)() * 0xffffffff).toString(16);
  }

  // opts: {seed, rounds, constraints, build, contentVersion, mode,
  //        ai: {side:'A'|'B', difficulty} | null}
  function createSession(opts) {
    opts = opts || {};
    const state = rules.createInitialState({
      seed: opts.seed, rounds: opts.rounds, constraints: opts.constraints
    });
    const session = {
      id: opts.id || randomSessionId(),
      mode: opts.mode || 'practice',
      state: state,
      ai: opts.ai || null,                 // {side, difficulty}
      envelope: rules.createReplayEnvelope({
        build: opts.build || 'dev', contentVersion: opts.contentVersion || 1,
        timestampOffset: opts.timestampOffset || 0
      }, state),
      undoStack: [],
      startedAt: 0,                        // authoritative-ish local start
      endedAt: 0,
      appliedIds: {}                       // idempotent duplicate rejection
    };
    return session;
  }

  function begin(session, now) {
    session.startedAt = now || Date.now();
  }

  // Core: validate + apply a command; AI never auto-acts inside here.
  function submit(session, type, player, params) {
    const s = session.state;
    const cmd = { id: nextCommandId(session.id), tick: s.tick, type: type, player: player, params: params };
    if (session.appliedIds[cmd.id]) return { ok: true, duplicate: true, state: s };
    const res = rules.applyCommand(s, cmd);
    if (res.ok || res.countedInvalid) {
      session.undoStack.push(s); // snapshot before mutation (practice undo)
      if (session.undoStack.length > 64) session.undoStack.shift();
      session.state = res.state;
      session.appliedIds[cmd.id] = true;
      session.envelope.commands.push(cmd);
      session.envelope.hashes.push(rules.hashState(res.state));
      if (res.state.over) {
        session.endedAt = Date.now();
        session.envelope.result = {
          winner: res.state.winner,
          terminalReason: res.state.terminalReason,
          breakdown: rules.breakdown(res.state),
          elapsedMs: session.endedAt - session.startedAt
        };
      }
    }
    return res;
  }

  // Deterministic AI takes its turn when it is the AI's phase.
  // Returns a list of results (0, 1 or 2 applications).
  function aiAct(session) {
    const out = [];
    if (!session.ai || session.state.over) return out;
    const side = session.ai.side;
    const diff = session.ai.difficulty || 0;
    let guard = 0;
    while (!session.state.over && guard++ < 4) {
      const st = session.state;
      if (st.phase === 'keeper' && rules.keeperSide(st) === side) {
        out.push(submit(session, 'dive', side, rules.aiChooseDive(st, diff)));
      } else if (st.phase === 'shooter' && st.shooter === side) {
        out.push(submit(session, 'shoot', side, rules.aiChooseShot(st, diff)));
      } else break;
    }
    return out;
  }

  function undo(session) {
    if (session.mode !== 'practice') return { ok: false, reason: 'undo-not-permitted' };
    const prev = session.undoStack.pop();
    if (!prev) return { ok: false, reason: 'nothing-to-undo' };
    session.state = prev;
    session.envelope.commands.pop();
    session.envelope.hashes.pop();
    session.envelope.result = null;
    session.endedAt = 0;
    return { ok: true, state: prev };
  }

  function snapshot(session) { return session.state; }

  function exportReplay(session) {
    return JSON.parse(JSON.stringify(session.envelope));
  }

  function verifyReplay(session) {
    return rules.replayMatch(session.envelope);
  }

  // ---- versioned, checksummed cloud-save document ----
  function encodeSave(doc) {
    const body = JSON.stringify({ v: 1, at: Date.now(), data: doc });
    return body + '.' + rules.hashState({ doc: doc });
  }
  function decodeSave(text) {
    if (typeof text !== 'string') return null;
    const cut = text.lastIndexOf('.');
    if (cut < 0) return null;
    const body = text.slice(0, cut);
    try {
      const parsed = JSON.parse(body);
      if (rules.hashState({ doc: parsed.data }) !== text.slice(cut + 1)) return null;
      return parsed;
    } catch (_) { return null; }
  }

  return {
    createSession: createSession, begin: begin, submit: submit, aiAct: aiAct,
    undo: undo, snapshot: snapshot, exportReplay: exportReplay, verifyReplay: verifyReplay,
    encodeSave: encodeSave, decodeSave: decodeSave, randomSessionId: randomSessionId
  };
});
