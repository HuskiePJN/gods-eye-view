import * as Cesium from 'cesium';
import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { NO_IMAGERY_HOST, resolveImageryHost } from '../../maps/imageryHost.js';
import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  AURORA_BANDS,
  GRID_HEIGHT,
  GRID_WIDTH,
  KP_URL,
  OVATION_URL,
  auroraPixels,
  latestKp,
  normalizeOvation,
  stormLevel,
} from './records.js';
export * from './records.js';

/** The drape is painted at four pixels per degree. */
const SCALE = 4;

/** The OVATION grid and the latest Kp, straight from SWPC (CORS-open). */
export function createSwpcSpaceWeatherSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const getJson = async (url, signal, cap) => {
    const response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`SWPC HTTP ${response.status}`);
    return readResponseJsonCapped(response, cap, signal);
  };
  return {
    async getSnapshot({ signal } = {}) {
      const [ovation, kp] = await Promise.allSettled([
        getJson(OVATION_URL, signal, 8 * 1024 * 1024),
        getJson(KP_URL, signal, 1024 * 1024),
      ]);
      if (ovation.status === 'rejected') throw ovation.reason;
      const grid = normalizeOvation(ovation.value);
      if (!grid) throw new Error(msg('Malformed aurora forecast'));
      return {
        ...grid,
        kp: kp.status === 'fulfilled' ? latestKp(kp.value) : null,
      };
    },
  };
}

/**
 * The aurora forecast draped on the map surface: NOAA's OVATION chance of
 * visible aurora for the next half hour, with the planetary Kp index in the
 * row. One small image, repainted each refresh.
 */
export function createAuroraLayer({
  source = createSwpcSpaceWeatherSource(),
  host = resolveImageryHost,
  document: doc = globalThis.document,
} = {}) {
  let viewer = null;
  let mapStack = null;
  let unsubscribeMap = null;
  let enabled = false;
  let request = null;
  let snapshot = null;
  let imagery = null;
  let hostKind = 'none';
  let lastUpdate = null;
  let lastError = null;
  let listener = null;
  const notify = () => listener?.();

  function removeImagery() {
    if (imagery?.collection && !imagery.collection.isDestroyed?.())
      imagery.collection.remove(imagery.layer, true);
    imagery = null;
  }

  function paint() {
    removeImagery();
    if (!enabled || !viewer || !snapshot || !doc) return;
    const target = host({
      viewer,
      tileset: mapStack?.getImageryHostTileset?.(),
    }) || { collection: null, kind: 'none' };
    hostKind = target.kind;
    if (!target.collection) return;
    // Paint the 1° grid, then scale it up with smoothing so the oval's edge
    // is a gradient rather than one-degree steps.
    const grid = doc.createElement('canvas');
    grid.width = GRID_WIDTH;
    grid.height = GRID_HEIGHT;
    grid
      .getContext('2d')
      .putImageData(
        new ImageData(
          auroraPixels(snapshot.probabilities),
          GRID_WIDTH,
          GRID_HEIGHT,
        ),
        0,
        0,
      );
    const canvas = doc.createElement('canvas');
    canvas.width = GRID_WIDTH * SCALE;
    canvas.height = GRID_HEIGHT * SCALE;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(grid, 0, 0, canvas.width, canvas.height);
    const drape = new Cesium.ImageryLayer(
      new Cesium.SingleTileImageryProvider({
        url: canvas.toDataURL('image/png'),
        tileWidth: canvas.width,
        tileHeight: canvas.height,
        rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
        credit: 'Aurora forecast: NOAA SWPC OVATION',
      }),
    );
    target.collection.add(drape);
    imagery = { layer: drape, collection: target.collection };
    viewer.scene?.requestRender?.();
  }

  const layer = {
    id: 'aurora',
    name: 'Aurora',
    icon: '🌌',
    source: 'NOAA SWPC',
    updateInterval: 600000,
    init(nextViewer) {
      viewer = nextViewer;
    },
    /** Follow map-stack switches so the drape moves with the surface. */
    attachMapStackController(controller) {
      unsubscribeMap?.();
      mapStack = controller || null;
      const off = controller?.subscribe?.(() => {
        if (enabled) paint();
      });
      unsubscribeMap = typeof off === 'function' ? off : null;
    },
    enable() {
      enabled = true;
      paint();
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      removeImagery();
      notify();
    },
    async update() {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const next = await source.getSnapshot({ signal: controller.signal });
        if (controller.signal.aborted || !enabled) return false;
        snapshot = next;
        lastUpdate = Date.now();
        lastError = null;
        paint();
        return true;
      } catch (error) {
        if (controller.signal.aborted || !enabled) return false;
        lastError = error?.message || msg('Aurora forecast unavailable');
        return false;
      } finally {
        if (request === controller) request = null;
        notify();
      }
    },
    getRowControls() {
      const kp = snapshot?.kp?.kp;
      const storm = stormLevel(kp);
      const lines = [];
      if (Number.isFinite(kp))
        lines.push(
          storm
            ? t('Kp {kp} · {level} geomagnetic storm', {
                kp: formatNumber(kp, { maximumFractionDigits: 1 }),
                level: storm,
              })
            : t('Kp {kp} · no geomagnetic storm', {
                kp: formatNumber(kp, { maximumFractionDigits: 1 }),
              }),
        );
      if (snapshot)
        lines.push(t('Peak chance {percent}%', { percent: snapshot.max }));
      if (Number.isFinite(snapshot?.forecastMs))
        lines.push(
          t('Forecast for {time}', {
            time: formatDate(snapshot.forecastMs, {
              hour: 'numeric',
              minute: '2-digit',
              timeZoneName: 'short',
            }),
          }),
        );
      return {
        chips: [],
        legend: AURORA_BANDS.map((band, index) => ({
          label: t(band.label),
          color: `rgb(${band.color.join(',')})`,
          ...(index === 0 && lines.length ? { blurb: lines.join(' · ') } : {}),
        })),
      };
    },
    setRowControlsListener(next) {
      listener = typeof next === 'function' ? next : null;
    },
    getStats() {
      return {
        count: enabled && snapshot ? 1 : 0,
        lastUpdate,
        error:
          lastError ??
          (enabled && snapshot && hostKind === 'none' ? NO_IMAGERY_HOST : null),
      };
    },
    destroy() {
      layer.disable();
      unsubscribeMap?.();
      unsubscribeMap = null;
      mapStack = null;
      listener = null;
      viewer = null;
      snapshot = null;
    },
  };
  return layer;
}
