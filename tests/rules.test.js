'use strict';

const rules = require('../js/rules');

function cmd(state, type, player, params, id) {
  return { id: id || 't-' + state.tick + '-' + type, tick: state.tick, type, player, params };
}
const dive = (d, h, t) => ({ dir: d, height: h, timing: t });
const shot = (d, h, c) => ({ dir: d, height: h, curve: c });

describe('rules engine', () => {
  test('initial state is sane and serializable', () => {
    const s = rules.createInitialState({ seed: 42 });
    expect(s.phase).toBe('keeper');
    expect(s.shooter).toBe('A');
    expect(s.tick).toBe(0);
    expect(rules.deserialize(rules.serialize(s))).toEqual(s);
  });

  test('legal actions: 18 dives in keeper phase, 18 shots in shooter phase', () => {
    const s = rules.createInitialState({ seed: 1 });
    const dives = rules.legalActions(s);
    expect(dives).toHaveLength(18);
    expect(dives.every(a => a.type === 'dive' && a.player === 'B')).toBe(true);
    const r = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('left', 'low', 'on')));
    expect(r.ok).toBe(true);
    const shots = rules.legalActions(r.state);
    expect(shots).toHaveLength(18);
    expect(shots.every(a => a.type === 'shoot' && a.player === 'A')).toBe(true);
  });

  test('exact-zone on-time dive saves; goal otherwise; roles swap', () => {
    let s = rules.createInitialState({ seed: 7 });
    s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('left', 'low', 'on'))).state;
    const r = rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('left', 'low', 'none')));
    expect(r.ok).toBe(true);
    expect(r.state.lastResult.outcome).toBe('saved');
    expect(r.state.savesB).toBe(1);
    expect(r.state.scoreA).toBe(0);
    expect(r.state.shooter).toBe('B');
    expect(r.state.tick).toBe(s.tick + 1);
  });

  test('late dive saves nothing; early dive beaten by curve; curve shifts column', () => {
    // late
    let s = rules.createInitialState({ seed: 11 });
    s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('left', 'low', 'late'))).state;
    let r = rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('left', 'low', 'none')));
    expect(r.state.lastResult.outcome).toBe('goal');

    // early + straight => saved (whole column)
    s = rules.createInitialState({ seed: 12 });
    s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('left', 'high', 'early'))).state;
    r = rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('left', 'low', 'none')));
    expect(r.state.lastResult.outcome).toBe('saved');

    // early + curve => beaten (curve right from center lands right; dive was left)
    s = rules.createInitialState({ seed: 13 });
    s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('center', 'low', 'early'))).state;
    r = rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('center', 'low', 'right')));
    expect(['goal', 'offtarget']).toContain(r.state.lastResult.outcome); // curve may miss frame
    if (r.state.lastResult.outcome === 'goal') expect(r.state.lastResult.finalCol).toBe('right');
  });

  test('curve can miss the frame deterministically', () => {
    // find a seed where a curved shot goes off target — must be reproducible
    let found = null;
    for (let seed = 0; seed < 200; seed++) {
      let s = rules.createInitialState({ seed });
      s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('right', 'high', 'on'))).state;
      const r = rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('left', 'low', 'left')));
      if (r.state.lastResult.outcome === 'offtarget') { found = seed; break; }
    }
    expect(found).not.toBeNull();
    // same seed reproduces
    let s = rules.createInitialState({ seed: found });
    s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('right', 'high', 'on'))).state;
    const r = rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('left', 'low', 'left')));
    expect(r.state.lastResult.outcome).toBe('offtarget');
    expect(r.state.offTargetA).toBe(1);
  });

  test('rejects out-of-turn, stale tick, bad id, constraints', () => {
    let s = rules.createInitialState({ seed: 3, constraints: { bannedCurves: ['left', 'right'], bannedHeights: [], bannedColumns: [] } });
    expect(rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('left', 'low', 'none'))).reason).toBe('out-of-turn');
    expect(rules.applyCommand(s, cmd(s, 'dive', 'A', dive('left', 'low', 'on'))).reason).toBe('not-keeper');
    expect(rules.applyCommand(s, { id: 'x', tick: 99, type: 'dive', player: 'B', params: dive('left', 'low', 'on') }).reason).toBe('stale-tick');
    expect(rules.applyCommand(s, { tick: 0, type: 'dive', player: 'B', params: dive('left', 'low', 'on') }).reason).toBe('bad-command-id');
    s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('left', 'low', 'on'))).state;
    const curved = rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('left', 'low', 'left')));
    expect(curved.ok).toBe(false);
    expect(curved.reason).toBe('curve-banned');
    expect(curved.countedInvalid).toBe(true);
    expect(curved.state.invalidA).toBe(1);
  });

  test('full match to terminal with early mathematical finish possible', () => {
    // A scores all, B misses all -> ends after B can no longer catch up
    let s = rules.createInitialState({ seed: 21, rounds: 5 });
    let guard = 0;
    while (!s.over && guard++ < 40) {
      if (s.phase === 'keeper') {
        const keeper = rules.keeperSide(s);
        s = rules.applyCommand(s, cmd(s, 'dive', keeper, dive('left', 'low', 'on'))).state;
      } else {
        // A scores (right/high vs left/low dive); B is saved (left/low into the dive)
        const p = s.shooter === 'A' ? shot('right', 'high', 'none') : shot('left', 'low', 'none');
        s = rules.applyCommand(s, cmd(s, 'shoot', s.shooter, p)).state;
      }
    }
    expect(s.over).toBe(true);
    expect(s.winner).toBe('A');
    expect(s.scoreA).toBeGreaterThan(s.scoreB);
    expect(['mathematical', 'decided-regular']).toContain(s.terminalReason);
    expect(rules.isTerminal(s)).toBe(true);
    expect(rules.winnerOf(s)).toBe('A');
    expect(rules.legalActions(s)).toHaveLength(0);
  });

  test('sudden death on level scores after full set', () => {
    let s = rules.createInitialState({ seed: 33, rounds: 1 });
    // both score round 1
    for (let i = 0; i < 2; i++) {
      const keeper = rules.keeperSide(s);
      s = rules.applyCommand(s, cmd(s, 'dive', keeper, dive('left', 'low', 'on'))).state;
      s = rules.applyCommand(s, cmd(s, 'shoot', s.shooter, shot('right', 'low', 'none'))).state;
    }
    expect(s.suddenDeath).toBe(true);
    expect(s.over).toBe(false);
    // SD: A scores, B saved
    s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('left', 'low', 'on'))).state;
    s = rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('right', 'low', 'none'))).state;
    s = rules.applyCommand(s, cmd(s, 'dive', 'A', dive('left', 'low', 'on'))).state;
    s = rules.applyCommand(s, cmd(s, 'shoot', 'B', shot('left', 'low', 'none'))).state;
    expect(s.over).toBe(true);
    expect(s.winner).toBe('A');
    expect(s.terminalReason).toBe('decided-sudden-death');
  });

  test('deterministic replay: same seed + commands => identical hashes', () => {
    const play = () => {
      let s = rules.createInitialState({ seed: 99, rounds: 3 });
      const env = rules.createReplayEnvelope({}, s);
      const hashes = [];
      let guard = 0;
      while (!s.over && guard++ < 60) {
        const c = s.phase === 'keeper'
          ? cmd(s, 'dive', rules.keeperSide(s), rules.aiChooseDive(s, 1))
          : cmd(s, 'shoot', s.shooter, rules.aiChooseShot(s, 1));
        const r = rules.applyCommand(s, c);
        s = r.state;
        env.commands.push(c);
        env.hashes.push(rules.hashState(s));
        hashes.push(rules.hashState(s));
      }
      env.result = { winner: s.winner };
      return { env, hashes, s };
    };
    const a = play(), b = play();
    expect(a.hashes).toEqual(b.hashes);
    const check = rules.replayMatch(a.env);
    expect(check.ok).toBe(true);
    expect(rules.hashState(check.state)).toBe(rules.hashState(a.s));
  });

  test('replay detects hash and result tampering', () => {
    let s = rules.createInitialState({ seed: 5, rounds: 1 });
    const env = rules.createReplayEnvelope({}, s);
    s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('left', 'low', 'on'))).state;
    env.commands.push(env.commands.length ? null : cmd({ tick: 0 }, 'dive', 'B', dive('left', 'low', 'on'), 'd1'));
    env.hashes.push(rules.hashState(s));
    const bad = JSON.parse(JSON.stringify(env));
    bad.hashes[0] = 'deadbeef';
    expect(rules.replayMatch(bad).ok).toBe(false);
    const badResult = JSON.parse(JSON.stringify(env));
    badResult.result = { winner: 'A' };
    expect(rules.replayMatch(badResult).ok).toBe(false); // match isn't over
  });

  test('breakdown components and tie-break ladder', () => {
    let s = rules.createInitialState({ seed: 8, rounds: 1 });
    s = rules.applyCommand(s, cmd(s, 'dive', 'B', dive('left', 'low', 'on'))).state;
    s = rules.applyCommand(s, cmd(s, 'shoot', 'A', shot('right', 'high', 'none'))).state;
    const b = rules.breakdown(s);
    expect(b.goals.A).toBe(1);
    expect(b.kicks.A).toBe(1);
    expect(b.invalidActions.B).toBe(0);
    const r1 = { scoreA: 2, scoreB: 1, invalidA: 0, invalidB: 0, elapsedMs: 100, sessionId: 'a' };
    const r2 = { scoreA: 2, scoreB: 1, invalidA: 1, invalidB: 0, elapsedMs: 100, sessionId: 'b' };
    expect(rules.compareResults(r1, r2)).toBeLessThan(0); // fewer invalids wins
  });

  test('fuzz: malformed commands never hang or corrupt state', () => {
    let s = rules.createInitialState({ seed: 1234 });
    const junk = [null, undefined, {}, { id: 5 }, { id: '', tick: 0 }, { id: 'a', tick: -1 },
      { id: 'a', tick: 0, type: 'explode', player: 'A' },
      { id: 'a', tick: 0, type: 'dive', player: 'C', params: {} },
      { id: 'a', tick: 0, type: 'dive', player: 'B', params: { dir: 'up', height: 'low', timing: 'on' } },
      { id: 'a', tick: 0, type: 'dive', player: 'B' }];
    for (const j of junk) {
      const r = rules.applyCommand(s, j);
      expect(r.ok).toBe(false);
      if (r.state) s = r.state; // countedInvalid states remain valid
      expect(Number.isFinite(s.tick)).toBe(true);
    }
    // state still playable
    const legal = rules.legalActions(s);
    expect(legal.length).toBeGreaterThan(0);
  });
});
