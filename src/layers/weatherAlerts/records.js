/**
 * Normalize the NWS watch/warning/advisory map service (one GeoJSON feature
 * per affected zone or storm-based polygon) into one row per alert, its
 * polygons grouped under the CAP message id. Individually invalid features
 * are skipped; only a payload that is not a feature collection at all
 * rejects the snapshot. Pure: the server proxy and the browser both use it.
 */

/** NWS VTEC significance codes, strongest first. */
export const ALERT_SIGNIFICANCE = Object.freeze({
  W: 'warning',
  A: 'watch',
  Y: 'advisory',
  S: 'statement',
});

const MAX_ALERTS = 2000;
const MAX_POLYGONS_PER_ALERT = 400;

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) return false;
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return false;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return false;
  }
  return true;
}

function polygonsOf(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return null;
  if (!Array.isArray(polygons)) return null;
  const result = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length) continue;
    if (!rings.every(validRing)) return null;
    result.push(rings);
  }
  return result;
}

const text = (value, max = 80) =>
  typeof value === 'string' &&
  value.trim() &&
  value.length <= max &&
  !/[\u0000-\u001f<>]/.test(value)
    ? value.trim()
    : null;

/** An ISO time with offset as epoch ms, or null. */
function time(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {object} geojson The map service's `f=geojson` answer.
 * @param {number} [nowMs] Alerts that have already ended are dropped.
 * @returns {object[]|null}
 */
export function normalizeWeatherAlertSnapshot(geojson, nowMs = Date.now()) {
  if (!Array.isArray(geojson?.features)) return null;
  const byId = new Map();
  for (const feature of geojson.features) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const id = text(p.cap_id, 160);
    const event = text(p.prod_type, 60);
    const significance = ALERT_SIGNIFICANCE[p.sig] ?? null;
    if (!id || !event || !significance) continue;
    const polygons = polygonsOf(feature.geometry);
    if (!polygons?.length) continue;
    let row = byId.get(id);
    if (!row) {
      if (byId.size >= MAX_ALERTS) continue;
      const endsMs = time(p.ends) ?? time(p.expiration);
      if (endsMs !== null && endsMs < nowMs) continue;
      row = {
        stableId: id,
        event,
        significance,
        phenomenon: text(p.phenom, 4),
        office: text(p.wfo, 4),
        issuedMs: time(p.issuance),
        onsetMs: time(p.onset),
        endsMs,
        polygons: [],
      };
      byId.set(id, row);
    }
    for (const rings of polygons)
      if (row.polygons.length < MAX_POLYGONS_PER_ALERT)
        row.polygons.push(rings);
  }
  return [...byId.values()];
}
