#!/usr/bin/env node
'use strict';
const fs = require('fs');
const zlib = require('zlib');

function haversine([lng1, lat1], [lng2, lat2]) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing([lng1, lat1], [lng2, lat2]) {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const lat1r = lat1 * Math.PI / 180;
    const lat2r = lat2 * Math.PI / 180;
    return Math.atan2(
        Math.sin(dLng) * Math.cos(lat2r),
        Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLng)
    ) * 180 / Math.PI;
}

const stations = JSON.parse(fs.readFileSync('data/stations.json', 'utf8'));
const railways = JSON.parse(fs.readFileSync('data/railways.json', 'utf8'));
const stById = {};
for (const s of stations) stById[s.id] = s;

const buf = zlib.gunzipSync(fs.readFileSync('build/data/features.json.gz'));
const fc = JSON.parse(buf.toString('utf8'));

// Check which railways already have zoom-18 features
const existingIds = new Set(fc.features.map(f => f.properties.id));

const targets = ['MTA.MNR.1', 'MTA.MNR.2', 'MTA.MNR.3', 'MTA.MNR.4', 'MTA.MNR.5', 'MTA.MNR.6'];
let added = 0;

for (const rwId of targets) {
    if (existingIds.has(rwId + '.18')) {
        console.log('Already has features:', rwId);
        continue;
    }
    const rw = railways.find(r => r.id === rwId);
    if (!rw) {
        console.log('Railway not found:', rwId);
        continue;
    }
    const coords = (rw.stations || []).map(id => stById[id] && stById[id].coord).filter(Boolean);
    if (coords.length < 2) {
        console.log('Not enough coords for', rwId, '(', coords.length, ')');
        continue;
    }

    // Cumulative distances along line (km) = station-offsets
    const stationOffsets = [0];
    for (let i = 1; i < coords.length; i++) {
        stationOffsets.push(stationOffsets[i - 1] + haversine(coords[i - 1], coords[i]));
    }

    // distances array: [cumulative_km, bearing_deg, slope, pitch] per segment + trailing entry
    const distancesArr = [];
    let travelled = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        const b = bearing(coords[i], coords[i + 1]);
        const d = haversine(coords[i], coords[i + 1]);
        distancesArr.push([travelled, b, 0, 0]);
        travelled += d;
    }
    distancesArr.push([travelled, distancesArr[distancesArr.length - 1][1], 0, 0]);

    const color = rw.color || '#888888';

    for (const zoom of [13, 14, 15, 16, 17, 18]) {
        // Full-line feature (no altitude → featureLookup for animation)
        fc.features.push({
            type: 'Feature',
            properties: {
                id: rwId + '.' + zoom,
                type: 0,
                width: 8,
                zoom,
                'station-offsets': stationOffsets,
                distances: distancesArr
            },
            geometry: {type: 'LineString', coordinates: coords}
        });

        // Section features (altitude:0 → odpt source for visual rendering)
        for (let i = 0; i < coords.length - 1; i++) {
            fc.features.push({
                type: 'Feature',
                properties: {
                    id: rwId + '.og.' + zoom + '.' + i + '.0',
                    type: 0,
                    zoom,
                    altitude: 0,
                    color,
                    width: 8
                },
                geometry: {type: 'LineString', coordinates: [coords[i], coords[i + 1]]}
            });
        }
        added += 1 + (coords.length - 1);
    }

    console.log('Generated', rwId, '(' + rw.title.en + '): ' + coords.length + ' stations, ' + stationOffsets[stationOffsets.length - 1].toFixed(1) + ' km');
}

const out = zlib.gzipSync(Buffer.from(JSON.stringify(fc)));
fs.writeFileSync('build/data/features.json.gz', out);
console.log('Done. Added', added, 'features. New file size:', out.length, 'bytes');
