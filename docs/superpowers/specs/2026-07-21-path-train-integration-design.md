# PATH Train Integration — Design

## Context

Mini NYC 3D currently renders MTA Subway/LIRR/Metro-North, NJ Transit rail,
and aircraft. PATH (Port Authority Trans-Hudson) has been listed as
"Planned for v2" since the NJT work shipped. The user has now provided a
complete static GTFS feed for PATH (`data/panynj_rail_data/`, a Trillium
Solutions-published feed, `feed_id: path-nj-us`) and pointed at PATH's only
available real-time source: `https://path.transitdata.nyc/gtfsrt`, a public
GTFS-RT feed with no authentication required.

**The core problem this design solves:** PATH's real-time feed is
genuinely crippled. Per its own README (`data/panynj_rail_data/panynj
README.md`) and confirmed by fetching the live feed directly during
brainstorming: every entity is a dummy trip with a random ID and exactly
one `stopTimeUpdate` — `{routeId, directionId, stopId, arrival.time}`, no
departure time, no way to link one prediction to another as the same
physical train. This is fundamentally different from MTA/NJT's real-time
feeds, which carry full per-trip stop sequences.

## Goals

- Render all PATH lines (7 routes in the static feed) with real track
  geometry and live-estimated train positions.
- Use PATH's real-time feed meaningfully — actual arrival predictions
  should drive visible train movement, not just decorate a static schedule.
- No new operator/credential infrastructure: the real-time feed needs no
  auth, unlike NJT.

## Non-goals

- Perfect train-by-train tracking. The real-time feed provides no trip
  continuity; any "train" the map shows during a live tick is a
  best-estimate synthesized from paired arrival predictions, not a
  tracked physical vehicle.
- Terminal-station "standing before departure" visuals. Skipped for v1 —
  see "Real-time position-estimation engine" below.
- Service alerts. The live feed's structure (per the README and the
  fetched sample) appears to be TripUpdates only; if `entity.alert` items
  turn out to be present, they'll be wired the same way MTA/NJT alerts
  are, but this isn't a confirmed part of the feed and isn't required for
  this feature to be complete.

## Architecture

```
data/panynj_rail_data/ (already provided: routes, stops, trips,
        stop_times, shapes, calendar_dates, etc. — a complete,
        current Trillium-published GTFS feed)
        │
        ▼
scripts/convert-path-gtfs.js  ──► data/railways.json, data/stations.json,
        │                         data/coordinates.json, data/train-timetables/
        │                         (merge-write, PATH.* prefix, same
        │                         pattern as convert-njt-gtfs.js)
        ▼
npm run build-data  ──► build/data/*.json.gz


https://path.transitdata.nyc/gtfsrt (public, no auth)
        │
        ▼
api/path.js (Vercel) + server.js mirror (local dev)
  - decode GTFS-RT TripUpdates (one stopTimeUpdate each)
  - group by (routeId, directionId, stopId) into per-station queues,
    sorted by arrival time ascending
  - ordinal-pair consecutive stations' queues to synthesize in-transit
    "legs"; interpolate position for legs whose window contains "now"
  - {trainData, trainInfoData} — same shape the client already consumes
        │
        ▼
src/loader.js: loadDynamicPathTrainData()  ──► loadJSON(configs.pathUrl)
  (never rejects — resolves to empty stubs on any error, from the start)
        │
        ▼
map.js realtime update cycle: concat with MTA/NJT trainData/trainInfoData
```

## Static schedule data — `scripts/convert-path-gtfs.js`

Mirrors `scripts/convert-njt-gtfs.js` closely, reading the already-present
local `data/panynj_rail_data/` (no network fetch — this feed doesn't need
periodic refreshing any differently than NJT's, and the user provided it
directly).

