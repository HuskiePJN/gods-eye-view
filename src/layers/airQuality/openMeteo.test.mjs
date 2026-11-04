import test from 'node:test';
import assert from 'node:assert/strict';
import { airQualitySeverity, normalizeOpenMeteoAirQuality } from './model.js';
import { createAirQualitySource } from './source.js';

const NOW = Date.parse('2026-11-04T08:30:00Z');
const points = [
  ['Boston', 42.36, -71.06],
  ['Delhi', 28.61, 77.21],
  ['Nowhere', 0, 0],
];
const current = (us_aqi, time = '2026-11-04T08:00') => ({
  current: { time, us_aqi, pm2_5: 12.4 },
});

test('Open-Meteo rows join their sample points in request order', () => {
  const rows = normalizeOpenMeteoAirQuality(
    [current(42), current(240), current(null)],
    points,
    NOW,
    100,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map(({ id, name, band, scale }) => [id, name, band, scale]),
    [
      ['open-meteo:100', 'Boston', 'low', 'US AQI'],
      ['open-meteo:101', 'Delhi', 'very-high', 'US AQI'],
    ],
  );
  assert.equal(rows[0].note, 'PM2.5 12 µg/m³');
  assert.equal(normalizeOpenMeteoAirQuality([current(1)], points, NOW), null);
  assert.deepEqual(
    normalizeOpenMeteoAirQuality(
      [current(1, '2026-11-03T00:00'), current(1), current(1)],
      points,
      NOW,
    ).map((row) => row.name),
    ['Delhi', 'Nowhere'],
  );
});

test('severity ranks bands before values across scales', () => {
  assert.ok(
    airQualitySeverity({ band: 'high', value: 7 }) >
      airQualitySeverity({ band: 'moderate', value: 95 }),
  );
});

test('the combined source keeps the providers that answer', async () => {
  const ok = { getSnapshot: async () => [{ id: 'b', band: 'low', value: 9 }] };
  const failing = {
    getSnapshot: async () => {
      throw new Error('down');
    },
  };
  const source = createAirQualitySource({ sources: [failing, ok] });
  assert.deepEqual(
    (await source.getSnapshot()).map((row) => row.id),
    ['b'],
  );
  await assert.rejects(
    createAirQualitySource({ sources: [failing] }).getSnapshot(),
    /down/,
  );
});
