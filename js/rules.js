'use strict';

/*
 * Spot Kick rules engine — pure, deterministic, no DOM / no Three.js.
 * Exposes: legal-action queries, validated commands, deterministic resolution,
 * serializable state, monotonic tick, terminal reason, seeded random streams,
 * scoring breakdown, deterministic AI, state hashing and replay verification.
 * Works in Node (module.exports) and the browser (window.SpotKickRules).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickRules = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const VERSION = 2;            // rules schema version
  const ROUNDS_PER_PLAYER = 5;  // kicks per side before sudden death
  const COLUMNS = ['left', 'center', 'right'];
  const HEIGHTS = ['low', 'high'];
  const CURVES = ['none', 'left', 'right'];
  const TIMINGS = ['early', 'on', 'late'];
  const CURVE_MISS_PER_MILLE = 125; // 1/8 chance a curved shot misses the frame

  // ---- seeded random stream (mulberry32), state lives inside game state ----
  function nextRand(state, stream) {
    // stream: 'rules' | 'ai' — separate streams so AI rolls never perturb the
    // rules stream. Each stream keeps its own 32-bit counter in the state.
    const key = stream === 'ai' ? 'rngAi' : 'rng';
    let s = state[key] | 0;
    s = (s + 0x6D2B79F5) | 0;
    state[key] = s;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function mixSeed(seed, salt) {
    let h = (seed >>> 0) ^ 0x9e3779b9;
    const str = String(salt);
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // ---- initial state ----
  function createInitialState(opts) {
    opts = opts || {};
    const seed = (opts.seed === undefined ? 0x5b7a9c3d : opts.seed) >>> 0;
    const rounds = Math.max(1, Math.min(7, opts.rounds || ROUNDS_PER_PLAYER));
    return {
      version: VERSION,
      seed: seed,
      rng: seed >>> 0,
      rngAi: mixSeed(seed, 'ai'),
      rounds: rounds,
      constraints: normalizeConstraints(opts.constraints),
      tick: 0,
      phase: 'keeper',          // 'keeper' -> 'shooter' -> 'keeper' ... -> 'over'
      shooter: 'A',             // 'A' always shoots first
      pendingDive: null,
      scoreA: 0, scoreB: 0,
      kicksA: 0, kicksB: 0,
      savesA: 0, savesB: 0,     // saves made while keeping
      offTargetA: 0, offTargetB: 0,
      perfectA: 0, perfectB: 0, // goals that beat a correctly guessed zone
      suddenDeath: false,
      sdRound: 0,
      over: false,
      winner: null,
      terminalReason: null,
      invalidA: 0, invalidB: 0,
      lastResult: null,         // {outcome, finalCol, shot, dive, shooter}
      log: []                   // compact per-kick records for results/replay UI
    };
  }

  function normalizeConstraints(c) {
    c = c || {};
    return {
      bannedCurves: Array.isArray(c.bannedCurves) ? c.bannedCurves.slice() : [],
      bannedHeights: Array.isArray(c.bannedHeights) ? c.bannedHeights.slice() : [],
      bannedColumns: Array.isArray(c.bannedColumns) ? c.bannedColumns.slice() : [],
      timeLimitMs: typeof c.timeLimitMs === 'number' ? c.timeLimitMs : 0
    };
  }

  // ---- helpers ----
  function keeperSide(state) { return state.shooter === 'A' ? 'B' : 'A'; }

  function applyCurve(col, curve) {
    let i = COLUMNS.indexOf(col);
    if (curve === 'left') i = Math.max(0, i - 1);
    else if (curve === 'right') i = Math.min(COLUMNS.length - 1, i + 1);
    return COLUMNS[i];
  }

  function isLegalShot(state, p) {
    const c = state.constraints;
    if (!p || typeof p !== 'object') return { ok: false, reason: 'malformed-params' };
    if (COLUMNS.indexOf(p.dir) < 0) return { ok: false, reason: 'bad-direction' };
    if (HEIGHTS.indexOf(p.height) < 0) return { ok: false, reason: 'bad-height' };
    if (CURVES.indexOf(p.curve) < 0) return { ok: false, reason: 'bad-curve' };
    if (c.bannedColumns.indexOf(p.dir) >= 0) return { ok: false, reason: 'column-banned' };
    if (c.bannedHeights.indexOf(p.height) >= 0) return { ok: false, reason: 'height-banned' };
    if (c.bannedCurves.indexOf(p.curve) >= 0) return { ok: false, reason: 'curve-banned' };
    return { ok: true };
  }

  function isLegalDive(state, p) {
    if (!p || typeof p !== 'object') return { ok: false, reason: 'malformed-params' };
    if (COLUMNS.indexOf(p.dir) < 0) return { ok: false, reason: 'bad-direction' };
    if (HEIGHTS.indexOf(p.height) < 0) return { ok: false, reason: 'bad-height' };
    if (TIMINGS.indexOf(p.timing) < 0) return { ok: false, reason: 'bad-timing' };
    return { ok: true };
  }

  // ---- legal action query (also used by hints/tutorial — single source) ----
  function legalActions(state) {
    if (!state || state.over) return [];
    const acts = [];
    if (state.phase === 'keeper') {
      const keeper = keeperSide(state);
      for (const dir of COLUMNS) for (const height of HEIGHTS) for (const timing of TIMINGS) {
        acts.push({ type: 'dive', player: keeper, params: { dir, height, timing } });
      }
    } else if (state.phase === 'shooter') {
      for (const dir of COLUMNS) for (const height of HEIGHTS) for (const curve of CURVES) {
        const params = { dir, height, curve };
        if (isLegalShot(state, params).ok) {
          acts.push({ type: 'shoot', player: state.shooter, params });
        }
      }
    }
    return acts;
  }

  // ---- resolution (deterministic given state + both choices) ----
  function resolveOutcome(state, shot, dive) {
    const finalCol = applyCurve(shot.dir, shot.curve);
    // Curved shots carry a seeded off-target risk; rules stream only.
    if (shot.curve !== 'none') {
      if (nextRand(state, 'rules') * 1000 < CURVE_MISS_PER_MILLE) {
        return { outcome: 'offtarget', finalCol };
      }
    }
    const colMatch = dive.dir === finalCol;
    const heightMatch = dive.height === shot.height;
    if (colMatch && heightMatch) {
      if (dive.timing === 'on') return { outcome: 'saved', finalCol };
      if (dive.timing === 'early' && shot.curve === 'none') return { outcome: 'saved', finalCol };
      return { outcome: 'goal', finalCol, perfect: true }; // keeper read it, beaten anyway
    }
    if (colMatch && dive.timing === 'early' && shot.curve === 'none') {
      // Fully committed early dive covers the whole column against a straight shot.
      return { outcome: 'saved', finalCol };
    }
    return { outcome: 'goal', finalCol };
  }

  // ---- match end logic ----
  function checkTerminal(state) {
    if (!state.suddenDeath) {
      const remA = state.rounds - state.kicksA;
      const remB = state.rounds - state.kicksB;
      if (state.scoreA > state.scoreB + remB) {
        return end(state, 'A', 'mathematical');
      }
      if (state.scoreB > state.scoreA + remA) {
        return end(state, 'B', 'mathematical');
      }
      if (remA === 0 && remB === 0) {
        if (state.scoreA !== state.scoreB) {
          return end(state, state.scoreA > state.scoreB ? 'A' : 'B', 'decided-regular');
        }
        state.suddenDeath = true;
        state.sdRound = 1;
      }
    } else {
      // sudden death: after an equal number of SD kicks each, a difference decides
      const sdA = state.kicksA - state.rounds;
      const sdB = state.kicksB - state.rounds;
      if (sdA === sdB && state.scoreA !== state.scoreB) {
        return end(state, state.scoreA > state.scoreB ? 'A' : 'B', 'decided-sudden-death');
      }
      if (sdA > state.sdRound) state.sdRound = sdA;
    }
    return state;
  }

  function end(state, winner, reason) {
    state.over = true;
    state.winner = winner;
    state.terminalReason = reason;
    state.phase = 'over';
    state.pendingDive = null;
    return state;
  }

  // ---- validated command application ----
  // cmd: {id, tick, type:'dive'|'shoot', player:'A'|'B', params:{...}}
  // Returns {ok, reason?, state, events?}. Never mutates the input state.
  function applyCommand(state, cmd) {
    if (!state || typeof state !== 'object') return { ok: false, reason: 'no-state' };
    if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'malformed-command' };
    if (typeof cmd.id !== 'string' || cmd.id.length === 0 || cmd.id.length > 64) {
      return { ok: false, reason: 'bad-command-id' };
    }
    if (cmd.tick !== state.tick) return { ok: false, reason: 'stale-tick' };
    if (state.over) return { ok: false, reason: 'match-over' };
    if (cmd.player !== 'A' && cmd.player !== 'B') return { ok: false, reason: 'bad-player' };

    const next = clone(state);

    if (cmd.type === 'dive') {
      if (next.phase !== 'keeper') return { ok: false, reason: 'out-of-turn' };
      const keeper = keeperSide(next);
      if (cmd.player !== keeper) return { ok: false, reason: 'not-keeper' };
      const legal = isLegalDive(next, cmd.params);
      if (!legal.ok) {
        next[keeper === 'A' ? 'invalidA' : 'invalidB']++;
        next.tick++;
        return { ok: false, reason: legal.reason, state: next, countedInvalid: true };
      }
      next.pendingDive = { dir: cmd.params.dir, height: cmd.params.height, timing: cmd.params.timing };
      next.phase = 'shooter';
      next.tick++;
      return { ok: true, state: next, events: [{ type: 'dive-committed', player: keeper }] };
    }

    if (cmd.type === 'shoot') {
      if (next.phase !== 'shooter') return { ok: false, reason: 'out-of-turn' };
      if (cmd.player !== next.shooter) return { ok: false, reason: 'not-shooter' };
      const legal = isLegalShot(next, cmd.params);
      if (!legal.ok) {
        next[next.shooter === 'A' ? 'invalidA' : 'invalidB']++;
        next.tick++;
        return { ok: false, reason: legal.reason, state: next, countedInvalid: true };
      }
      const shot = { dir: cmd.params.dir, height: cmd.params.height, curve: cmd.params.curve };
      const dive = next.pendingDive;
      const res = resolveOutcome(next, shot, dive);
      const shooter = next.shooter;
      const keeper = keeperSide(next);

      if (shooter === 'A') next.kicksA++; else next.kicksB++;
      if (res.outcome === 'goal') {
        if (shooter === 'A') { next.scoreA++; if (res.perfect) next.perfectA++; }
        else { next.scoreB++; if (res.perfect) next.perfectB++; }
      } else if (res.outcome === 'saved') {
        if (keeper === 'A') next.savesA++; else next.savesB++;
      } else {
        if (shooter === 'A') next.offTargetA++; else next.offTargetB++;
      }
      next.lastResult = { outcome: res.outcome, finalCol: res.finalCol, shot, dive, shooter };
      next.log.push({
        k: next.kicksA + next.kicksB, s: shooter, o: res.outcome,
        sh: [shot.dir, shot.height, shot.curve], dv: [dive.dir, dive.height, dive.timing]
      });
      next.pendingDive = null;
      next.shooter = keeper; // swap roles
      next.phase = 'keeper';
      next.tick++;
      checkTerminal(next);
      return {
        ok: true, state: next,
        events: [
          { type: 'kick-resolved', outcome: res.outcome, shooter: shooter, shot: shot, dive: dive, finalCol: res.finalCol },
          ...(next.over ? [{ type: 'match-over', winner: next.winner, reason: next.terminalReason }] : [])
        ]
      };
    }

    return { ok: false, reason: 'unknown-command-type' };
  }

  // ---- scoring / results breakdown ----
  function breakdown(state) {
    return {
      goals: { A: state.scoreA, B: state.scoreB },
      saves: { A: state.savesA, B: state.savesB },
      perfectKicks: { A: state.perfectA, B: state.perfectB },
      offTarget: { A: state.offTargetA, B: state.offTargetB },
      invalidActions: { A: state.invalidA, B: state.invalidB },
      kicks: { A: state.kicksA, B: state.kicksB },
      suddenDeath: state.suddenDeath,
      winner: state.winner,
      terminalReason: state.terminalReason
    };
  }

  function isTerminal(state) { return !!state.over; }
  function winnerOf(state) { return state.over ? state.winner : null; }

  // Tie-break ladder (spec): primary objective (total goals), fewer invalid
  // actions, lower authoritative elapsed time, then stable session identifier.
  function compareResults(a, b) {
    const goalsA = a.scoreA + a.scoreB, goalsB = b.scoreA + b.scoreB;
    if (goalsA !== goalsB) return goalsB - goalsA;
    const invA = a.invalidA + a.invalidB, invB = b.invalidA + b.invalidB;
    if (invA !== invB) return invA - invB;
    if ((a.elapsedMs || 0) !== (b.elapsedMs || 0)) return (a.elapsedMs || 0) - (b.elapsedMs || 0);
    return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
  }

  // ---- deterministic AI ----
  // difficulty 0 (casual) .. 2 (sharp). Uses the dedicated 'ai' stream.
  function aiChooseDive(state, difficulty) {
    const r = () => nextRand(state, 'ai');
    const smart = r() < [0.34, 0.55, 0.78][difficulty || 0];
    if (smart) {
      const dir = COLUMNS[(r() * 3) | 0];
      const height = r() < 0.5 ? 'low' : 'high';
      const timing = difficulty >= 2 ? 'on' : (r() < 0.7 ? 'on' : (r() < 0.5 ? 'early' : 'late'));
      return { dir: dir, height: height, timing: timing };
    }
    return {
      dir: COLUMNS[(r() * 3) | 0],
      height: r() < 0.6 ? 'low' : 'high',
      timing: difficulty === 0 ? (r() < 0.5 ? 'early' : 'on') : 'on'
    };
  }

  function aiChooseShot(state, difficulty) {
    const r = () => nextRand(state, 'ai');
    const legal = legalActions(state).filter(a => a.type === 'shoot').map(a => a.params);
    if (legal.length === 0) return { dir: 'center', height: 'low', curve: 'none' };
    const smart = r() < [0.30, 0.55, 0.8][difficulty || 0];
    if (smart) {
      const curved = legal.filter(p => p.curve !== 'none');
      const pool = (difficulty >= 1 && curved.length) ? curved : legal;
      const corners = pool.filter(p => p.dir !== 'center');
      const pick = (corners.length && r() < 0.7) ? corners : pool;
      return pick[(r() * pick.length) | 0];
    }
    return legal[(r() * legal.length) | 0];
  }

  // ---- serialization, hashing, replay ----
  function clone(state) { return JSON.parse(JSON.stringify(state)); }

  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    if (!s || s.version !== VERSION) throw new Error('unsupported-state-version');
    return s;
  }

  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  function hashState(state) {
    // rngAi is a decision-stream cursor (its outputs are already captured as
    // commands in a replay), so it is excluded from the authoritative hash.
    const s = stableStringify(Object.assign({}, state, { rngAi: 0 }));
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // Replay envelope: schema, build, content version, seed, initial hash,
  // timestamp offset, ordered commands, periodic state hashes, terminal result.
  function createReplayEnvelope(opts, initialState) {
    opts = opts || {};
    return {
      schema: 1,
      build: opts.build || 'dev',
      contentVersion: opts.contentVersion || 1,
      seed: initialState.seed,
      rounds: initialState.rounds,
      constraints: initialState.constraints,
      initialHash: hashState(initialState),
      timestampOffset: opts.timestampOffset || 0,
      commands: [],
      hashes: [],
      result: null
    };
  }

  // Replay a command list from scratch; returns {ok, state?, reason?, at?}.
  function replayMatch(envelope) {
    let state = createInitialState({
      seed: envelope.seed, rounds: envelope.rounds, constraints: envelope.constraints
    });
    if (hashState(state) !== envelope.initialHash) return { ok: false, reason: 'initial-hash-mismatch' };
    for (let i = 0; i < envelope.commands.length; i++) {
      const cmd = envelope.commands[i];
      const res = applyCommand(state, cmd);
      if (!res.ok && !res.countedInvalid) return { ok: false, reason: 'command-rejected', at: i };
      state = res.state;
      if (envelope.hashes[i] && envelope.hashes[i] !== hashState(state)) {
        return { ok: false, reason: 'hash-mismatch', at: i };
      }
    }
    if (envelope.result) {
      if (state.over !== true || state.winner !== envelope.result.winner) {
        return { ok: false, reason: 'result-mismatch', state: state };
      }
    }
    return { ok: true, state: state };
  }

  return {
    VERSION: VERSION, ROUNDS_PER_PLAYER: ROUNDS_PER_PLAYER,
    COLUMNS: COLUMNS, HEIGHTS: HEIGHTS, CURVES: CURVES, TIMINGS: TIMINGS,
    createInitialState: createInitialState, legalActions: legalActions,
    isLegalShot: isLegalShot, isLegalDive: isLegalDive,
    applyCommand: applyCommand, checkTerminal: checkTerminal,
    isTerminal: isTerminal, winnerOf: winnerOf, breakdown: breakdown,
    compareResults: compareResults,
    applyCurve: applyCurve, keeperSide: keeperSide, nextRand: nextRand, mixSeed: mixSeed,
    aiChooseDive: aiChooseDive, aiChooseShot: aiChooseShot,
    clone: clone, serialize: serialize, deserialize: deserialize,
    hashState: hashState, stableStringify: stableStringify,
    createReplayEnvelope: createReplayEnvelope, replayMatch: replayMatch
  };
});
