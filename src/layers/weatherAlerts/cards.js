/** Card model for one selected NWS alert. Pure — no Cesium types. */
import { formatDate, t } from '../../i18n/index.js';

export const ALERT_OVERLAY_SOURCE_ID = 'weather-alerts';

/** Fill colour and draw order by significance: warnings on top. */
export const SIGNIFICANCE_STYLE = Object.freeze({
  warning: { color: '#ff3b30', zIndex: 3 },
  watch: { color: '#ff9500', zIndex: 2 },
  advisory: { color: '#ffd60a', zIndex: 1 },
  statement: { color: '#64d2ff', zIndex: 0 },
});

/** The significance label in the UI language. */
export function significanceLabel(significance) {
  switch (significance) {
    case 'warning':
      return t('Warning', { context: 'weather alert' });
    case 'watch':
      return t('Watch', { context: 'weather alert' });
    case 'advisory':
      return t('Advisory', { context: 'weather alert' });
    default:
      return t('Statement', { context: 'weather alert' });
  }
}

/**
 * Card anchor: the vertex mean (circular in longitude) of the outer ring with
 * the most vertices, which for zone and storm polygons sits inside or near it.
 * @returns {{lon: number, lat: number}}
 */
export function alertAnchorDegrees(polygons) {
  let best = polygons[0][0];
  for (const rings of polygons)
    if (rings[0].length > best.length) best = rings[0];
  const toRad = Math.PI / 180;
  let sinLon = 0;
  let cosLon = 0;
  let lat = 0;
  const count = best.length - 1;
  for (let i = 0; i < count; i++) {
    sinLon += Math.sin(best[i][0] * toRad);
    cosLon += Math.cos(best[i][0] * toRad);
    lat += best[i][1];
  }
  return { lon: Math.atan2(sinLon, cosLon) / toRad, lat: lat / count };
}

const when = (ms) =>
  formatDate(ms, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

/**
 * Build the overlay-host entry for one selected alert. The caller supplies
 * `position` separately, so this model stays JSON-safe for tests.
 */
export function buildAlertCard(row, nowMs) {
  const details = [significanceLabel(row.significance)];
  if (Number.isFinite(row.onsetMs) && row.onsetMs > nowMs)
    details.push(t('From {time}', { time: when(row.onsetMs) }));
  if (Number.isFinite(row.endsMs))
    details.push(t('Until {time}', { time: when(row.endsMs) }));
  if (row.office)
    details.push(t('Issued by NWS {office}', { office: row.office }));
  return {
    id: `weather-alert-card:${row.stableId}`,
    selected: true,
    interactive: false,
    title: row.event.toUpperCase(),
    details,
    accent: SIGNIFICANCE_STYLE[row.significance]?.color ?? '#64d2ff',
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
