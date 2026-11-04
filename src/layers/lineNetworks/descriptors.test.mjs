import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINE_NETWORK_LAYERS,
  lineNetworkQueryBox,
  lineNetworkQueryUrl,
  normalizeLineNetwork,
} from './descriptors.js';

const [rail, power] = LINE_NETWORK_LAYERS;

test('only city-sized views are queried, snapped outwards', () => {
  assert.deepEqual(
    lineNetworkQueryBox({
      west: -71.3,
      south: 42.2,
      east: -70.9,
      north: 42.45,
    }),
    { west: -71.5, south: 42, east: -70.75, north: 42.5 },
  );
  assert.equal(
    lineNetworkQueryBox({ west: -80, south: 40, east: -70, north: 45 }),
    null,
  );
  const url = new URL(
    lineNetworkQueryUrl(
      rail,
      { west: -72, south: 42, east: -71, north: 43 },
      1,
    ),
  );
  assert.equal(url.searchParams.get('geometry'), '-72,42,-71,43');
  assert.equal(url.searchParams.get('resultOffset'), '2000');
});

test('features become classed lines; multi-part lines split', () => {
  const lines = normalizeLineNetwork(rail, {
    features: [
      {
        properties: { FRAARCID: 1, PASSNGR: 'C', NET: 'M', RROWNER1: 'MBTA' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [-71, 42],
            [-71.1, 42.1],
          ],
        },
      },
      {
        properties: { FRAARCID: 2, NET: 'Y' },
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-71, 42],
              [-71, 43],
            ],
            [
              [-72, 42],
              [-72, 43],
            ],
            [[0, 0]],
          ],
        },
      },
      { properties: { FRAARCID: 3 }, geometry: null },
    ],
  });
  assert.deepEqual(
    lines.map((line) => [line.id, line.class, line.passenger]),
    [
      ['rail:1', 'passenger', 'Commuter'],
      ['rail:2', 'other', null],
      ['rail:2', 'other', null],
    ],
  );
  assert.equal(normalizeLineNetwork(rail, {}), null);
  assert.deepEqual(
    ['500', '230', '69', '-999999'].map((VOLTAGE) =>
      power.classify({ VOLTAGE }),
    ),
    ['extra-high', 'high', 'medium', 'unknown'],
  );
});
