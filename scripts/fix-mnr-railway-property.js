#!/usr/bin/env node
'use strict';
/**
 * scripts/fix-mnr-railway-property.js
 *
 * The update-mnr-stations.js script added new MNR stations with
 * `railway: 'MTA.MNR.1'` as a placeholder. But stations exclusive to
 * Harlem (MNR.2) or New Haven (MNR.3) must have the correct railway ID so
 * the feature builder includes them in the right line's stop-circle offsets.
 *
 * Rule: for each station, if it has railway=MNR.1 but is NOT in MNR.1's
 * station list, set railway to the lowest-numbered MNR line that does list it.
 * Stations already on MNR.1 (Hudson line) keep their assignment.
 */

const fs   = require('fs');
const path = require('path');

const stationsPath = path.join('data', 'stations.json');
const railwaysPath = path.join('data', 'railways.json');

const stations = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));
const railways = JSON.parse(fs.readFileSync(railwaysPath, 'utf8'));

// Build a map: stationId → [ordered list of MNR line IDs that include it]
// Lines are sorted 1-6 so "lowest" = most trunk-level line
const stationLines = new Map();
for (const rw of railways) {
    if (!rw.id.startsWith('MTA.MNR.')) continue;
    for (const sid of (rw.stations || [])) {
        if (!stationLines.has(sid)) stationLines.set(sid, []);
        stationLines.get(sid).push(rw.id);
    }
}

const mnr1Stations = new Set(
    (railways.find(r => r.id === 'MTA.MNR.1')?.stations) || []
);

let fixed = 0;
for (const station of stations) {
    if (!station.id.startsWith('MTA.MNR.')) continue;
    if (station.railway !== 'MTA.MNR.1') continue; // already correct or assigned by the original dataset
    if (mnr1Stations.has(station.id)) continue;    // legitimately on MNR.1, leave it

    // This station has the MNR.1 placeholder but isn't on the Hudson line
    const lines = stationLines.get(station.id) || [];
    if (lines.length > 0) {
        station.railway = lines[0]; // lowest-numbered MNR line that lists this station
        fixed++;
        console.log(`${station.id} (${station.title?.en}) → railway: ${station.railway}`);
    }
}

fs.writeFileSync(stationsPath, JSON.stringify(stations, null, '\t'), 'utf8');
console.log(`\nFixed ${fixed} station railway assignments.`);
console.log('Run next: npm run build-data');
