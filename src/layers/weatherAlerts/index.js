import * as Cesium from 'cesium';
import {
  ALERT_OVERLAY_SOURCE_ID,
  SIGNIFICANCE_STYLE,
  alertAnchorDegrees,
  buildAlertCard,
  significanceLabel,
} from './cards.js';
import { msg, t } from '../../i18n/index.js';
export { normalizeWeatherAlertSnapshot } from './records.js';
export { createNwsAlertSource } from './source.js';
export * from './cards.js';

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

const PICK_PREFIX = 'weather-alert:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const SIGNIFICANCES = ['warning', 'watch', 'advisory', 'statement'];

/** Own one NWS alert display, its refresh lifecycle, and click selection. */
export function createWeatherAlertsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Weather alerts require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _snapshotSignature = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _stale = false;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  /** @type {Map<string, object>} geometry-free rows with their card anchor */
  const _rowById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(ALERT_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = {
      ...buildAlertCard(row, Date.now()),
      position: Cesium.Cartesian3.fromDegrees(row.anchor.lon, row.anchor.lat),
    };
    overlayHost.setEntries(ALERT_OVERLAY_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  /** The strongest alert under a click: overlapping zones pick the warning. */
  function pickedAlertId(position) {
    let best = null;
    for (const picked of _viewer.scene.drillPick(position, 16)) {
      const pickId = picking.resolvePickId(picked);
      if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
        continue;
      const id = pickId.slice(PICK_PREFIX.length).replace(/:\d+$/, '');
      const row = _rowById.get(id);
      if (!row) continue;
      const rank = SIGNIFICANCES.indexOf(row.significance);
      if (!best || rank < best.rank) best = { id, rank };
    }
    return best?.id ?? null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Not registered in the pick-ownership registry, like fire perimeters:
    // claiming large ground polygons would make sibling cards inert.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = _viewer.scene.pick(click.position);
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      const alertId = picked ? pickedAlertId(click.position) : null;
      if (alertId || _selectedId) {
        _selectedId = alertId;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  function clearSelection() {
    _selectedId = null;
    if (overlayHost) {
      overlayHost.clearSource(ALERT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(ALERT_OVERLAY_SOURCE_ID, false);
    }
  }

  const layer = {
    id: 'weather-alerts',
    name: 'Weather Alerts',
    icon: '⚠️',
    source: 'NWS',
    updateInterval: 120000,

    init(viewer) {
      if (_viewer)
        throw new Error('Weather alert layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('weather-alerts');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _enabled = false;
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(ALERT_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot =
          typeof source.getSnapshotDetail === 'function'
            ? await source.getSnapshotDetail({ signal: request.signal })
            : { rows: await source.getSnapshot({ signal: request.signal }) };
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const { rows } = snapshot;
        _stale = snapshot.stale === true;
        const updatedAt =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : Date.now();
        const signature = rows
          .map((row) => `${row.stableId}:${row.polygons.length}`)
          .sort()
          .join('|');
        if (signature === _snapshotSignature) {
          if (_selectedId) publishSelectedCard();
          _lastUpdate = updatedAt;
          _lastError = null;
          return true;
        }
        const nextEntities = [];
        _rowById.clear();
        for (const row of rows) {
          const style =
            SIGNIFICANCE_STYLE[row.significance] ??
            SIGNIFICANCE_STYLE.statement;
          const color = Cesium.Color.fromCssColorString(style.color);
          for (const [index, rings] of row.polygons.entries()) {
            const [outer, ...holes] = rings;
            nextEntities.push(
              new Cesium.Entity({
                id: `${PICK_PREFIX}${row.stableId}:${index}`,
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(
                    ringPositions(outer),
                    holes.map(
                      (hole) =>
                        new Cesium.PolygonHierarchy(ringPositions(hole)),
                    ),
                  ),
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(
                      row.significance === 'warning' ? 0.35 : 0.22,
                    ),
                  ),
                  zIndex: style.zIndex,
                },
              }),
            );
          }
          const { polygons, ...facts } = row;
          _rowById.set(row.stableId, {
            ...facts,
            anchor: alertAnchorDegrees(polygons),
          });
        }
        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _snapshotSignature = signature;
        if (_selectedId) publishSelectedCard();
        _count = rows.length;
        _lastUpdate = updatedAt;
        _lastError = null;
        console.log(
          `[Data:WeatherAlerts] Updated: ${_count} alerts, ${nextEntities.length} areas`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:WeatherAlerts] Fetch error:', e);
        _lastError = e?.message || msg('Weather alert source unavailable');
        _stale = false;
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _snapshotSignature = null;
      _viewer = null;
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    /** Alert facts (with card-anchor coordinates) for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rowById.values()) {
        if (result.length >= limit) break;
        const { anchor, stableId, ...facts } = row;
        result.push({
          id: stableId,
          ...facts,
          lat: anchor.lat,
          lon: anchor.lon,
        });
      }
      return result;
    },

    getRowControls() {
      return {
        chips: [],
        legend: SIGNIFICANCES.map((significance, index) => ({
          label: significanceLabel(significance),
          color: SIGNIFICANCE_STYLE[significance].color,
          count: [..._rowById.values()].filter(
            (row) => row.significance === significance,
          ).length,
          ...(index === 0
            ? {
                blurb: t(
                  'Active US National Weather Service alerts. Click an area for details.',
                ),
              }
            : {}),
        })),
      };
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
