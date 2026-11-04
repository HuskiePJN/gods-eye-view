/**
 * Saved places: camera views the operator named, kept only in this browser.
 * The location tray lists them, and a search, voice or typed command that
 * names one exactly ("Home", "fly to Fenway") lands on it before any
 * network geocoder is asked.
 */

const STORAGE_KEY = 'gev.savedPlaces.v1';
const MAX_PLACES = 24;
const MAX_NAME = 40;

/** Fold a name for exact comparison: case, spacing, punctuation. */
function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const finite = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;

function validPlace(place) {
  return (
    place &&
    typeof place.id === 'string' &&
    typeof place.name === 'string' &&
    place.name.trim() &&
    place.name.length <= MAX_NAME &&
    finite(place.lat, -90, 90) &&
    finite(place.lon, -180, 180) &&
    finite(place.height, 1, 5e7) &&
    finite(place.heading, -10, 10) &&
    finite(place.pitch, -10, 10)
  );
}

/**
 * @param {{storage?: Storage|null}} [options]
 */
export function createSavedPlaces({ storage } = {}) {
  const store = () => {
    try {
      return storage === undefined ? globalThis.localStorage : storage;
    } catch {
      return null;
    }
  };
  const listeners = new Set();
  let places = [];
  try {
    const saved = JSON.parse(store()?.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved))
      places = saved.filter(validPlace).slice(0, MAX_PLACES);
  } catch {
    places = [];
  }

  const persist = () => {
    try {
      store()?.setItem(STORAGE_KEY, JSON.stringify(places));
    } catch {
      /* Storage is optional; the places last this session. */
    }
    for (const listener of [...listeners]) listener(places);
  };

  return {
    /** The saved places, oldest first. */
    list: () => places,
    /** The place an exact name means, or null. */
    find(name) {
      const wanted = normalizeName(name);
      return wanted
        ? (places.find((place) => normalizeName(place.name) === wanted) ?? null)
        : null;
    },
    /**
     * Save a view under a name; a name already saved is replaced.
     * @returns {object|null} the saved place, or null when it is invalid.
     */
    save({ name, lat, lon, height, heading, pitch }) {
      const place = {
        id: `place-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: String(name ?? '')
          .trim()
          .slice(0, MAX_NAME),
        lat,
        lon,
        height,
        heading,
        pitch,
      };
      if (!validPlace(place)) return null;
      const wanted = normalizeName(place.name);
      places = [
        ...places.filter((other) => normalizeName(other.name) !== wanted),
        place,
      ].slice(-MAX_PLACES);
      persist();
      return place;
    },
    remove(id) {
      const next = places.filter((place) => place.id !== id);
      if (next.length === places.length) return false;
      places = next;
      persist();
      return true;
    },
    /** @returns {() => void} Removes the listener. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The application's saved places, shared by the tray and place search. */
export const savedPlaces = createSavedPlaces();

/** A geocoder that answers only the exact names of saved places. */
export function createSavedPlaceGeocoder({ places = savedPlaces } = {}) {
  return {
    async geocode(query, { signal } = {}) {
      signal?.throwIfAborted();
      const saved = places.find(query);
      if (!saved) return { place: null, answered: true };
      // A view's height frames about as much ground as a box this wide.
      const half = Math.min(20, Math.max(0.002, saved.height / 222_000));
      return {
        answered: true,
        place: {
          lat: saved.lat,
          lng: saved.lon,
          name: saved.name,
          label: saved.name,
          types: ['saved_place'],
          exact: true,
          viewport: {
            southwest: {
              lat: Math.max(-90, saved.lat - half),
              lng: Math.max(-180, saved.lon - half),
            },
            northeast: {
              lat: Math.min(90, saved.lat + half),
              lng: Math.min(180, saved.lon + half),
            },
          },
        },
      };
    },
  };
}
