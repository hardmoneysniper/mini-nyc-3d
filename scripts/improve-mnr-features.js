#!/usr/bin/env node
'use strict';
/**
 * scripts/improve-mnr-features.js
 *
 * Builds real track geometry for MNR lines from two sources:
 *   1. Local 2020 GTFS from data/metro_north/ (highest detail)
 *   2. Live MNR GTFS download (most current routing)
 * For each line, uses whichever source has more shape points.
 * Updates data/coordinates.json so `npm run build-data` creates
 * proper curved track features matching the style of Subway/LIRR lines.
 *
 * After this script succeeds, run:
 *   npm run build-data
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const AdmZip = require('adm-zip');
const {parse} = require('csv-parse/sync');

const MNR_GTFS_URL = 'https://web.mta.info/developers/data/mnr/google_transit.zip';
const LOCAL_GTFS   = 'data/metro_north';

function haversine([lng1, lat1], [lng2, lat2]) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Align shape direction so stations ascend from shape-start to shape-end.
 * Uses combined distance: sum of (first_station ↔ shape_start) + (last_station ↔ shape_end).
 * Reverses if the reversed direction gives a smaller combined distance.
 * This handles shapes that extend beyond the route's stations in either direction.
 */
function alignShapeToStations(coords, stationCoords) {
    if (!stationCoords || stationCoords.length < 2) return coords;
    const first = stationCoords[0];
    const last  = stationCoords[stationCoords.length - 1];
    const shapeStart = coords[0];
    const shapeEnd   = coords[coords.length - 1];

    const fwdCost = haversine(shapeStart, first) + haversine(shapeEnd, last);
    const revCost = haversine(shapeEnd,   first) + haversine(shapeStart, last);

    if (revCost < fwdCost) {
        return coords.slice().reverse();
    }
    return coords;
}

