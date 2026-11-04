import { normalizeWeatherAlertSnapshot } from '../../src/layers/weatherAlerts/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// NWS active watches, warnings and advisories with their zone or storm
// polygons (public domain, keyless). maxAllowableOffset trades ~1 km of
// boundary detail for a payload of about 1.5 MB on a typical day.
const API_URL =
  'https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/' +
  'watch_warn_adv/MapServer/1/query?' +
  new URLSearchParams({
    where: '1=1',
    outFields: [
      'cap_id',
      'prod_type',
      'sig',
      'phenom',
      'wfo',
      'issuance',
      'onset',
      'ends',
      'expiration',
    ].join(','),
    maxAllowableOffset: '0.01',
    outSR: '4326',
    f: 'geojson',
  }).toString();

const MAX_PAGES = 5;
const MIB = 1024 * 1024;
const CACHE_MS = 120_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 2 * 60 * 60 * 1000;

const exceededTransferLimit = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

/** Fixed-origin, bounded NWS alert route for dev and preview. */
export function weatherAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function fetchAlerts() {
    const features = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        page === 0 ? API_URL : `${API_URL}&resultOffset=${features.length}`;
      const signal = AbortSignal.timeout(30_000);
      const response = await fetchImpl(url, {
        signal,
        redirect: 'error',
        headers: { 'User-Agent': 'gods-eye-view-weather-alerts/1.0' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('upstream_unavailable');
      }
      const payload = await readResponseJsonCapped(response, 24 * MIB, signal);
      if (!Array.isArray(payload?.features))
        throw new Error('invalid_snapshot');
      features.push(...payload.features);
      if (!exceededTransferLimit(payload) || !payload.features.length) break;
    }
    const rows = normalizeWeatherAlertSnapshot({ features }, now());
    return { fetchedAt: now(), rows };
  }

  async function acquire() {
    if (cached && now() - cached.savedAt < CACHE_MS)
      return { value: cached.value, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'alerts', async () => {
        const value = await fetchAlerts();
        cached = { value, savedAt: now() };
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return { value: cached.value, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch {
      json(502, { error: 'weather_alerts_unavailable' });
    }
  }

  return {
    name: 'weather-alerts',
    configureServer({ middlewares }) {
      middlewares.use('/api/weather-alerts', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/weather-alerts', handler);
    },
  };
}
