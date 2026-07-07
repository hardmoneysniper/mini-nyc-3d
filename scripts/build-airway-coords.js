'use strict';
/**
 * scripts/build-airway-coords.js
 *
 * Reads data/runways.csv (OurAirports format) and writes the airways section of
 * data/coordinates.json for JFK (KJFK), LGA (KLGA), and EWR (KEWR).
 * The railways section of the existing file is preserved.
 *
 * Route ID scheme: <ICAO>.<runway_ident>.<Arr|Dep>
 *   e.g. KJFK.13L.Arr, KJFK.31R.Dep, KLGA.31.Arr, KEWR.22L.Dep
 *
 * Coordinate geometry (straight-line ILS glideslope approximation):
 *   Each runway end gets a waypoint 10 NM beyond it along the runway axis.
 *   Arr: [waypoint_outside, threshold, opposite_end]  (aircraft lands, rolls out)
 *   Dep: [threshold, opposite_end, waypoint_outside]  (aircraft rolls, lifts off)
 *
 * Usage:
 *   node scripts/build-airway-coords.js
 */

const fs   = require('fs');
const path = require('path');

const NYC_AIRPORTS = new Set(['KJFK', 'KLGA', 'KEWR']);
const APPROACH_NM  = 10;   // nautical miles from threshold to animation waypoint
const ALT_MARKER   = 1000; // altitude code for the off-runway animation waypoint (ground = 0)

/**
 * Offset [lon, lat] by distNm nautical miles in direction bearingDeg (true).
 * Uses the spherical approximation valid for short distances (~10 NM).
 */
function offsetNm(lon, lat, distNm, bearingDeg) {
    const rad    = bearingDeg * Math.PI / 180;
    const latRad = lat        * Math.PI / 180;
    const dLat   = distNm * Math.cos(rad) / 60;
    const dLon   = distNm * Math.sin(rad) / (60 * Math.cos(latRad));
    return [+(lon + dLon).toFixed(7), +(lat + dLat).toFixed(7)];
}

function parseCSV(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8')
        .split('\n').map(l => l.trim()).filter(Boolean);
    const headers = lines[0].replace(/"/g, '').split(',');
    return lines.slice(1).map(line => {
        const values = line.replace(/"/g, '').split(',');
        const row = {};
        headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
        return row;
    });
}

function main() {
    const rows      = parseCSV(path.join('data', 'runways.csv'));
    const coordPath = path.join('data', 'coordinates.json');
    const airways   = [];

    for (const row of rows) {
        if (!NYC_AIRPORTS.has(row.airport_ident)) continue;
        if (row.closed === '1') continue;

        const leId  = row.le_ident;
        const heId  = row.he_ident;
        const leLon = parseFloat(row.le_longitude_deg);
        const leLat = parseFloat(row.le_latitude_deg);
        const heLon = parseFloat(row.he_longitude_deg);
        const heLat = parseFloat(row.he_latitude_deg);
        const leHdg = parseFloat(row.le_heading_degT); // from le toward he

        if (!leId || !heId) continue;
        if ([leLon, leLat, heLon, heLat, leHdg].some(v => !isFinite(v))) continue;

        const heHdg = (leHdg + 180) % 360;   // from he toward le
        const icao  = row.airport_ident;

        // Animation waypoints 10 NM beyond each runway end along the runway axis.
        // leWaypoint: 10 NM outward from the le end (away from runway) — used by:
        //   • LE Arrival approach start (aircraft comes from this direction)
        //   • HE Departure climb-out endpoint (aircraft climbs toward this point)
        const leWaypoint = offsetNm(leLon, leLat, APPROACH_NM, heHdg);

        // heWaypoint: 10 NM outward from the he end (away from runway) — used by:
        //   • HE Arrival approach start
        //   • LE Departure climb-out endpoint
        const heWaypoint = offsetNm(heLon, heLat, APPROACH_NM, leHdg);

        // LE runway arrival: approach from leWaypoint side → touch down at le → roll to he
        airways.push({
            id: `${icao}.${leId}.Arr`,
            coords: [[...leWaypoint, ALT_MARKER], [leLon, leLat, 0], [heLon, heLat, 0]],
            color: '#0000FF'
        });

        // LE runway departure: line up at le → roll toward he → climb to heWaypoint
        airways.push({
            id: `${icao}.${leId}.Dep`,
            coords: [[leLon, leLat, 0], [heLon, heLat, 0], [...heWaypoint, ALT_MARKER]],
            color: '#FF0000'
        });

        // HE runway arrival: approach from heWaypoint side → touch down at he → roll to le
        airways.push({
            id: `${icao}.${heId}.Arr`,
            coords: [[...heWaypoint, ALT_MARKER], [heLon, heLat, 0], [leLon, leLat, 0]],
            color: '#0000FF'
        });

        // HE runway departure: line up at he → roll toward le → climb to leWaypoint
        airways.push({
            id: `${icao}.${heId}.Dep`,
            coords: [[heLon, heLat, 0], [leLon, leLat, 0], [...leWaypoint, ALT_MARKER]],
            color: '#FF0000'
        });
    }

    // Preserve railways section from current coordinates.json
    const existing = JSON.parse(fs.readFileSync(coordPath, 'utf8'));
    fs.writeFileSync(coordPath, JSON.stringify(
        {airways, railways: existing.railways || []},
        null, '\t'
    ), 'utf8');

    console.log(`\nWrote ${airways.length} airway route entries to data/coordinates.json`);
    for (const a of airways) console.log(`  ${a.id}`);
}

main();
