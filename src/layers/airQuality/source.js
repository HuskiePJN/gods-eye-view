import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  airQualitySeverity,
  normalizeAqhiStations,
  normalizeAqhiObservations,
  normalizeOpenMeteoAirQuality,
} from './model.js';
import { AIR_QUALITY_WORLD_POINTS } from './worldPoints.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel and the Weather card show them translated.
const msg = (text) => text;

const COLLECTIONS_ROOT = 'https://api.weather.gc.ca/collections';
const STATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-stations/items`;
const OBSERVATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-observations-realtime/items`;

/** Comfortably above Canada's ~134 stations without inviting a huge page. */
const STATION_LIMIT = 500;
const OBSERVATION_LIMIT = 500;
/** Station geometry is near-static — a few changes a year. Refetch twice a day. */
const STATION_TTL_MS = 12 * 60 * 60 * 1000;
/** A full 500-row GeoJSON page is a few hundred KB; anything past this is not a page. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Request and validate a complete ECCC AQHI snapshot before it can replace
 * displayed readings. The first registered air-quality provider.
 *
 * Two collections are involved. `aqhi-stations` is the catalog — it supplies
 * every reading its coordinates and is cached for twelve hours because it
 * barely changes. `aqhi-observations-realtime` is the hourly reading feed,
 * requested with `latest=true` so the response is current values rather than
 * the full observation history, which is roughly 2,000 rows nationally.
 *
 * The station catalog is only replaced when a refresh actually returns
 * stations, so a transient empty response cannot blank the layer.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for each request.
 * @returns {{getSnapshot: Function}}
 */
export function createEcccAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  /** @type {Map<string, object>} */
  let stations = new Map();
  let stationsFetchedAt = 0;

  /** One bounded GeoJSON page: deadline, caller abort, byte cap, row cap. */
  const getJson = async (url, limit, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(msg('ECCC request timed out'))),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ECCC HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        controller.signal,
      );
      // The server's `limit` is a request, not a guarantee.
      if (Array.isArray(payload?.features) && payload.features.length > limit)
        return { ...payload, features: payload.features.slice(0, limit) };
      return payload;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };

  return {
    async getSnapshot({ signal } = {}) {
      const clock = now();
      if (stations.size === 0 || clock - stationsFetchedAt > STATION_TTL_MS) {
        const payload = await getJson(
          `${STATIONS_URL}?f=json&limit=${STATION_LIMIT}`,
          STATION_LIMIT,
          signal,
        );
        const next = normalizeAqhiStations(payload);
        if (!next) throw new Error(msg('Malformed AQHI station response'));
        // An empty refresh must not wipe a good catalog.
        if (next.size > 0) {
          stations = next;
          stationsFetchedAt = clock;
        }
      }
      if (stations.size === 0)
        throw new Error(msg('No AQHI stations available'));

      const payload = await getJson(
        `${OBSERVATIONS_URL}?f=json&latest=true&limit=${OBSERVATION_LIMIT}`,
        OBSERVATION_LIMIT,
        signal,
      );
      const readings = normalizeAqhiObservations(payload, stations, clock);
      if (!readings)
        throw new Error(msg('Malformed AQHI observation response'));
      return readings;
    },
  };
}

const OPEN_METEO_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
/** The model updates hourly; asking more often only spends the free quota. */
const OPEN_METEO_TTL_MS = 60 * 60 * 1000;
const OPEN_METEO_BATCH = 100;

/**
 * Open-Meteo's modelled US AQI at the bundled sample cities, keyless and free
 * for non-commercial use (CC BY 4.0, "Weather data by Open-Meteo.com"). One
 * multi-location request per hundred points, kept for an hour.
 */
export function createOpenMeteoAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  points = AIR_QUALITY_WORLD_POINTS,
  timeoutMs = 20_000,
} = {}) {
  let cached = null;
  let fetchedAt = 0;
  return {
    async getSnapshot({ signal } = {}) {
      const clock = now();
      if (cached && clock - fetchedAt < OPEN_METEO_TTL_MS) return cached;
      const readings = [];
      for (let start = 0; start < points.length; start += OPEN_METEO_BATCH) {
        const batch = points.slice(start, start + OPEN_METEO_BATCH);
        const params = new URLSearchParams({
          latitude: batch.map(([, lat]) => lat).join(','),
          longitude: batch.map(([, , lon]) => lon).join(','),
          current: 'us_aqi,pm2_5',
          timezone: 'GMT',
        });
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(`${OPEN_METEO_URL}?${params}`, {
          headers: { Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
        const payload = await readResponseJsonCapped(
          response,
          MAX_RESPONSE_BYTES,
          signal,
        );
        const rows = normalizeOpenMeteoAirQuality(payload, batch, clock, start);
        if (!rows)
          throw new Error(msg('Malformed Open-Meteo air-quality response'));
        readings.push(...rows);
      }
      cached = readings;
      fetchedAt = clock;
      return readings;
    },
  };
}

/** How long a provider's last good readings stand in for a failed refresh. */
const PROVIDER_RETAIN_MS = 2 * 60 * 60 * 1000;
/** How long a failed provider is left alone before it is asked again. */
const PROVIDER_BACKOFF_MS = 10 * 60 * 1000;

/**
 * Every registered provider's readings in one snapshot, worst first. A
 * provider that fails keeps showing its last good readings (for up to two
 * hours) and is not asked again for ten minutes, so one failed poll does not
 * blank half the map; only when no provider has anything does the snapshot
 * fail.
 */
export function createAirQualitySource({
  sources = [createEcccAirQualitySource(), createOpenMeteoAirQualitySource()],
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const memory = sources.map(() => ({ rows: null, at: 0, failedAt: 0 }));
  return {
    async getSnapshot(options = {}) {
      const clock = now();
      const results = await Promise.allSettled(
        sources.map((source, index) =>
          memory[index].failedAt &&
          clock - memory[index].failedAt < PROVIDER_BACKOFF_MS
            ? Promise.reject(new Error('backing off'))
            : source.getSnapshot(options),
        ),
      );
      options.signal?.throwIfAborted();
      const readings = [];
      let firstError = null;
      results.forEach((result, index) => {
        const slot = memory[index];
        if (result.status === 'fulfilled') {
          slot.rows = result.value;
          slot.at = clock;
          slot.failedAt = 0;
          readings.push(...result.value);
          return;
        }
        if (result.reason?.message !== 'backing off') {
          slot.failedAt = clock;
          warn('[Data:AirQuality] provider refresh failed:', result.reason);
        }
        firstError ??= result.reason;
        if (slot.rows && clock - slot.at <= PROVIDER_RETAIN_MS)
          readings.push(...slot.rows);
      });
      if (!readings.length && results.every((r) => r.status === 'rejected'))
        throw firstError;
      return readings.sort(
        (a, b) =>
          airQualitySeverity(b) - airQualitySeverity(a) ||
          a.id.localeCompare(b.id),
      );
    },
  };
}
