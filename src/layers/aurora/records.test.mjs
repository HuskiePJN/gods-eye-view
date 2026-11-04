import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_WIDTH,
  auroraPixels,
  latestKp,
  normalizeOvation,
  stormLevel,
} from './records.js';

test('the OVATION grid starts at 180°W with row 0 at the pole', () => {
  const grid = normalizeOvation({
    'Forecast Time': '2026-11-04T08:27:00Z',
    coordinates: [
      [0, 90, 12],
      [265, 60, 45],
      [400, 60, 99],
      ['x', 1, 1],
    ],
  });
  assert.equal(grid.max, 45);
  assert.equal(grid.forecastMs, Date.parse('2026-11-04T08:27:00Z'));
  assert.equal(grid.probabilities[180], 12);
  assert.equal(grid.probabilities[30 * GRID_WIDTH + 85], 45);
  assert.equal(normalizeOvation({}), null);
});

test('pixels are clear below 10% and coloured by band above', () => {
  const pixels = auroraPixels(Uint8Array.from([5, 20, 60]));
  assert.equal(pixels[3], 0);
  assert.deepEqual([...pixels.slice(4, 7)], [61, 255, 143]);
  assert.deepEqual([...pixels.slice(8, 11)], [255, 69, 58]);
});

test('the latest Kp and its storm level', () => {
  assert.deepEqual(
    latestKp([
      { time_tag: '2026-11-04T00:00:00', Kp: 2.33 },
      { time_tag: '2026-11-04T03:00:00', Kp: 5.67 },
      { time_tag: 'bad', Kp: 9 },
    ]),
    { kp: 5.67, observedMs: Date.parse('2026-11-04T03:00:00Z') },
  );
  assert.deepEqual([4.9, 5, 7.3, 9].map(stormLevel), [null, 'G1', 'G3', 'G5']);
});
