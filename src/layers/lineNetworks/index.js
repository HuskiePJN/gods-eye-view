import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  LINE_NETWORK_LAYERS,
  LINE_NETWORK_MAX_PAGES,
  LINE_NETWORK_PAGE_SIZE,
  lineNetworkQueryBox,
  lineNetworkQueryUrl,
  normalizeLineNetwork,
} from './descriptors.js';
export * from './descriptors.js';

const DEBOUNCE_MS = 800;

/** Read one layer's lines for a box, following up to three result pages. */
export function createFeatureServiceLineSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async fetch(layer, box, { signal } = {}) {
      const lines = [];
      for (let page = 0; page < LINE_NETWORK_MAX_PAGES; page++) {
        const response = await fetchImpl(
          lineNetworkQueryUrl(layer, box, page),
          {
            signal,
            headers: { Accept: 'application/geo+json, application/json' },
          },
        );
        if (!response.ok)
          throw new Error(`${layer.source} HTTP ${response.status}`);
        const payload = await readResponseJsonCapped(
          response,
          16 * 1024 * 1024,
          signal,
        );
        const next = normalizeLineNetwork(layer, payload);
        if (!next) throw new Error(msg('Line network response was incomplete'));
        lines.push(...next);
        const more =
          payload.exceededTransferLimit === true ||
          payload.properties?.exceededTransferLimit === true;
        if (!more || payload.features.length < LINE_NETWORK_PAGE_SIZE) break;
      }
      return lines;
    },
  };
}

/**
 * One US line-network layer (railways or the power grid). It loads the lines
 * of the city-sized view when the camera stops and draws them as one
 * ground-clamped batch; wider views draw nothing and the row says to zoom in.
 */
export function createLineNetworkLayer(
  descriptor,
  { source = createFeatureServiceLineSource() } = {},
) {
  if (!LINE_NETWORK_LAYERS.includes(descriptor))
    throw new TypeError(`Unknown line network layer: ${descriptor?.id}`);
  const classById = new Map(
    descriptor.classes.map((entry) => [entry.id, entry]),
  );
  let viewer = null;
  let enabled = false;
  let primitive = null;
  let lines = [];
  let boxKey = null;
  let request = null;
  let timer = null;
  let removeMoveEnd = null;
  let tooWide = false;
  let lastError = null;
  let lastUpdate = null;
  let listener = null;

  const notify = () => listener?.();

  function clearDrawing() {
    if (primitive && viewer && !viewer.isDestroyed?.())
      viewer.scene.groundPrimitives.remove(primitive);
    primitive = null;
  }

  function draw() {
    clearDrawing();
    if (!lines.length || !viewer) return;
    const instances = lines.map(
      (line) =>
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArray(line.points.flat()),
            width: classById.get(line.class)?.width ?? 2,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString(
                classById.get(line.class)?.color ?? '#ffffff',
              ).withAlpha(0.9),
            ),
          },
        }),
    );
    primitive = viewer.scene.groundPrimitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance(),
        // Built on this thread: the app renders on demand, and a primitive
        // built in the background would otherwise wait for the next camera
        // move to appear. City-scale batches build in a few milliseconds.
        asynchronous: false,
      }),
    );
    viewer.scene.requestRender?.();
  }

  function viewRect() {
    const rectangle = viewer?.camera?.computeViewRectangle?.();
    if (!rectangle) return null;
    const toDeg = Cesium.Math.toDegrees;
    return {
      west: toDeg(rectangle.west),
      south: toDeg(rectangle.south),
      east: toDeg(rectangle.east),
      north: toDeg(rectangle.north),
    };
  }

  async function refresh() {
    timer = null;
    if (!enabled || !viewer) return;
    const box = lineNetworkQueryBox(viewRect());
    tooWide = !box;
    if (!box) {
      request?.abort();
      request = null;
      boxKey = null;
      lines = [];
      clearDrawing();
      notify();
      return;
    }
    const key = `${box.south},${box.west},${box.north},${box.east}`;
    if (key === boxKey) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const next = await source.fetch(descriptor, box, {
        signal: controller.signal,
      });
      // Synchronous ground polylines need the terrain height table first.
      await Cesium.GroundPolylinePrimitive.initializeTerrainHeights();
      if (controller.signal.aborted || !enabled) return;
      lines = next;
      boxKey = key;
      lastError = null;
      lastUpdate = Date.now();
      draw();
    } catch (error) {
      if (controller.signal.aborted || !enabled) return;
      lastError = error?.message || msg('Line network unavailable');
    } finally {
      if (request === controller) request = null;
      notify();
    }
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, DEBOUNCE_MS);
  };

  const layer = {
    id: descriptor.id,
    name: descriptor.name,
    icon: descriptor.icon,
    source: descriptor.source,
    updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
    },
    enable() {
      enabled = true;
      removeMoveEnd?.();
      removeMoveEnd =
        viewer?.camera?.moveEnd?.addEventListener?.(schedule) ?? null;
      schedule();
    },
    disable() {
      enabled = false;
      clearTimeout(timer);
      timer = null;
      request?.abort();
      request = null;
      removeMoveEnd?.();
      removeMoveEnd = null;
      boxKey = null;
      lines = [];
      clearDrawing();
      notify();
    },
    update() {
      return true;
    },
    getRowControls() {
      return {
        chips: [],
        legend: descriptor.classes.map((entry, index) => ({
          label: t(entry.label),
          color: entry.color,
          count: lines.filter((line) => line.class === entry.id).length,
          ...(index === 0
            ? {
                blurb: tooWide
                  ? t('Zoom in to about city scale to load lines.')
                  : t('United States only, from federal open data.'),
              }
            : {}),
        })),
      };
    },
    setRowControlsListener(next) {
      listener = typeof next === 'function' ? next : null;
    },
    getStats() {
      return { count: lines.length, lastUpdate, error: lastError };
    },
    destroy() {
      layer.disable();
      listener = null;
      viewer = null;
    },
  };
  return layer;
}

/** One layer per descriptor, in panel order. */
export function createLineNetworkLayers(options) {
  return LINE_NETWORK_LAYERS.map((descriptor) =>
    createLineNetworkLayer(descriptor, options),
  );
}
