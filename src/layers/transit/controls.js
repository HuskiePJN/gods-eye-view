import { DISRUPTION_COLOR } from './network.js';
import { t } from '../../i18n/index.js';

/**
 * Manager wiring. Transit's data arrives from camera-driven proximity polls,
 * not only from the manager's own tick, so the layer keeps a handle it can use
 * to repaint its panel row the moment a snapshot lands.
 *
 * For feeds that publish route lines and alerts (MBTA), the row also carries
 * two toggles — bus lines, and closed/moved stop markers — and a legend for
 * what the magenta means. The toggles are ordinary layer params, so the
 * panel, voice and share-state paths all set them the same way.
 * @param {object} context
 * @returns {object}
 */
export function createControls({ state, parts }) {
  const methods = {
    /**
     * @param {object} dataManager DataLayerManager instance.
     */
    attachDataManager(dataManager) {
      state._dataManager = dataManager;
    },

    getParams() {
      return {
        busLines: state._showBusLines !== false,
        stopAlerts: state._showStopAlerts !== false,
      };
    },

    /**
     * @param {{busLines?: boolean, stopAlerts?: boolean}} params
     * @returns {boolean} false when nothing recognisable was asked for.
     */
    setParams(params = {}) {
      let recognised = false;
      if (typeof params.busLines === 'boolean') {
        state._showBusLines = params.busLines;
        recognised = true;
      }
      if (typeof params.stopAlerts === 'boolean') {
        state._showStopAlerts = params.stopAlerts;
        recognised = true;
      }
      if (!recognised) return false;
      parts.network.applyVisibility();
      state._notifyRowControls?.();
      state._dataManager?.refreshLayerStats?.();
      return true;
    },

    getRowControls() {
      if (!state._enabled || !parts.network.hasControls()) return null;
      const busLines = state._showBusLines !== false;
      const stopAlerts = state._showStopAlerts !== false;
      const { disrupted, stops } = parts.network.legendCounts();
      return {
        chips: [
          {
            id: 'transit-bus-lines',
            label: t('Bus lines'),
            active: busLines,
            params: { busLines: !busLines },
            title: busLines
              ? t('Hide bus route lines (trains stay drawn)')
              : t('Show bus route lines'),
          },
          {
            id: 'transit-stop-alerts',
            label: t('Stop alerts'),
            active: stopAlerts,
            params: { stopAlerts: !stopAlerts },
            title: stopAlerts
              ? t('Hide closed and moved stop markers')
              : t('Show closed and moved stop markers'),
          },
        ],
        legend: [
          {
            color: DISRUPTION_COLOR,
            label: t('Disrupted route'),
            count: disrupted,
            blurb: t(
              'Dashed: a delay, detour, suspension, shuttle, cancellation or service change is in force on the route',
            ),
          },
          ...(stopAlerts
            ? [
                {
                  color: DISRUPTION_COLOR,
                  label: t('Closed or moved stop'),
                  count: stops,
                  blurb: t('Ringed dot: click for the alert'),
                },
              ]
            : []),
        ],
      };
    },

    setRowControlsListener(listener) {
      state._notifyRowControls =
        typeof listener === 'function' ? listener : null;
    },
  };
  return { methods };
}
