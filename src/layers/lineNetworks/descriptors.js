/**
 * US line networks from federal open data: the rail network (BTS/FRA
 * National Transportation Atlas Database) and electric transmission lines
 * (HIFLD). Both are public-domain ArcGIS feature services queried keyless for
 * the city-sized view. Rail uses blues and purples, power reds to yellows, so
 * the two never share a colour. Pure data and helpers — no Cesium.
 */
// A portable export: no i18n here. Labels stay English data; the layer
// translates them when shown.
const msg = (text) => text;

/** Larger views are not queried: they would be region-scale. */
export const LINE_NETWORK_MAX_VIEW_DEGREES = 2;
/** Views are snapped outwards so small pans reuse one request. */
export const LINE_NETWORK_SNAP_DEGREES = 0.25;
/** The services return at most 2,000 features a page; a view reads three. */
export const LINE_NETWORK_PAGE_SIZE = 2000;
export const LINE_NETWORK_MAX_PAGES = 3;

const PASSENGER = { A: 'Amtrak', C: 'Commuter', B: 'Amtrak and commuter' };

export const LINE_NETWORK_LAYERS = Object.freeze([
  Object.freeze({
    id: 'railways',
    name: 'Railways',
    icon: '🚆',
    source: 'BTS NTAD',
    url: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NTAD_North_American_Rail_Network_Lines/FeatureServer/0/query',
    // Abandoned (A) and out-of-service (X) track is left out.
    where: "NET NOT IN ('A','X')",
    outFields: 'FRAARCID,NET,PASSNGR,RROWNER1,SUBDIV,TRACKS',
    classes: Object.freeze([
      {
        id: 'passenger',
        label: msg('Passenger service'),
        color: '#3fa9ff',
        width: 3,
      },
      {
        id: 'main',
        label: msg('Main line (freight)'),
        color: '#b388ff',
        width: 2.5,
      },
      {
        id: 'other',
        label: msg('Yards, sidings and spurs'),
        color: '#d1c4e9',
        width: 1.5,
      },
    ]),
    classify(p) {
      if (PASSENGER[p.PASSNGR]) return 'passenger';
      return p.NET === 'M' ? 'main' : 'other';
    },
    describe(p) {
      return {
        id: `rail:${p.FRAARCID}`,
        owner: typeof p.RROWNER1 === 'string' ? p.RROWNER1 : null,
        passenger: PASSENGER[p.PASSNGR] ?? null,
        subdivision: typeof p.SUBDIV === 'string' ? p.SUBDIV : null,
        tracks: Number.isFinite(p.TRACKS) ? p.TRACKS : null,
      };
    },
  }),
  Object.freeze({
    id: 'power-grid',
    name: 'Power Grid',
    icon: '⚡',
    source: 'HIFLD',
    url: 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query',
    where: '1=1',
    outFields: 'ID,VOLTAGE,OWNER,STATUS,TYPE',
    classes: Object.freeze([
      {
        id: 'extra-high',
        label: msg('345 kV and above'),
        color: '#ff3b30',
        width: 3,
      },
      { id: 'high', label: msg('100–344 kV'), color: '#ff9500', width: 2.5 },
      {
        id: 'medium',
        label: msg('Under 100 kV'),
        color: '#ffe066',
        width: 1.5,
      },
      {
        id: 'unknown',
        label: msg('Voltage not reported'),
        color: '#b0bec5',
        width: 1.5,
      },
    ]),
    classify(p) {
      const kv = Number(p.VOLTAGE);
      if (!Number.isFinite(kv) || kv <= 0) return 'unknown';
      if (kv >= 345) return 'extra-high';
      return kv >= 100 ? 'high' : 'medium';
    },
    describe(p) {
      const kv = Number(p.VOLTAGE);
      return {
        id: `power:${p.ID}`,
        voltageKv: Number.isFinite(kv) && kv > 0 ? kv : null,
        owner: typeof p.OWNER === 'string' ? p.OWNER : null,
        type: typeof p.TYPE === 'string' ? p.TYPE : null,
      };
    },
  }),
]);

/** Snap a view outwards to the grid, or null when it is too large to query. */
export function lineNetworkQueryBox(rect) {
  if (!rect) return null;
  const { west, south, east, north } = rect;
  if (![west, south, east, north].every(Number.isFinite) || east <= west)
    return null;
  if (
    north - south > LINE_NETWORK_MAX_VIEW_DEGREES ||
    east - west > LINE_NETWORK_MAX_VIEW_DEGREES
  )
    return null;
  const step = LINE_NETWORK_SNAP_DEGREES;
  const round = (value) => Math.round(value * 1e6) / 1e6;
  return {
    south: round(Math.max(-90, Math.floor(south / step) * step)),
    west: round(Math.max(-180, Math.floor(west / step) * step)),
    north: round(Math.min(90, Math.ceil(north / step) * step)),
    east: round(Math.min(180, Math.ceil(east / step) * step)),
  };
}

/** The feature-service query URL for one layer, box and page. */
export function lineNetworkQueryUrl(
  layer,
  { south, west, north, east },
  page = 0,
) {
  const params = new URLSearchParams({
    where: layer.where,
    geometry: `${west},${south},${east},${north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: layer.outFields,
    outSR: '4326',
    // About 20 m of simplification: invisible at city scale, a much smaller page.
    maxAllowableOffset: '0.0002',
    resultRecordCount: String(LINE_NETWORK_PAGE_SIZE),
    resultOffset: String(page * LINE_NETWORK_PAGE_SIZE),
    f: 'geojson',
  });
  return `${layer.url}?${params}`;
}

const validPoint = (point) =>
  Array.isArray(point) &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]) &&
  Math.abs(point[0]) <= 180 &&
  Math.abs(point[1]) <= 90;

/**
 * GeoJSON line features into drawable lines (a MultiLineString becomes one
 * line per part). Invalid features are skipped; a payload that is not a
 * feature collection is null.
 */
export function normalizeLineNetwork(layer, payload) {
  if (!Array.isArray(payload?.features)) return null;
  const lines = [];
  for (const feature of payload.features) {
    const properties = feature?.properties;
    const geometry = feature?.geometry;
    if (!properties || typeof properties !== 'object') continue;
    const parts =
      geometry?.type === 'LineString'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    const facts = {
      class: layer.classify(properties),
      ...layer.describe(properties),
    };
    for (const part of Array.isArray(parts) ? parts : []) {
      const points = Array.isArray(part) ? part.filter(validPoint) : [];
      if (points.length >= 2)
        lines.push({
          ...facts,
          points: points.map(([lon, lat]) => [lon, lat]),
        });
    }
  }
  return lines;
}
