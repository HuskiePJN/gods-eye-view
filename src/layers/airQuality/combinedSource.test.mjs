import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirQualitySource } from './source.js';

const row = (id, value) => ({ id, band: 'low', value });

test('a failed provider keeps its last readings and backs off', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const flaky = {
    getSnapshot: async () => {
      calls++;
      if (fail) throw new Error('429');
      return [row('b', 9)];
    },
  };
  const steady = { getSnapshot: async () => [row('a', 3)] };
  const warnings = [];
  const source = createAirQualitySource({
    sources: [flaky, steady],
    now: () => clock,
    warn: (...args) => warnings.push(args),
  });
  const ids = async () => (await source.getSnapshot()).map((r) => r.id);
  assert.deepEqual(await ids(), ['b', 'a']);

  fail = true;
  clock = 20 * 60_000;
  assert.deepEqual(await ids(), ['b', 'a'], 'last good readings stand in');
  assert.equal(warnings.length, 1);
  clock += 5 * 60_000;
  await ids();
  assert.equal(calls, 2, 'not retried within the backoff');
  clock += 10 * 60_000;
  await ids();
  assert.equal(calls, 3, 'retried after the backoff');

  clock += 3 * 60 * 60_000;
  assert.deepEqual(await ids(), ['a'], 'stale readings expire');
});
