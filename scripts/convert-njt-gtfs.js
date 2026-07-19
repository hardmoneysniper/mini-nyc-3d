'use strict';
/**
 * scripts/convert-njt-gtfs.js
 *
 * Converts the NJ Transit rail static GTFS feed already downloaded into
 * data/njt_rail_data/ into the mini-nyc-3d data format, merging into the
 * existing data/railways.json, data/stations.json, data/coordinates.json,
 * and data/train-timetables/ alongside MTA's data (see scripts/lib/gtfs-merge.js).
 *
 * NJ Transit's rail GTFS/GTFSRT Web API requires an authenticated token to
 * download (see data/NJTRANSIT_Rail_GTFSRT_V1.pdf), and the daily token
 * quota is scarce (10 getToken/isValidToken calls/day total). Since rail
 * schedules change rarely, this script reads the already-downloaded local
 * CSVs directly rather than calling getGTFS on every run. To refresh:
 * download a fresh zip via NJT's developer portal, unzip it into
 * data/njt_rail_data/, and rerun this script.
 *
 * Usage:
 *   node scripts/convert-njt-gtfs.js
 *
 * Outputs (merge-written — MTA's entries are preserved, only NJT.* entries
 * are replaced):
 *   data/railways.json
 *   data/stations.json
 *   data/coordinates.json     (railways section)
 *   data/train-timetables/njt-<route>.json
 *
 * data/station-groups.json is left untouched — this feed ships no
 * transfers.txt.
 */

const fs = require('fs');
const path = require('path');
const {parse} = require('csv-parse/sync');
const {readJSON, writeJSON, mergeArrayById} = require('./lib/gtfs-merge');
const {buildServiceCalendar} = require('./lib/gtfs-calendar');

const DATA_DIR = path.join('data', 'njt_rail_data');

// Routes that actually serve the NYC area (terminate at NY Penn or Hoboken).
// Excludes ATLC (Atlantic City Line) and RVLN (River Line), which run
// Philadelphia/Camden <-> Trenton/Atlantic City and never reach NYC.
const INCLUDED_ROUTES = new Set([
    'NEC', 'NJCL', 'NJCLL', 'MNE', 'MNEG', 'BNTN', 'BNTNM',
    'MNBN', 'MNBNP', 'PASC', 'RARV', 'MRL', 'PRIN', 'HBLR', 'NLR'
]);
const LIGHT_RAIL_ROUTES = new Set(['HBLR', 'NLR']);

const DIRECTIONS = ['Outbound', 'Inbound'];

function parseCSV(fileName) {
    return parse(fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });
}

function normStop(rawId)  { return `NJT.${rawId}`; }
function normRoute(rawId) { return `NJT.${rawId}`; }
function normTrip(rawId)  { return `NJT.${rawId}`; }

