'use strict';
/**
 * scripts/convert-path-gtfs.js
 *
 * Converts PATH's static GTFS feed (data/panynj_rail_data/, a complete
 * Trillium Solutions-published feed provided directly for this project —
 * see data/panynj_rail_data/panynj README.md for the real-time feed this
 * pairs with) into the mini-nyc-3d data format, merging into the existing
 * data/railways.json, data/stations.json, data/coordinates.json, and
 * data/train-timetables/ alongside MTA/NJT data (see
 * scripts/lib/gtfs-merge.js).
 *
 * Usage:
 *   node scripts/convert-path-gtfs.js
 *
 * Outputs (merge-written — MTA/NJT entries are preserved, only PATH.*
 * entries are replaced):
 *   data/railways.json
 *   data/stations.json
 *   data/coordinates.json     (railways section)
 *   data/train-timetables/path-<route>.json
 *
 * data/station-groups.json is left untouched — this feed has no
 * transfers.txt equivalent wired into this script (PATH's actual
 * transfers.txt exists but station-groups.json handling isn't
 * needed for this feature).
 */

const fs = require('fs');
const path = require('path');
const {parse} = require('csv-parse/sync');
const {readJSON, writeJSON, mergeArrayById} = require('./lib/gtfs-merge');
const {buildServiceCalendar} = require('./lib/gtfs-calendar');

const DATA_DIR = path.join('data', 'panynj_rail_data');

const DIRECTIONS = ['Outbound', 'Inbound'];

function parseCSV(fileName) {
    return parse(fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });
}

function normRoute(rawId) { return `PATH.${rawId}`; }
function normTrip(rawId)  { return `PATH.${rawId}`; }

// stop_times.txt references platform-level stops (location_type=0); the
// real-time feed only ever reports arrivals at the parent station
// (location_type=1) — confirmed by inspecting both the static data and a
// live fetch of the real-time feed during design. Every station ID used
// in railways.json/stations.json must be the parent-normalized one so the
// real-time proxy (Task 2) can match live stopIds directly.
function buildStationNormalizer(stops) {
    const byId = new Map(stops.map(s => [s.stop_id, s]));
    return function normalizeToStationId(rawStopId) {
        const stop = byId.get(rawStopId);
        if (stop && stop.parent_station) return stop.parent_station;
        return rawStopId;
    };
}

