import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request a normalized alert snapshot through the same-origin NWS proxy. */
export function createNwsAlertSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /**
   * The rows with how fresh they are: the proxy answers from its last
   * snapshot, marked stale, while NWS is unreachable.
   * @returns {Promise<{rows: object[], stale: boolean, fetchedAt: number|null}>}
   */
  async function getSnapshotDetail({ signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl('/api/weather-alerts', { signal });
    if (!response.ok) throw new Error(`NWS alerts HTTP ${response.status}`);
    const payload = await readResponseJsonCapped(
      response,
      40 * 1024 * 1024,
      signal,
    );
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.rows))
      throw new Error(msg('Malformed weather alert snapshot'));
    return {
      rows: payload.rows,
      stale: payload.stale === true,
      fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
    };
  }

  return {
    async getSnapshot(options = {}) {
      return (await getSnapshotDetail(options)).rows;
    },
    getSnapshotDetail,
  };
}
