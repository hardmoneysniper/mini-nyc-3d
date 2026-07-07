#!/usr/bin/env node
'use strict';
/**
 * scripts/patch-lirr11-belmont.js
 *
 * LIRR.11 (Belmont Park) is a seasonal special-service branch that the live
 * GTFS omits; railways.json ends up with stations:[] and no geometry.
 * This script backfills the 2015 GTFS data from data/lirr/:
 *   - Adds stop 32 (Belmont Park) to data/stations.json as MTA.LIRR.32
 *   - Sets MTA.LIRR.11 stations to ['MTA.LIRR.32'] in data/railways.json
 *   - Adds the Belmont spur shape (shape 160, spur-only 124 pts) to
 *     data/coordinates.json as MTA.LIRR.11
 *
 * After this script succeeds, run:
 *   npm run build-data
 */

const fs   = require('fs');
const {parse} = require('csv-parse/sync');

const LIRR_2015 = 'data/lirr';
const BELMONT_STOP_ID  = '32';
const BELMONT_SHAPE_ID = '160'; // spur only: Belmont → Jamaica-junction (will be reversed)
// Use a named ID — live GTFS stop_id 32 is already taken by Cedarhurst
const OUR_STATION_ID   = 'MTA.LIRR.Belmont';
const OUR_RAILWAY_ID   = 'MTA.LIRR.11';

function readCSV(path) {
    return parse(fs.readFileSync(path, 'utf8'), {columns: true, skip_empty_lines: true, trim: true});
}

// ── 1. Load 2015 source data ──────────────────────────────────────────────
const stops2015  = readCSV(`${LIRR_2015}/stops.txt`);
const shapes2015 = readCSV(`${LIRR_2015}/shapes.txt`);

const belmontStop = stops2015.find(s => s.stop_id === BELMONT_STOP_ID);
if (!belmontStop) throw new Error(`Stop ${BELMONT_STOP_ID} not found in 2015 data`);
console.log(`Found stop: ${belmontStop.stop_name} (${belmontStop.stop_lat}, ${belmontStop.stop_lon})`);

const spurPts = shapes2015
    .filter(p => p.shape_id === BELMONT_SHAPE_ID)
    .sort((a, b) => +a.shape_pt_sequence - +b.shape_pt_sequence);
if (spurPts.length === 0) throw new Error(`Shape ${BELMONT_SHAPE_ID} not found in 2015 data`);
console.log(`Found shape ${BELMONT_SHAPE_ID}: ${spurPts.length} points`);

// Shape 160 runs Belmont→Jamaica-junction; reverse so it's junction→Belmont (ascending)
const spurCoords = spurPts
    .map(p => [parseFloat(p.shape_pt_lon), parseFloat(p.shape_pt_lat)])
    .reverse();
console.log(`Shape direction (reversed): [${spurCoords[0]}] → [${spurCoords[spurCoords.length-1]}]`);

// ── 2. Patch data/stations.json ──────────────────────────────────────────
const stationsPath = 'data/stations.json';
const stations = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));

if (stations.find(s => s.id === OUR_STATION_ID)) {
    console.log(`${OUR_STATION_ID} already in stations.json — skipping`);
} else {
    stations.push({
        id:      OUR_STATION_ID,
        railway: OUR_RAILWAY_ID,
        coord:   [parseFloat(belmontStop.stop_lon), parseFloat(belmontStop.stop_lat)],
        title:   {en: belmontStop.stop_name}
    });
    fs.writeFileSync(stationsPath, JSON.stringify(stations, null, '\t'), 'utf8');
    console.log(`Added ${OUR_STATION_ID} to stations.json`);
}

// ── 3. Patch data/railways.json ──────────────────────────────────────────
const railwaysPath = 'data/railways.json';
const railways = JSON.parse(fs.readFileSync(railwaysPath, 'utf8'));

const lirr11 = railways.find(r => r.id === OUR_RAILWAY_ID);
if (!lirr11) throw new Error(`${OUR_RAILWAY_ID} not found in railways.json`);

if (lirr11.stations.length > 0) {
    console.log(`${OUR_RAILWAY_ID} already has stations: ${lirr11.stations} — skipping`);
} else {
    lirr11.stations = [OUR_STATION_ID];
    fs.writeFileSync(railwaysPath, JSON.stringify(railways, null, '\t'), 'utf8');
    console.log(`Set ${OUR_RAILWAY_ID}.stations = ['${OUR_STATION_ID}']`);
}

// ── 4. Patch data/coordinates.json ───────────────────────────────────────
const coordPath = 'data/coordinates.json';
let coordData = {airways: [], railways: []};
try { coordData = JSON.parse(fs.readFileSync(coordPath, 'utf8')); } catch { /* absent */ }

const existing = coordData.railways.find(r => r.id === OUR_RAILWAY_ID);
if (existing) {
    console.log(`${OUR_RAILWAY_ID} already in coordinates.json — replacing`);
    coordData.railways = coordData.railways.filter(r => r.id !== OUR_RAILWAY_ID);
}

coordData.railways.push({
    id:      OUR_RAILWAY_ID,
    color:   lirr11.color || '#60269E',
    sublines: [{type: 'main', coords: spurCoords}]
});
fs.writeFileSync(coordPath, JSON.stringify(coordData, null, '\t'), 'utf8');
console.log(`Added ${OUR_RAILWAY_ID} shape to coordinates.json (${spurCoords.length} pts)`);

console.log('\nDone. Run next: npm run build-data');
