import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWeatherAlertSnapshot } from './records.js';

const square = (lon, lat) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lon, lat],
      [lon + 1, lat],
      [lon + 1, lat + 1],
      [lon, lat],
    ],
  ],
});
const feature = (properties, geometry = square(-71, 42)) => ({
  type: 'Feature',
  properties: {
    cap_id: 'urn:oid:1',
    prod_type: 'Winter Storm Warning',
    sig: 'W',
    phenom: 'WS',
    wfo: 'KBOX',
    issuance: '2026-11-04T06:00:00-05:00',
    onset: '2026-11-04T18:00:00-05:00',
    ends: '2026-11-05T12:00:00-05:00',
    ...properties,
  },
  geometry,
});
const NOW = Date.parse('2026-11-04T12:00:00Z');

test('zones of one alert group under its CAP id', () => {
  const rows = normalizeWeatherAlertSnapshot(
    {
      features: [
        feature({}),
        feature({}, square(-72, 42)),
        feature({ cap_id: 'urn:oid:2', sig: 'Y', prod_type: 'Wind Advisory' }),
      ],
    },
    NOW,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].polygons.length, 2);
  assert.equal(rows[0].significance, 'warning');
  assert.equal(rows[0].office, 'KBOX');
  assert.equal(rows[0].endsMs, Date.parse('2026-11-05T17:00:00Z'));
  assert.equal(rows[1].significance, 'advisory');
});

test('invalid, unknown and ended alerts are skipped, not fatal', () => {
  const rows = normalizeWeatherAlertSnapshot(
    {
      features: [
        feature({ sig: 'Q' }),
        feature({ cap_id: '' }),
        feature({ prod_type: '<b>x</b>' }),
        feature({}, { type: 'Point', coordinates: [0, 0] }),
        feature({}, square(-200, 42)),
        feature({ ends: '2026-11-03T00:00:00Z' }),
        null,
      ],
    },
    NOW,
  );
  assert.deepEqual(rows, []);
  assert.equal(normalizeWeatherAlertSnapshot({}), null);
});
