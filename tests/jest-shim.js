'use strict';
// The browser build's jest suites on node:test: describe / test / it and the
// expect matchers they use, as globals (require this first).
const nt = require('node:test');
const assert = require('node:assert/strict');

function matchers(actual, negate) {
  const check = (pass, msg) => { if (negate ? pass : !pass) assert.fail((negate ? 'not ' : '') + msg); };
  const show = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
  return {
    toBe: (e) => check(Object.is(actual, e), `expected ${show(actual)} to be ${show(e)}`),
    toEqual: (e) => {
      let pass = true;
      try { assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(e))); } catch { pass = false; }
      check(pass, `expected ${show(actual)} to equal ${show(e)}`);
    },
    toBeNull: () => check(actual === null, `expected ${show(actual)} to be null`),
    toBeTruthy: () => check(!!actual, `expected ${show(actual)} to be truthy`),
    toBeGreaterThan: (n) => check(actual > n, `expected ${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, `expected ${actual} >= ${n}`),
    toBeLessThan: (n) => check(actual < n, `expected ${actual} < ${n}`),
    toContain: (x) => check(actual != null && actual.indexOf(x) >= 0, `expected ${show(actual)} to contain ${show(x)}`),
    toHaveLength: (n) => check(actual != null && actual.length === n, `expected length ${actual && actual.length} to be ${n}`),
    toMatch: (re) => check(typeof re === 'string' ? String(actual).includes(re) : re.test(String(actual)), `expected ${show(actual)} to match ${re}`),
  };
}
global.expect = (actual) => Object.assign(matchers(actual, false), { not: matchers(actual, true) });
global.describe = nt.describe;
global.test = nt.test;
global.it = nt.it;
global.beforeAll = nt.before;
global.afterAll = nt.after;
global.beforeEach = nt.beforeEach;
global.afterEach = nt.afterEach;
