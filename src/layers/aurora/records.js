/**
 * NOAA SWPC space weather: the OVATION aurora forecast grid and the planetary
 * Kp index. Public domain and keyless. Pure — no Cesium, no network.
 */
// A portable export: no i18n here. Labels stay English data; the layer
// translates them when shown.
const msg = (text) => text;

export const OVATION_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
export const KP_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

/** The grid: one cell per whole degree, longitude 0–359, latitude −90–90. */
export const GRID_WIDTH = 360;
export const GRID_HEIGHT = 181;

/** Chance-of-aurora bands, as SWPC colours them. Below the first, nothing draws. */
export const AURORA_BANDS = Object.freeze([
  Object.freeze({
    min: 10,
    label: msg('10–30% chance'),
    color: [61, 255, 143],
  }),
  Object.freeze({
    min: 30,
    label: msg('30–50% chance'),
    color: [255, 230, 64],
  }),
  Object.freeze({ min: 50, label: msg('50% or more'), color: [255, 69, 58] }),
]);

/**
 * The OVATION answer as a probability grid, row 0 at latitude 90.
 * @returns {{probabilities: Uint8Array, observedMs: number|null, forecastMs: number|null, max: number}|null}
 */
export function normalizeOvation(payload) {
  if (!Array.isArray(payload?.coordinates)) return null;
  const probabilities = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  let max = 0;
  for (const cell of payload.coordinates) {
    if (!Array.isArray(cell)) continue;
    const [lon, lat, chance] = cell;
    if (
      !Number.isInteger(lon) ||
      !Number.isInteger(lat) ||
      lon < 0 ||
      lon >= GRID_WIDTH ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(chance)
    )
      continue;
    const value = Math.max(0, Math.min(100, Math.round(chance)));
    // Columns run from longitude −180 so the grid drapes west to east.
    const x = (lon + 180) % GRID_WIDTH;
    probabilities[(90 - lat) * GRID_WIDTH + x] = value;
    if (value > max) max = value;
  }
  const time = (key) => {
    const ms = Date.parse(payload[key]);
    return Number.isFinite(ms) ? ms : null;
  };
  return {
    probabilities,
    observedMs: time('Observation Time'),
    forecastMs: time('Forecast Time'),
    max,
  };
}

/** The latest planetary Kp, or null. Rows are objects or SWPC's older arrays. */
export function latestKp(rows) {
  if (!Array.isArray(rows)) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const kp = Number(Array.isArray(row) ? row[1] : row?.Kp);
    const at = Date.parse(
      `${Array.isArray(row) ? row[0] : row?.time_tag}`.replace(' ', 'T') + 'Z',
    );
    if (Number.isFinite(kp) && kp >= 0 && kp <= 9 && Number.isFinite(at))
      return { kp, observedMs: at };
  }
  return null;
}

/** NOAA's geomagnetic storm scale for a Kp value. */
export function stormLevel(kp) {
  if (!Number.isFinite(kp)) return null;
  if (kp >= 9) return 'G5';
  if (kp >= 8) return 'G4';
  if (kp >= 7) return 'G3';
  if (kp >= 6) return 'G2';
  if (kp >= 5) return 'G1';
  return null;
}

/** RGBA pixels for the grid: transparent below 10%, more opaque with chance. */
export function auroraPixels(probabilities) {
  const pixels = new Uint8ClampedArray(probabilities.length * 4);
  for (let i = 0; i < probabilities.length; i++) {
    const chance = probabilities[i];
    let band = null;
    for (const entry of AURORA_BANDS) if (chance >= entry.min) band = entry;
    if (!band) continue;
    const [r, g, b] = band.color;
    pixels.set(
      [r, g, b, Math.round(90 + Math.min(1, chance / 60) * 130)],
      i * 4,
    );
  }
  return pixels;
}
