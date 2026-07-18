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
    const railways = [];
    const routeStations = new Map();
    const routeShapeIds = new Map();

    for (const route of routes) {
        const routeId = normRoute(route.route_id);
        const routeTrips = tripsByRoute.get(route.route_id) || [];
        const isLightRail = LIGHT_RAIL_ROUTES.has(route.route_short_name);

        const repTrip = routeTrips.find(t => t.direction_id === '0') || routeTrips[0];
        const stationList = [];
        if (repTrip) {
            for (const st of stsByTrip.get(repTrip.trip_id) || []) {
                const sid = normStop(st.stop_id);
                if (!stationList.includes(sid)) stationList.push(sid);
            }
            if (repTrip.shape_id) routeShapeIds.set(routeId, repTrip.shape_id);
        }
        routeStations.set(routeId, stationList);

        railways.push({
            id: routeId,
            title: {en: route.route_long_name || route.route_short_name},
            stations: stationList,
            ascending: DIRECTIONS[0],
            descending: DIRECTIONS[1],
            color: route.route_color ? `#${route.route_color}` : '#888888',
            carComposition: isLightRail ? 2 : 8
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
    for (const [routeId, shapeId] of routeShapeIds) {
        const pts = shapePoints.get(shapeId);
        if (!pts || pts.length === 0) continue;
        railwayShapes.push({
            id: routeId,
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