function main() {
    const routes = parseCSV('routes.txt');
    const stops = parseCSV('stops.txt');
    const allTrips = parseCSV('trips.txt');
    const calendarDates = parseCSV('calendar_dates.txt');
    const calendar = parseCSV('calendar.txt');
    const shapes = parseCSV('shapes.txt');

    const normalizeToStationId = buildStationNormalizer(stops);
    const normStop = rawId => `PATH.${normalizeToStationId(rawId)}`;

    console.log('[PATH] Parsing stop_times.txt (this may take a moment)...');
    const stopTimes = parseCSV('stop_times.txt');
    console.log(`[PATH] ${stopTimes.length.toLocaleString()} stop-time rows loaded.`);

    const {svcCal, repDates} = buildServiceCalendar(calendar, calendarDates);
    if (repDates.length > 0) {
        console.log(`[PATH] calendar_dates: representative dates selected: ${repDates.join(', ')}`);
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
    // Same branch-aware algorithm as convert-njt-gtfs.js/convert-mta-gtfs.js:
    // consider every distinct shape used by any trip on a route, keep the
    // longest (most stations) first, then greedily keep any other shape
    // that visits at least one station not already covered. Routes with one
    // physical track collapse to a single entry; genuine branches (if any
    // exist among PATH's 7 routes) each get their own railway id
    // (PATH.<route>.b2, .b3, ...).
    const railways = [];
    const routeStations = new Map(); // railway id -> [normStopId, ...]
    const routeShapeSelections = new Map(); // railway id -> shape_id

    for (const route of routes) {
        const routeTrips = tripsByRoute.get(route.route_id) || [];

        // Multiple trips can share one shape_id (same physical track) while
        // stopping at very different subsets of its stations — picking an
        // arbitrary trip per shape_id silently drops whichever stations
        // only appear on a longer trip sharing that shape. Keep the trip
        // with the most stop_times rows instead — the fullest/local
        // pattern is a superset of every shorter trip on the same shape in
        // practice, so this maximizes real station coverage without
        // changing which shape's geometry gets used. (Same fix applied to
        // scripts/convert-njt-gtfs.js after this exact bug was found to
        // drop real NJT stations.)
        const repTripByShape = new Map();
        const repTripStopCount = new Map();
        for (const trip of routeTrips) {
            if (!trip.shape_id) continue;
            const stopCount = (stsByTrip.get(trip.trip_id) || []).length;
            if (stopCount > (repTripStopCount.get(trip.shape_id) || 0)) {
                repTripByShape.set(trip.shape_id, trip);
                repTripStopCount.set(trip.shape_id, stopCount);
            }
        }

        const candidates = [];
        for (const [shapeId, trip] of repTripByShape) {
            const stationList = [];
            for (const st of stsByTrip.get(trip.trip_id) || []) {
                const sid = normStop(st.stop_id);
                if (!stationList.includes(sid)) stationList.push(sid);
            }
            if (stationList.length > 0) candidates.push({shapeId, stationList});
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
            const baseId = normRoute(route.route_id);
            const railwayId = i === 0 ? baseId : `${baseId}.b${i + 1}`;

            routeStations.set(railwayId, cand.stationList);
            routeShapeSelections.set(railwayId, cand.shapeId);

            railways.push({
                id: railwayId,
                title: {en: route.route_long_name || route.route_short_name || route.route_id},
                stations: cand.stationList,
                ascending: DIRECTIONS[0],
                descending: DIRECTIONS[1],
                color: route.route_color ? `#${route.route_color}` : '#888888',
                carComposition: 8
            });
        });
    }

    // --- stations (de-duplicated by normalised, parent-resolved stop ID) ---
    const stationMap = new Map();
    for (const stop of stops) {
        if (stop.location_type && stop.location_type !== '1') continue; // only station-level rows
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

        const cal = svcCal.get(trip.service_id) || 'Weekday';

        const routeId = normRoute(trip.route_id);
        const tripId = normTrip(trip.trip_id);
        const dir = DIRECTIONS[trip.direction_id === '1' ? 1 : 0];

        const tt = sts.map(st => ({
            s: normStop(st.stop_id),
            d: st.departure_time.slice(0, 5)
        }));

        const entry = {
            id: `${tripId}.${cal}`,
            t: tripId,
            r: routeId,
            n: trip.trip_short_name || trip.trip_id,
            y: 'PATH.Regional',
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

    console.log(`[PATH] ${railways.length} routes | ${stationMap.size} stations | ${allTrips.length} trips | ${railwayShapes.length} shapes`);

    // --- merge-write into the shared data files ---
    const mergedRailways = mergeArrayById(readJSON('data/railways.json', []), railways, 'PATH');
    writeJSON('data/railways.json', mergedRailways);
    console.log(`Wrote data/railways.json    (${railways.length} PATH railways, ${mergedRailways.length} total)`);

    const mergedStations = mergeArrayById(readJSON('data/stations.json', []), Array.from(stationMap.values()), 'PATH');
    writeJSON('data/stations.json', mergedStations);
    console.log(`Wrote data/stations.json    (${stationMap.size} PATH stations, ${mergedStations.length} total)`);

    const existingCoords = readJSON('data/coordinates.json', {airways: [], railways: []});
    const mergedShapes = mergeArrayById(existingCoords.railways || [], railwayShapes, 'PATH');
    writeJSON('data/coordinates.json', {
        airways: existingCoords.airways || [],
        railways: mergedShapes
    });
    console.log(`Wrote data/coordinates.json (${railwayShapes.length} PATH shapes, ${mergedShapes.length} total)`);

    const ttDir = 'data/train-timetables';
    for (const f of fs.readdirSync(ttDir).filter(f => f.startsWith('path-'))) {
        fs.unlinkSync(path.join(ttDir, f));
    }
    let written = 0;
    for (const [routeId, entries] of timetablesByRoute) {
        const route = routes.find(r => r.route_id === routeId);
        const fileName = `path-${(route?.route_id || routeId).toLowerCase()}.json`;
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
