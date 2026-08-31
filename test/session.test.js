'use strict';

const rules = require('../js/rules');
const session = require('../js/session');

describe('session', () => {
  test('AI match runs to completion, replay verifies', () => {
    const m = session.createSession({ seed: 777, rounds: 5, ai: { side: 'B', difficulty: 1 }, mode: 'practice' });
    session.begin(m, 1000);
    let guard = 0;
    while (!m.state.over && guard++ < 80) {
      session.aiAct(m);
      const st = m.state;
      if (st.over) break;
      if (st.phase === 'keeper' && rules.keeperSide(st) === 'A') {
        session.submit(m, 'dive', 'A', { dir: 'left', height: 'low', timing: 'on' });
      } else if (st.phase === 'shooter' && st.shooter === 'A') {
        session.submit(m, 'shoot', 'A', { dir: 'right', height: 'high', curve: 'none' });
      } else {
        session.aiAct(m);
      }
    }
    expect(m.state.over).toBe(true);
    expect(m.envelope.result).toBeTruthy();
    expect(m.envelope.result.elapsedMs).toBeGreaterThanOrEqual(0);
    const v = session.verifyReplay(m);
    expect(v.ok).toBe(true);
  });

  test('practice undo restores previous snapshot', () => {
    const m = session.createSession({ seed: 5, mode: 'practice' });
    const before = m.state.tick;
    session.submit(m, 'dive', 'B', { dir: 'left', height: 'low', timing: 'on' });
    expect(m.state.tick).toBe(before + 1);
    const r = session.undo(m);
    expect(r.ok).toBe(true);
    expect(m.state.tick).toBe(before);
    expect(m.envelope.commands).toHaveLength(0);
  });

  test('undo forbidden outside practice', () => {
    const m = session.createSession({ seed: 5, mode: 'journey' });
    session.submit(m, 'dive', 'B', { dir: 'left', height: 'low', timing: 'on' });
    expect(session.undo(m).ok).toBe(false);
  });

  test('cloud save document is checksummed', () => {
    const doc = { journeyDone: ['j01'], stats: { wins: 2 } };
    const enc = session.encodeSave(doc);
    const dec = session.decodeSave(enc);
    expect(dec.data).toEqual(doc);
    expect(session.decodeSave(enc.replace(/.$/, '0'))).toBeNull();
    expect(session.decodeSave('garbage')).toBeNull();
  });

  test('golden session: fixed seed and commands match snapshot hash', () => {
    const m = session.createSession({ seed: 4242, rounds: 3, ai: { side: 'B', difficulty: 0 }, mode: 'practice' });
    session.begin(m, 0);
    let guard = 0;
    while (!m.state.over && guard++ < 60) {
      session.aiAct(m);
      const st = m.state;
      if (st.over) break;
      if (st.phase === 'keeper') session.submit(m, 'dive', 'A', { dir: 'center', height: 'low', timing: 'on' });
      else session.submit(m, 'shoot', 'A', { dir: 'left', height: 'high', curve: 'none' });
    }
    expect(m.state.over).toBe(true);
    expect(rules.hashState(m.state)).toMatch(/^[0-9a-f]{8}$/);
    // Re-running the identical script yields the identical final hash
    const m2 = session.createSession({ seed: 4242, rounds: 3, ai: { side: 'B', difficulty: 0 }, mode: 'practice' });
    session.begin(m2, 0);
    guard = 0;
    while (!m2.state.over && guard++ < 60) {
      session.aiAct(m2);
      const st = m2.state;
      if (st.over) break;
      if (st.phase === 'keeper') session.submit(m2, 'dive', 'A', { dir: 'center', height: 'low', timing: 'on' });
      else session.submit(m2, 'shoot', 'A', { dir: 'left', height: 'high', curve: 'none' });
    }
    expect(rules.hashState(m2.state)).toBe(rules.hashState(m.state));
  });
});