function main() {
    const routes = parseCSV('routes.txt').filter(r => INCLUDED_ROUTES.has(r.route_short_name));
    const includedRouteIds = new Set(routes.map(r => r.route_id));

    const stops = parseCSV('stops.txt');
    const allTrips = parseCSV('trips.txt').filter(t => includedRouteIds.has(t.route_id));
    const calendarDates = parseCSV('calendar_dates.txt');
    const shapes = parseCSV('shapes.txt');

    console.log('[NJT] Parsing stop_times.txt (this may take a moment)...');
    const tripIds = new Set(allTrips.map(t => t.trip_id));
    const stopTimes = parseCSV('stop_times.txt').filter(st => tripIds.has(st.trip_id));
    console.log(`[NJT] ${stopTimes.length.toLocaleString()} stop-time rows for included routes.`);

    // NJT's feed only has calendar_dates.txt (no calendar.txt) — always
    // derive representative Weekday/Saturday/Holiday service IDs from it.
    const {svcCal, repDates} = buildServiceCalendar([], calendarDates);
    if (repDates.length > 0) {
        console.log(`[NJT] calendar_dates: representative dates selected: ${repDates.join(', ')}`);
    }

    // --- stop_times grouped by trip, sorted by sequence ---
    const stsByTrip = new Map();
    for (const st of stopTimes) {
        if (!stsByTrip.has(st.trip_id)) stsByTrip.set(st.trip_id, []);
        stsByTrip.get(st.trip_id).push(st);
    }
    for (const arr of stsByTrip.values()) {
        arr.sort((a, b) => +a.stop_sequence - +b.stop_sequence);
    }

    // --- trips grouped by route ---
    const tripsByRoute = new Map();
    for (const trip of allTrips) {
        if (!tripsByRoute.has(trip.route_id)) tripsByRoute.set(trip.route_id, []);
        tripsByRoute.get(trip.route_id).push(trip);
    }

    // --- railways + station order ---
    //
    // NJT assigns a near-unique shape_id per trip even on routes that only
    // ever run one physical track (e.g. NEC: 472 trips, 472 shapes) — those
    // shapes are near-duplicates of each other and collapsing to one
    // representative trip (the old approach) was correct for them. But a few
    // routes are genuinely branching light rail — HBLR alone has 29 distinct
    // shapes across 982 trips (real branches: West Side Avenue, Tonnelle
    // Avenue, 8th Street, plus short-turn patterns), and picking only one
    // representative trip silently dropped the other branches' track and
    // stations from the map entirely.
    //
    // Fix: for each route, look at every distinct shape used by any trip.
    // Sort by how many stations that shape's trip visits (longest first),
    // then greedily keep a shape only if it visits at least one station not
    // already covered by a previously-kept shape. Near-duplicate shapes
    // (NEC's 472) collapse back down to just the first one, since every
    // later shape is a subset of the first. Genuine branches (HBLR's West
    // Side Ave / Tonnelle Ave / etc.) each introduce new stations and get
    // kept. Each kept shape becomes its OWN railway entry — this codebase's
    // "sublines" are sequential segments of one continuous path (used to
    // offset parallel track), not a fork, so a true branch needs a separate
    // railway id the way the subway already models distinct lines. The
    // first (longest) kept shape reuses the plain NJT.<route_id> id so
    // real-time trip updates (which only carry route_id, not shape_id)
    // keep resolving to it; additional branches get NJT.<route_id>.b2, .b3, etc.
    const railways = [];
    const routeStations = new Map(); // railway id (incl. branch suffixes) -> station list
    const routeShapeSelections = new Map(); // railway id -> shape_id, for the shapes pass below

    for (const route of routes) {
        const routeTrips = tripsByRoute.get(route.route_id) || [];
        const isLightRail = LIGHT_RAIL_ROUTES.has(route.route_short_name);

        const repTripByShape = new Map();
        for (const trip of routeTrips) {
            if (!trip.shape_id || repTripByShape.has(trip.shape_id)) continue;
            repTripByShape.set(trip.shape_id, trip);
        }

        const candidates = [];
        for (const [shapeId, trip] of repTripByShape) {
            const stationList = [];
            for (const st of stsByTrip.get(trip.trip_id) || []) {
                const sid = normStop(st.stop_id);
                if (!stationList.includes(sid)) stationList.push(sid);
            }
            if (stationList.length > 0) candidates.push({shapeId, stationList, headsign: trip.trip_headsign});
        }
        candidates.sort((a, b) => b.stationList.length - a.stationList.length);

        const covered = new Set();
        const selected = [];
        for (const cand of candidates) {
            if (!cand.stationList.some(sid => !covered.has(sid))) continue;
            cand.stationList.forEach(sid => covered.add(sid));
            selected.push(cand);
        }

        selected.forEach((cand, i) => {
            const railwayId = i === 0 ? normRoute(route.route_id) : `${normRoute(route.route_id)}.b${i + 1}`;
            const branchLabel = i > 0 && cand.headsign ? ` (${cand.headsign.replace(/^HBLR |^NLR /, '')})` : '';

            routeStations.set(railwayId, cand.stationList);
            routeShapeSelections.set(railwayId, cand.shapeId);

            railways.push({
                id: railwayId,
                title: {en: (route.route_long_name || route.route_short_name) + branchLabel},
                stations: cand.stationList,
                ascending: DIRECTIONS[0],
                descending: DIRECTIONS[1],
                color: route.route_color ? `#${route.route_color}` : '#888888',
                carComposition: isLightRail ? 2 : 8
            });
        });
    }

    // --- stations (de-duplicated by normalised stop ID) ---
    const stationMap = new Map();
    for (const stop of stops) {
        const sid = normStop(stop.stop_id);
        if (stationMap.has(sid)) continue;
        let railway = null;
        for (const [rId, list] of routeStations) {
            if (list.includes(sid)) { railway = rId; break; }
        }
        if (!railway) continue;
        stationMap.set(sid, {
            id: sid,
            railway,
            coord: [parseFloat(stop.stop_lon), parseFloat(stop.stop_lat)],
            title: {en: stop.stop_name}
        });
    }

    // --- timetables (keyed by raw route_id for file naming) ---
    const timetablesByRoute = new Map();
    for (const trip of allTrips) {
        const sts = stsByTrip.get(trip.trip_id);
        if (!sts || sts.length === 0) continue;

        const cal = svcCal.get(trip.service_id);
        if (!cal) continue; // not part of a representative Weekday/Saturday/Holiday date

        const routeId = normRoute(trip.route_id);
        const tripId = normTrip(trip.trip_id);
        const dir = DIRECTIONS[trip.direction_id === '1' ? 1 : 0];
        const route = routes.find(r => r.route_id === trip.route_id);
        const isLightRail = LIGHT_RAIL_ROUTES.has(route?.route_short_name);

        const tt = sts.map(st => ({
            s: normStop(st.stop_id),
            d: st.departure_time.slice(0, 5)
        }));

        const entry = {
            id: `${tripId}.${cal}`,
            t: tripId,
            r: routeId,
            n: trip.trip_id,
            y: isLightRail ? 'NJT.LightRail' : 'NJT.Regional',
            d: dir,
            os: [tt[0].s],
            tt
        };

        if (!timetablesByRoute.has(trip.route_id)) timetablesByRoute.set(trip.route_id, []);
        timetablesByRoute.get(trip.route_id).push(entry);
    }

    // --- track shapes from shapes.txt ---
    const shapePoints = new Map();
    for (const pt of shapes) {
        if (!shapePoints.has(pt.shape_id)) shapePoints.set(pt.shape_id, []);
        shapePoints.get(pt.shape_id).push(pt);
    }
    for (const arr of shapePoints.values()) {
        arr.sort((a, b) => +a.shape_pt_sequence - +b.shape_pt_sequence);
    }

    const railwayShapes = [];
    for (const [railwayId, shapeId] of routeShapeSelections) {
        const pts = shapePoints.get(shapeId);
        if (!pts || pts.length === 0) continue;
        railwayShapes.push({
            id: railwayId,
            sublines: [{
                type: 'main',
                coords: pts.map(p => [parseFloat(p.shape_pt_lon), parseFloat(p.shape_pt_lat)])
            }]
        });
    }

    console.log(`[NJT] ${railways.length} routes | ${stationMap.size} stations | ${allTrips.length} trips | ${railwayShapes.length} shapes`);

    // --- merge-write into the shared data files ---
    const mergedRailways = mergeArrayById(readJSON('data/railways.json', []), railways, 'NJT');
    writeJSON('data/railways.json', mergedRailways);
    console.log(`Wrote data/railways.json    (${railways.length} NJT railways, ${mergedRailways.length} total)`);

    const mergedStations = mergeArrayById(readJSON('data/stations.json', []), Array.from(stationMap.values()), 'NJT');
    writeJSON('data/stations.json', mergedStations);
    console.log(`Wrote data/stations.json    (${stationMap.size} NJT stations, ${mergedStations.length} total)`);

    const existingCoords = readJSON('data/coordinates.json', {airways: [], railways: []});
    const mergedShapes = mergeArrayById(existingCoords.railways || [], railwayShapes, 'NJT');
    writeJSON('data/coordinates.json', {
        airways: existingCoords.airways || [],
        railways: mergedShapes
    });
    console.log(`Wrote data/coordinates.json (${railwayShapes.length} NJT shapes, ${mergedShapes.length} total)`);

    const ttDir = 'data/train-timetables';
    for (const f of fs.readdirSync(ttDir).filter(f => f.startsWith('njt-'))) {
        fs.unlinkSync(path.join(ttDir, f));
    }
    let written = 0;
    for (const [routeId, entries] of timetablesByRoute) {
        const route = routes.find(r => r.route_id === routeId);
        const fileName = `njt-${(route?.route_short_name || routeId).toLowerCase()}.json`;
        writeJSON(path.join(ttDir, fileName), entries);
        written++;
    }
    console.log(`Wrote ${written} timetable files → ${ttDir}/`);

    console.log('\n✓ Done! Run "npm run build-data" next to compile into build/.');
}

try {
    main();
} catch (err) {
    console.error('\nFatal:', err.message);
    process.exit(1);
}
