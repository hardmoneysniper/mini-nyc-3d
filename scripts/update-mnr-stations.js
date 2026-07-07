#!/usr/bin/env node
'use strict';
/**
 * scripts/update-mnr-stations.js
 *
 * Populates the full station lists for all 6 MNR lines using the 2020 local
 * GTFS data (data/metro_north/).  The original railways.json only had partial
 * station lists (e.g. Hudson only had 13/30 stations), causing stop circles
 * to disappear after Yonkers.
 *
 * Updates:
 *   data/stations.json  — adds any missing MNR station entries
 *   data/railways.json  — replaces partial station lists with full ordered ones
 *
 * After this script, run: npm run build-data
 */

const fs   = require('fs');
const path = require('path');
const {parse} = require('csv-parse/sync');

const LOCAL_GTFS = 'data/metro_north';

function readCSV(file) {
    return parse(fs.readFileSync(path.join(LOCAL_GTFS, file), 'utf8'),
        {columns: true, skip_empty_lines: true, trim: true});
}

const gtfsTrips     = readCSV('trips.txt');
const gtfsStopTimes = readCSV('stop_times.txt');
const gtfsStops     = readCSV('stops.txt');

const stopById = {};
for (const s of gtfsStops) stopById[s.stop_id] = s;

function gctDist(s) {
    const dlat = parseFloat(s.stop_lat) - 40.752998;
    const dlon = parseFloat(s.stop_lon) - (-73.977056);
    return Math.sqrt(dlat * dlat + dlon * dlon);
}

// Get all unique stops for a GTFS route, sorted from GCT outward.
// sortMode: 'lat'  = ascending latitude (Hudson, Harlem, Danbury — mostly N/S)
//           'dist' = ascending distance from GCT (New Haven, New Canaan — NE diagonal)
//           'dist-bridgeport' = ascending distance from Bridgeport junction (Waterbury)
function getRouteStops(routeId, sortMode) {
    const routeTrips = new Set(gtfsTrips.filter(t => t.route_id === routeId).map(t => t.trip_id));
    const seen = new Set();
    for (const st of gtfsStopTimes) {
        if (routeTrips.has(st.trip_id)) seen.add(st.stop_id);
    }
    const stops = [...seen].map(id => stopById[id]).filter(Boolean);

    if (sortMode === 'lat') {
        stops.sort((a, b) => parseFloat(a.stop_lat) - parseFloat(b.stop_lat));
    } else if (sortMode === 'dist') {
        stops.sort((a, b) => gctDist(a) - gctDist(b));
    } else if (sortMode === 'dist-bridgeport') {
        const bpLat = 41.178677, bpLon = -73.187076;
        stops.sort((a, b) => {
            const da = Math.hypot(parseFloat(a.stop_lat) - bpLat, parseFloat(a.stop_lon) - bpLon);
            const db = Math.hypot(parseFloat(b.stop_lat) - bpLat, parseFloat(b.stop_lon) - bpLon);
            return da - db;
        });
    }
    return stops;
}

// Sorted stop lists per MNR GTFS route (id → [stops in GCT-outward order])
const routeStops = {
    '1': getRouteStops('1', 'lat'),    // Hudson: goes N
    '2': getRouteStops('2', 'lat'),    // Harlem: goes N
    '3': getRouteStops('3', 'dist'),   // New Haven: goes NE
    '4': getRouteStops('4', 'dist'),   // New Canaan branch: goes NE
    '5': getRouteStops('5', 'lat'),    // Danbury branch: goes N
    '6': getRouteStops('6', 'dist-bridgeport') // Waterbury: branch off Bridgeport
};

// MNR railway IDs map to GTFS route IDs 1-6
const ROUTE_TO_RAILWAY = {
    '1': 'MTA.MNR.1',
    '2': 'MTA.MNR.2',
    '3': 'MTA.MNR.3',
    '4': 'MTA.MNR.4',
    '5': 'MTA.MNR.5',
    '6': 'MTA.MNR.6'
};

// ── 1. Update stations.json ──────────────────────────────────────────────────
const stationsPath = 'data/stations.json';
const stations = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));
const stationById = new Map(stations.map(s => [s.id, s]));

let addedStations = 0;
const allGtfsStops = Object.values(routeStops).flat();
const seenStopIds = new Set();

for (const stop of allGtfsStops) {
    const id = `MTA.MNR.${stop.stop_id}`;
    if (seenStopIds.has(id)) continue;
    seenStopIds.add(id);

    if (!stationById.has(id)) {
        stations.push({
            id,
            railway: 'MTA.MNR.1', // placeholder; overwritten below from railways.json
            coord:   [parseFloat(stop.stop_lon), parseFloat(stop.stop_lat)],
            title:   {en: stop.stop_name}
        });
        stationById.set(id, stations[stations.length - 1]);
        addedStations++;
    }
}

fs.writeFileSync(stationsPath, JSON.stringify(stations, null, '\t'), 'utf8');
console.log(`stations.json: added ${addedStations} new MNR stations`);

// ── 2. Update railways.json ──────────────────────────────────────────────────
const railwaysPath = 'data/railways.json';
const railways = JSON.parse(fs.readFileSync(railwaysPath, 'utf8'));

for (const [gtfsRoute, railwayId] of Object.entries(ROUTE_TO_RAILWAY)) {
    const railway = railways.find(r => r.id === railwayId);
    if (!railway) { console.warn(`${railwayId} not found in railways.json`); continue; }

    const stops = routeStops[gtfsRoute];
    const stationIds = stops.map(s => `MTA.MNR.${s.stop_id}`);
    const before = railway.stations.length;
    railway.stations = stationIds;
    console.log(`${railwayId} (${railway.title.en}): ${before} → ${stationIds.length} stations`);
    console.log(`  First: ${stops[0]?.stop_name}, Last: ${stops[stops.length - 1]?.stop_name}`);
}

fs.writeFileSync(railwaysPath, JSON.stringify(railways, null, '\t'), 'utf8');
console.log('\nDone. Run next: npm run build-data');
