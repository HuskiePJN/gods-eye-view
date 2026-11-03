- Add **MBTA route lines and service alerts** to the Transit layer
  (keyless). Every MBTA route is drawn in its official colour from the V3
  API's typical route pattern per direction (diversions and the
  rail-replacement shuttle catalog are never drawn as permanent routes);
  rapid transit bold, commuter rail and ferries medium, buses thin. Routes
  with a delay, detour, suspension, shuttle, cancellation or service change
  in force carry magenta dashes; closed, moved or bypassed stops are ringed
  magenta markers. Vehicle cards name the route ("Red Line", not "Route
  Red"; buses keep their number and gain their destinations) and list the
  alerts in force; clicking a route line or stop marker opens its own card.
  The layer row counts disrupted routes and carries "Bus lines" and "Stop
  alerts" toggles. New proxy resources `/api/transit/routes/mbta` (12 h
  cache, a week of serve-stale) and `/api/transit/alerts/mbta` (60 s cache,
  30 min serve-stale, with stop positions looked up for the ids MBTA's own
  alerts name) follow the vehicle feeds' registered-URL, redirect, byte-cap,
  admission and backoff rules.