function download(url, depth = 0) {
    if (depth > 5) return Promise.reject(new Error(`Too many redirects: ${url}`));
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, {headers: {'User-Agent': 'mini-nyc-3d/0.1.0'}}, res => {
            const {statusCode, headers} = res;
            if (statusCode >= 300 && statusCode < 400 && headers.location) {
                res.resume();
                return resolve(download(headers.location, depth + 1));
            }
            if (statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${statusCode} from ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function parseCSV(text) {
    return parse(text, {columns: true, skip_empty_lines: true, trim: true});
}

function parseZipCSV(zip, filename) {
    const entry = zip.getEntry(filename);
    return entry ? parseCSV(entry.getData().toString('utf8')) : [];
}

function parseFileCSV(dir, filename) {
    const p = `${dir}/${filename}`;
    return fs.existsSync(p) ? parseCSV(fs.readFileSync(p, 'utf8')) : [];
}

/** Returns Map<route_id, [[lng, lat], ...]> picking the best shape per route */
function extractBestShapes(routesData, tripsData, shapesData) {
    // shape_id → sorted coords
    const shapePoints = new Map();
    for (const pt of shapesData) {
        if (!shapePoints.has(pt.shape_id)) shapePoints.set(pt.shape_id, []);
        shapePoints.get(pt.shape_id).push(pt);
    }
    for (const arr of shapePoints.values()) {
        arr.sort((a, b) => +a.shape_pt_sequence - +b.shape_pt_sequence);
    }

    // route_id → Map<shape_id, tripCount>
    const routeShapeCounts = new Map();
    for (const trip of tripsData) {
        if (!trip.shape_id) continue;
        if (!routeShapeCounts.has(trip.route_id)) routeShapeCounts.set(trip.route_id, new Map());
        const m = routeShapeCounts.get(trip.route_id);
        m.set(trip.shape_id, (m.get(trip.shape_id) || 0) + 1);
    }

    const result = new Map(); // route_id → coords[]
    for (const route of routesData) {
        const {route_id} = route;
        const shapeCounts = routeShapeCounts.get(route_id);
        if (!shapeCounts || shapeCounts.size === 0) continue;

        // Prefer shape used by most trips; tiebreak by point count
        let bestShapeId = null, bestScore = -1;
        for (const [shapeId, tripCount] of shapeCounts) {
            const pts = shapePoints.get(shapeId);
            if (!pts) continue;
            const score = tripCount * 100000 + pts.length;
            if (score > bestScore) { bestScore = score; bestShapeId = shapeId; }
        }

        if (!bestShapeId) continue;
        const pts = shapePoints.get(bestShapeId);
        result.set(route_id, {
            shapeId: bestShapeId,
            coords: pts.map(p => [parseFloat(p.shape_pt_lon), parseFloat(p.shape_pt_lat)])
        });
    }
    return result;
}

async function main() {
    // Load local 2020 GTFS
    console.log(`Loading local 2020 GTFS from ${LOCAL_GTFS}/`);
    const localRoutes = parseFileCSV(LOCAL_GTFS, 'routes.txt');
    const localTrips  = parseFileCSV(LOCAL_GTFS, 'trips.txt');
    const localShapes = parseFileCSV(LOCAL_GTFS, 'shapes.txt');
    const localBest   = extractBestShapes(localRoutes, localTrips, localShapes);
    console.log(`  ${localRoutes.length} routes, ${localTrips.length} trips, ${localShapes.length} shape points`);

    // Download live GTFS
    console.log(`Downloading live GTFS from ${MNR_GTFS_URL}`);
    const buf = await download(MNR_GTFS_URL);
    console.log(`  Downloaded ${(buf.length / 1e6).toFixed(1)} MB`);
    const zip = new AdmZip(buf);
    const liveRoutes = parseZipCSV(zip, 'routes.txt');
    const liveTrips  = parseZipCSV(zip, 'trips.txt');
    const liveShapes = parseZipCSV(zip, 'shapes.txt');
    const liveBest   = extractBestShapes(liveRoutes, liveTrips, liveShapes);
    console.log(`  ${liveRoutes.length} routes, ${liveTrips.length} trips, ${liveShapes.length} shape points`);

    // Load railways and stations for direction alignment
    const railways = JSON.parse(fs.readFileSync('data/railways.json', 'utf8'));
    const stationsData = JSON.parse(fs.readFileSync('data/stations.json', 'utf8'));
    const rwById = {}, stById = {};
    for (const rw of railways) rwById[rw.id] = rw;
    for (const st of stationsData) stById[st.id] = st;

    // Load current coordinates.json — preserve non-MNR entries
    let coordData = {airways: [], railways: []};
    try { coordData = JSON.parse(fs.readFileSync('data/coordinates.json', 'utf8')); } catch { /* absent */ }
    coordData.railways = (coordData.railways || []).filter(r => !r.id.startsWith('MTA.MNR.'));

    const TARGET_ROUTES = ['1', '2', '3', '4', '5', '6'];
    let added = 0;

    for (const routeId of TARGET_ROUTES) {
        const ourId = `MTA.MNR.${routeId}`;
        const rw = rwById[ourId];

        const local = localBest.get(routeId);
        const live  = liveBest.get(routeId);

        let chosen = null, source = '';

        if (local && live) {
            if (local.coords.length >= live.coords.length) {
                chosen = local; source = `local 2020 (shape ${local.shapeId}, ${local.coords.length} pts)`;
            } else {
                chosen = live; source = `live GTFS (shape ${live.shapeId}, ${live.coords.length} pts)`;
            }
        } else if (local) {
            chosen = local; source = `local 2020 only (shape ${local.shapeId}, ${local.coords.length} pts)`;
        } else if (live) {
            chosen = live; source = `live GTFS only (shape ${live.shapeId}, ${live.coords.length} pts)`;
        } else {
            console.warn(`  ${ourId}: no shape data in either source — skipping`);
            continue;
        }

        // Align shape direction to match ascending station order
        const stationCoords = (rw ? rw.stations : [])
            .map(sid => stById[sid] && stById[sid].coord)
            .filter(Boolean);
        const alignedCoords = alignShapeToStations(chosen.coords, stationCoords);
        const wasReversed = alignedCoords !== chosen.coords;

        coordData.railways.push({
            id: ourId,
            color: rw ? rw.color : '#888888',
            sublines: [{type: 'main', coords: alignedCoords}]
        });

        const title = rw ? rw.title.en : routeId;
        const reversed = wasReversed ? ' [reversed to align with stations]' : '';
        console.log(`  ${ourId} (${title}): using ${source}${reversed}`);
        added++;
    }

    fs.writeFileSync('data/coordinates.json', JSON.stringify(coordData, null, '\t'), 'utf8');
    console.log(`\nUpdated data/coordinates.json with ${added} MNR shapes`);
    console.log('Run next: npm run build-data');
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