- **Route scope:** all 7 routes in `routes.txt` (859 Hoboken-33rd St, 860
  Hoboken-WTC, 861 Journal Square-33rd St, 862 Newark-WTC, 1024 Journal
  Square-33rd St via Hoboken, 74320 Newark-Harrison Shuttle, 77285
  WTC-33rd St) — PATH's entire system is within the NYC area by
  definition, no exclusions needed (unlike NJT's Atlantic City Line).
- **ID scheme:** `PATH.<route_id>` / `PATH.<stop_id>`, matching the
  existing `PATH` operator entry in `data/operators.json`
  (`color: #003DA5`).
- **Station normalization:** `stops.txt` has full GTFS hierarchy —13
  stations (`location_type=1`), 29 child platforms (`location_type=0`),
  22 entrances (`location_type=2`). `stop_times.txt` references
  platform-level stops; station lists and the real-time proxy's queue
  keys must use the platform's `parent_station`, since the real-time feed
  only ever reports arrivals at the station level (confirmed both by the
  README and by inspecting the live feed's `stopId` values, which resolve
  to `location_type=1` stops).
- **Branching:** reuse the branch-aware multi-shape algorithm already
  proven on NJT's HBLR/Newark Light Rail and MTA's Rockaway/Port
  Jefferson branches — pick the longest-station-count shape as the base
  entry, keep additional shapes that introduce new stations as
  `PATH.<route_id>.b2`, `.b3`, etc. PATH's "via Hoboken" routes and the
  Newark-Harrison shuttle are plausible candidates for genuine branch
  detection, but the algorithm handles this generically either way.
- **Track geometry:** real `shapes.txt` is present and populated (3,549
  points across the feed) — no straight-line fallback needed, unlike the
  scope question raised (and superseded) earlier in this same
  conversation before the fuller feed was provided.
- **Merge-write:** same `mergeArrayById`/`mergeStationGroups` helpers
  already shared across the MTA/NJT scripts, using the `PATH` prefix —
  no changes needed to the shared helpers themselves.

## Real-time position-estimation engine

This is the core of the feature. Verified directly against the live feed
during brainstorming: every entity is
`{trip: {tripId (random, unusable), routeId, directionId}, stopTimeUpdate:
[{arrival: {time}, stopId}], timestamp}` — one arrival prediction, no
departure time, no trip continuity.

**Algorithm:**

1. Fetch and decode the feed (`GtfsRealtimeBindings`, no auth).
2. Group entities into per-`(routeId, directionId, stopId)` queues,
   sorted by `arrival.time` ascending. This is literally the "next N
   arrivals at this station, in this direction" data the feed provides —
   no transformation needed to get this far.
3. For each `(routeId, directionId)`, take the ordered station sequence
   from the converted static railway (the branch-aware station list
   built above). For each consecutive pair of stations (A, B) in that
   sequence, pair the *Nth-soonest* prediction in A's queue with the
   *Nth-soonest* in B's queue — same N, for every N up to
   `min(queueA.length, queueB.length)`. This assumes trains reach
   consecutive stations in the same relative order they left the
   previous one (true for PATH: no overtaking).
4. Since there's no departure time, assume a fixed dwell (~20 seconds,
   consistent with PATH's short real-world platform stops) after
   arrival-at-A before the train is considered to depart toward B. The
   interpolation window for that synthesized leg is
   `[arrival-at-A + dwell, arrival-at-B]`.
5. If *now* falls inside a leg's window, emit a train positioned at the
   corresponding fraction along that segment's real shape geometry
   (reusing the existing distance-along-track interpolation this app
   already does for every other agency's trains — exact field-shape
   mapping into the `Train` rendering path to be confirmed by reading
   `src/map.js`'s `Train` class during implementation, not re-derived
   here).
6. Skip legs where either station's queue doesn't have an Nth entry
   (mismatched queue lengths — genuinely "no data for this hypothetical
   train," not an error to work around). Skip `(routeId, directionId)`
   pairs with too few predictions to pair anything.
7. **v1 scope trim:** no rendering at a route's terminal (first) station
   before its first real segment — there's no preceding station to pair
   against there, and synthesizing a "standing at origin" display for
   that case adds complexity disproportionate to its visual value. Can
   be revisited later.
8. Recomputed fresh on every request — no server-side caching beyond
   normal short-TTL CDN caching (`s-maxage` in the 15-30s range,
   matching `configs.realtimeCheckInterval`), since the entire point is
   showing current estimated positions, and there's no quota to protect
   (unlike NJT).

## Client wiring

- **`src/configs.js`:** `pathUrl`, same pattern as `njtUrl`/`flightUrl` —
  points at the Vercel proxy in production, `/api/path` locally.
- **`src/loader.js`:** `loadDynamicPathTrainData()`, structurally
  identical to `loadDynamicNjtTrainData()` — **including the
  never-rejects `.catch()` safety net from the start** this time (NJT's
  version needed that added as a follow-up fix after a task review
  caught the `Promise.all` all-or-nothing failure mode; building it in
  immediately avoids repeating that).
- **`src/map.js`:** `refreshRealtimeTrainData()`'s `Promise.all` extends
  to include `loadDynamicPathTrainData()`, concatenating `trainData`/
  `trainInfoData` the same way MTA/NJT already do.

## Map styling

No new work needed — railway/station/track color rendering is already
fully data-driven from `railways.json`'s per-railway `color` field
(sourced from PATH's own `route_color` per line), confirmed working
end-to-end for every agency added to this map so far. The `PATH` operator
entry already exists in `data/operators.json`.

## Verification plan

1. Run `scripts/convert-path-gtfs.js`; confirm all 7 routes convert with
   sensible station counts, real (non-straight-line) shape geometry, and
   that any genuine branches (e.g. the "via Hoboken" routes) are captured
   as separate `PATH.<route>.bN` entries rather than collapsed.
2. Test the real-time proxy directly against the live feed — freely
   repeatable with no quota concerns, unlike NJT's authenticated feed.
   Confirm the ordinal-pairing logic produces sane in-transit legs (spot
   check: interpolation windows should be short — a few minutes at most,
   matching PATH's short inter-station hops — and should not go
   negative).
3. `npm run build-data` + local server; confirm PATH lines render in
   their real colors along real track curves.
4. Live browser check: confirm PATH trains visibly move between stations
   at a plausible pace, consistent with the paired arrival predictions,
   and that the map doesn't show trains "teleporting" or stuck.
5. Confirm existing MTA/NJT/aircraft functionality is unaffected
   (regression check, consistent with every prior integration in this
   project).
