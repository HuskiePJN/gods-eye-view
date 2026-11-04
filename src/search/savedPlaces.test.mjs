import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedPlaceGeocoder, createSavedPlaces } from './savedPlaces.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
  };
}
const view = {
  lat: 42.3467,
  lon: -71.0972,
  height: 800,
  heading: 0.5,
  pitch: -0.6,
};

test('saved places persist, replace by name and remove', () => {
  const storage = memoryStorage();
  const places = createSavedPlaces({ storage });
  const seen = [];
  places.subscribe((list) => seen.push(list.length));
  const fenway = places.save({ name: 'Fenway', ...view });
  assert.equal(
    places.save({ name: ' fenway! ', ...view, height: 900 }).height,
    900,
  );
  assert.equal(places.list().length, 1);
  assert.equal(places.save({ name: '', ...view }), null);
  assert.equal(places.save({ name: 'Bad', ...view, lat: 95 }), null);
  assert.equal(createSavedPlaces({ storage }).list()[0].name, 'fenway!');
  assert.equal(places.find('FENWAY'), places.list()[0]);
  assert.equal(places.remove(fenway.id), false);
  assert.equal(places.remove(places.list()[0].id), true);
  assert.deepEqual(seen, [1, 1, 0]);
});

test('the geocoder answers only exact saved names', async () => {
  const places = createSavedPlaces({ storage: null });
  places.save({ name: 'Home', ...view });
  const geocoder = createSavedPlaceGeocoder({ places });
  const { place } = await geocoder.geocode('home');
  assert.equal(place.lat, view.lat);
  assert.ok(place.viewport.southwest.lat < view.lat);
  assert.equal((await geocoder.geocode('Homestead')).place, null);
});
