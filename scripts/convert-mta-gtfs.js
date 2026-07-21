'use strict';
/**
 * scripts/convert-mta-gtfs.js
 *
 * Converts MTA GTFS static feeds into the mini-nyc-3d data format consumed
 * by the build pipeline. Subway and MNR read from local GTFS snapshots
 * (data/gtfs_subway/, data/metro_north/); LIRR live-downloads (its local
 * snapshot is incomplete — routes/shapes/stops only, no trip schedule data).
 * See the FEEDS definition below for why.
 *
 * Usage:
 *   node scripts/convert-mta-gtfs.js
 *
 * Outputs:
 *   data/railways.json
 *   data/stations.json
 *   data/station-groups.json
 *   data/coordinates.json  (railways section from shapes.txt)
 *   data/train-timetables/<route>.json
 *
 * Memory note: stop_times.txt uncompressed can exceed 100 MB for the
 * full subway. Expect ~300–500 MB peak RSS during processing.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const AdmZip = require('adm-zip');
const {parse} = require('csv-parse/sync');
const {readJSON, writeJSON, mergeArrayById, mergeStationGroups} = require('./lib/gtfs-merge');
const {buildServiceCalendar} = require('./lib/gtfs-calendar');

// ---------------------------------------------------------------------------
// Feed definitions
//
// Subway and MNR read from local GTFS snapshots (data/gtfs_subway/,
// data/metro_north/) rather than a live download — both are complete
// (routes/trips/stop_times/shapes/stops all present) and, for Subway,
// current (feed_info.txt covers today). Mixing a live download's trips.txt
// with an older local shapes.txt would risk shape_id collisions across feed
// generations (the same numeric ID can mean a different physical path in a
// different feed version), so when local data is used it's used for
// everything in that feed, not spliced with live data.
//
// LIRR's local snapshot (data/lirr/) only has routes/shapes/stops — no
// trips.txt or stop_times.txt — so it can't stand in for a full conversion;
// LIRR keeps live-downloading.
// ---------------------------------------------------------------------------
const FEEDS = [
    {
        service: 'Subway',
        localDir: 'data/gtfs_subway',
        carComposition: 10
    },
    {
        service: 'LIRR',
        url: 'https://web.mta.info/developers/data/lirr/google_transit.zip',
        carComposition: 8
    },
    {
        service: 'MNR',
        localDir: 'data/metro_north',
        carComposition: 6
    }
];

// direction_id 0 / 1 labels per service
const DIRECTIONS = {
    Subway: ['Uptown',   'Downtown'],
    LIRR:   ['Outbound', 'Inbound'],
    MNR:    ['Outbound', 'Inbound']
};

const TRAIN_TYPE = {
    Subway: 'MTA.Local',
    LIRR:   'MTA.Regional',
    MNR:    'MTA.Regional'
};

// Subway/LIRR keep their own real per-route GTFS color for both the route
// line and the train marker (single `color` field) — Subway's are
// meaningful (different colors distinguish trunk lines) and LIRR's already
// read as a consistent single blue in practice.
//
// MNR renders the track/route line in black while the train marker uses
// each line's real GTFS route_color (Hudson green, Harlem blue, New Haven
// red) via the separate `trainColor` field — see its consumer in
// src/map.js's colorData construction, which falls back to `color` when
// `trainColor` is absent (every other operator here has no trainColor and
// is unaffected). `trainColor` must also be threaded through
// src/data-classes/railway.js's constructor, which otherwise silently
// drops any field it doesn't explicitly know about — this bit a first
// attempt at this feature, where the field never reached runtime and MNR
// trains rendered black (the `color` fallback) instead of their real color.
const MNR_ROUTE_COLOR = '#000000';
function railwayColor(service, route) {
    if (service === 'MNR') return MNR_ROUTE_COLOR;
    return route.route_color ? `#${route.route_color}` : '#888888';
}
function railwayTrainColor(service, route) {
    if (service === 'MNR') return route.route_color ? `#${route.route_color}` : MNR_ROUTE_COLOR;
    return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** HTTP/HTTPS GET with redirect following, returns Buffer */
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

function parseCSV(zip, filename, required = true) {
    const entry = zip.getEntry(filename);
    if (!entry) {
        if (required) throw new Error(`Missing GTFS file: ${filename}`);
        return [];
    }
    return parse(entry.getData().toString('utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });
}

function parseLocalCSV(dir, filename, required = true) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) {
        if (required) throw new Error(`Missing GTFS file: ${filePath}`);
        return [];
    }
    return parse(fs.readFileSync(filePath, 'utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });
}

/** Strip directional suffix N/S from NYC subway stop IDs (Subway only) */
function normStop(rawId, service) {
    const id = service === 'Subway' ? rawId.replace(/[NS]$/, '') : rawId;
    return `MTA.${service}.${id}`;
}
function normRoute(rawId, service) { return `MTA.${service}.${rawId}`; }
function normTrip(rawId, service) {
    // NYC Subway GTFS-RT trip_ids omit the schedule-reference prefix
    // (e.g. "ASP26GEN-1038-Weekday-00_") that static GTFS includes.
    // Strip everything up to and including the first "_" for Subway so IDs match at runtime.
    const id = service === 'Subway' ? rawId.replace(/^[^_]+_/, '') : rawId;
    return `MTA.${service}.${id}`;
}

// ---------------------------------------------------------------------------
// Per-feed processor
// ---------------------------------------------------------------------------
async function processFeed({service, url, localDir, carComposition}) {
    let readCSV;
    if (localDir) {
        console.log(`\n[${service}] Reading local GTFS snapshot from ${localDir}/ ...`);
        readCSV = (filename, required) => parseLocalCSV(localDir, filename, required);
    } else {
        console.log(`\n[${service}] Downloading ${url} ...`);
        const buf = await download(url);
        console.log(`[${service}] ${(buf.length / 1e6).toFixed(1)} MB downloaded. Parsing...`);
        const zip = new AdmZip(buf);
        readCSV = (filename, required) => parseCSV(zip, filename, required);
    }

    const routes       = readCSV('routes.txt');
    const stops        = readCSV('stops.txt');
    const trips        = readCSV('trips.txt');
    const calendar     = readCSV('calendar.txt', false);
    const calendarDates = readCSV('calendar_dates.txt', false);
    const transfers    = readCSV('transfers.txt', false);
    const shapes       = readCSV('shapes.txt', false);

    // stop_times.txt is the large one — warn then parse
    console.log(`[${service}] Parsing stop_times.txt (this may take a moment)...`);
    const stopTimes = readCSV('stop_times.txt');
    console.log(`[${service}] ${stopTimes.length.toLocaleString()} stop-time rows loaded.`);

    // --- calendar lookup: service_id → type ---
    const {svcCal, repDates} = buildServiceCalendar(calendar, calendarDates);
    if (repDates.length > 0) {
        console.log(`[${service}] calendar_dates: representative dates selected: ${repDates.join(', ')}`);
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
    for (const trip of trips) {
        if (!tripsByRoute.has(trip.route_id)) tripsByRoute.set(trip.route_id, []);
        tripsByRoute.get(trip.route_id).push(trip);
    }

    const dirs      = DIRECTIONS[service];
    const trainType = TRAIN_TYPE[service];

    // --- railways + station order ---
    //
    // A single "representative trip" per route silently drops real branches:
    // MTA's live GTFS assigns distinct shape_ids to genuinely different trip
    // patterns on branching lines (Subway A -> Rockaway Park/Far Rockaway,
    // LIRR Port Jefferson branching off at Hicksville, etc.), and picking
    // only one representative trip means whichever branch that trip doesn't
    // run never makes it into railways.json/coordinates.json at all.
    //
    // Fix: consider every distinct shape used by any trip on the route.
    // Sort by station count (longest first), then greedily keep a shape only
    // if it visits at least one station not already covered by a
    // previously-kept shape. Routes with one physical track collapse back to
    // a single entry (every later shape is a subset of the first); routes
    // with genuine branches keep one entry per branch. This codebase's
    // "sublines" are sequential segments of one continuous path (used to
    // offset parallel track), not a fork, so a true branch needs its own
    // railway id — the base (longest) branch keeps the plain route id so
    // real-time GTFS-RT trip updates (route_id only, no shape_id) keep
    // resolving to it; additional branches get <routeId>.b2, .b3, etc.
    const railways = [];
    const routeStations = new Map(); // railway id (incl. branch suffixes) -> [normStopId, ...]
    const routeShapeSelections = new Map(); // railway id -> shape_id, for the shapes pass below

    for (const route of routes) {
        const routeTrips = tripsByRoute.get(route.route_id) || [];

        // Multiple trips can share one shape_id (same physical track) while
        // stopping at very different subsets of its stations (e.g. an
        // express vs. a local using the same geometry, or a short-turn
        // trip vs. a full-length one) — picking an arbitrary trip per
        // shape_id silently drops whichever stations only appear on a
        // longer trip sharing that shape. Keep the trip with the most
        // stop_times rows instead — the fullest/local pattern is a
        // superset of every shorter trip on the same shape in practice, so
        // this maximizes real station coverage without changing which
        // shape's geometry gets used. (Found and fixed here after this
        // exact bug was found dropping real NJT stations in
        // scripts/convert-njt-gtfs.js — not yet re-verified against a
        // fresh MTA regeneration given this data's history of regressions;
        // see the restoration pipeline this script's data still depends on.)
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
                const sid = normStop(st.stop_id, service);
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

        if (selected.length === 0) {
            // No trips at all right now (e.g. LIRR.11 Belmont Park — seasonal
            // service the live GTFS omits entirely outside event dates).
            // Keep the old behavior of emitting an empty placeholder rather
            // than dropping the route, so a dedicated patch script (e.g.
            // scripts/patch-lirr11-belmont.js) can still find and populate it.
            const baseId = normRoute(route.route_id, service);
            routeStations.set(baseId, []);
            railways.push({
                id:            baseId,
                title:         {en: route.route_long_name || route.route_short_name || route.route_id},
                stations:      [],
                ascending:     dirs[0],
                descending:    dirs[1],
                color:         railwayColor(service, route),
                trainColor:    railwayTrainColor(service, route),
                carComposition
            });
        }

        selected.forEach((cand, i) => {
            const baseId = normRoute(route.route_id, service);
            const railwayId = i === 0 ? baseId : `${baseId}.b${i + 1}`;

            routeStations.set(railwayId, cand.stationList);
            routeShapeSelections.set(railwayId, cand.shapeId);

            railways.push({
                id:            railwayId,
                title:         {en: route.route_long_name || route.route_short_name || route.route_id},
                stations:      cand.stationList,
                ascending:     dirs[0],
                descending:    dirs[1],
                color:         railwayColor(service, route),
                trainColor:    railwayTrainColor(service, route),
                carComposition
            });
        });
    }

    // --- stations (de-duplicated by normalised stop ID) ---
    const stationMap = new Map();
    for (const stop of stops) {
        const sid      = normStop(stop.stop_id, service);
        if (stationMap.has(sid)) continue;
        // Find the first route that lists this station
        let railway = null;
        for (const [rId, list] of routeStations) {
            if (list.includes(sid)) { railway = rId; break; }
        }
        if (!railway) continue;
        stationMap.set(sid, {
            id:      sid,
            railway,
            coord:   [parseFloat(stop.stop_lon), parseFloat(stop.stop_lat)],
            title:   {en: stop.stop_name}
        });
    }

    // --- timetables (keyed by raw route_id for file naming) ---
    const timetablesByRoute = new Map();
    for (const trip of trips) {
        const sts = stsByTrip.get(trip.trip_id);
        if (!sts || sts.length === 0) continue;

        const routeId = normRoute(trip.route_id, service);
        const tripId  = normTrip(trip.trip_id, service);
        const cal     = svcCal.get(trip.service_id);
        // For calendar_dates-only feeds, skip trips not in the representative set
        if (svcCal._calendarDatesOnly && !cal) continue;
        const calType2 = cal || 'Weekday';
        const dir     = dirs[trip.direction_id === '1' ? 1 : 0];

        const tt = sts.map(st => ({
            s: normStop(st.stop_id, service),
            d: st.departure_time.slice(0, 5)
        }));

        const entry = {
            id: `${tripId}.${calType2}`,
            t:  tripId,
            r:  routeId,
            n:  trip.trip_short_name || trip.trip_id,
            y:  trainType,
            d:  dir,
            os: [tt[0].s],
            tt
        };

        if (!timetablesByRoute.has(trip.route_id)) timetablesByRoute.set(trip.route_id, []);
        timetablesByRoute.get(trip.route_id).push(entry);
    }

    // --- track shapes from shapes.txt ---
    // Group shape points by shape_id
    const shapePoints = new Map();
    for (const pt of shapes) {
        if (!shapePoints.has(pt.shape_id)) shapePoints.set(pt.shape_id, []);
        shapePoints.get(pt.shape_id).push(pt);
    }
    for (const arr of shapePoints.values()) {
        arr.sort((a, b) => +a.shape_pt_sequence - +b.shape_pt_sequence);
    }

    // Map railway (incl. branch suffixes) → shape (captured in the routes loop above)
    const railwayShapes = [];
    for (const [railwayId, shapeId] of routeShapeSelections) {
        const pts = shapePoints.get(shapeId);
        if (!pts || pts.length === 0) continue;

        railwayShapes.push({
            id: railwayId,
            sublines: [{
                type:   'main',
                coords: pts.map(p => [parseFloat(p.shape_pt_lon), parseFloat(p.shape_pt_lat)])
            }]
        });
    }

    // --- station groups from transfers.txt ---
    const merged = new Map(); // normStopId → groupKey
    for (const xfer of transfers) {
        const from = normStop(xfer.from_stop_id, service);
        const to   = normStop(xfer.to_stop_id,   service);
        if (from === to) continue;

        const fk = merged.get(from);
        const tk = merged.get(to);

        if (!fk && !tk) {
            merged.set(from, from);
            merged.set(to,   from);
        } else if (fk && !tk) {
            merged.set(to, fk);
        } else if (!fk && tk) {
            merged.set(from, tk);
        } else if (fk !== tk) {
            for (const [k, v] of merged) { if (v === tk) merged.set(k, fk); }
        }
    }
    const groupSets = new Map();
    for (const [sid, gk] of merged) {
        if (!groupSets.has(gk)) groupSets.set(gk, new Set());
        groupSets.get(gk).add(sid);
    }
    const stationGroups = [];
    for (const set of groupSets.values()) {
        if (set.size > 1) stationGroups.push([Array.from(set)]);
    }

    console.log(`[${service}] ${railways.length} routes | ${stationMap.size} stations | ${trips.length} trips | ${stationGroups.length} transfer groups | ${railwayShapes.length} shapes`);

    return {
        railways,
        stations:         Array.from(stationMap.values()),
        timetablesByRoute,
        stationGroups,
        railwayShapes
    };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
    const allRailways      = [];
    const allStations      = [];
    const allStationGroups = [];
    const allRailwayShapes = [];
    const allTimetables    = new Map(); // '<Service>.<routeId>' → entries[]

    const succeededServices = new Set();

    for (const feed of FEEDS) {
        try {
            const result = await processFeed(feed);
            allRailways.push(...result.railways);
            allStations.push(...result.stations);
            allStationGroups.push(...result.stationGroups);
            allRailwayShapes.push(...result.railwayShapes);
            for (const [rId, entries] of result.timetablesByRoute) {
                allTimetables.set(`${feed.service}.${rId}`, entries);
            }
            succeededServices.add(feed.service);
        } catch (err) {
            console.error(`\n[${feed.service}] FAILED: ${err.message}`);
            console.error('  Skipping and continuing with remaining feeds...');
        }
    }

    // railways.json — merge-write: keep any non-MTA (e.g. NJT) entries already on disk
    const mergedRailways = mergeArrayById(readJSON('data/railways.json', []), allRailways, 'MTA');
    writeJSON('data/railways.json', mergedRailways);
    console.log(`\nWrote data/railways.json        (${allRailways.length} MTA railways, ${mergedRailways.length} total)`);

    // stations.json
    const mergedStations = mergeArrayById(readJSON('data/stations.json', []), allStations, 'MTA');
    writeJSON('data/stations.json', mergedStations);
    console.log(`Wrote data/stations.json        (${allStations.length} MTA stations, ${mergedStations.length} total)`);

    // station-groups.json
    const mergedGroups = mergeStationGroups(readJSON('data/station-groups.json', []), allStationGroups, 'MTA');
    writeJSON('data/station-groups.json', mergedGroups);
    console.log(`Wrote data/station-groups.json  (${allStationGroups.length} MTA groups, ${mergedGroups.length} total)`);

    // coordinates.json — preserve existing airways, merge railways with NYC shapes
    const existingCoords = readJSON('data/coordinates.json', {airways: [], railways: []});
    const mergedShapes = mergeArrayById(existingCoords.railways || [], allRailwayShapes, 'MTA');
    writeJSON('data/coordinates.json', {
        airways:  existingCoords.airways || [],
        railways: mergedShapes
    });
    console.log(`Wrote data/coordinates.json     (${allRailwayShapes.length} MTA shapes, ${mergedShapes.length} total, ${(existingCoords.airways || []).length} airways preserved)`);

    // train-timetables/*.json — clear only files belonging to feeds that succeeded,
    // then write the new ones. This prevents partial failures from wiping data for
    // feeds that were not even attempted.
    const ttDir = 'data/train-timetables';
    if (succeededServices.size === 0) {
        console.warn('WARNING: All feeds failed — timetable directory unchanged.');
    } else {
        // Build a filename prefix set for services that succeeded
        const prefixesToClear = new Set(
            [...succeededServices].map(s => s.toLowerCase())
        );
        let cleared = 0;
        for (const f of fs.readdirSync(ttDir).filter(f => f.endsWith('.json'))) {
            // Each timetable filename starts with "<service>-..." e.g. "subway-a.json"
            if ([...prefixesToClear].some(p => f.startsWith(p))) {
                fs.unlinkSync(path.join(ttDir, f));
                cleared++;
            }
        }
        if (cleared > 0) console.log(`Cleared ${cleared} old timetable files for: ${[...succeededServices].join(', ')}.`);

        for (const [routeKey, entries] of allTimetables) {
            const fileName = routeKey.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
            writeJSON(path.join(ttDir, fileName), entries);
        }
        console.log(`Wrote ${allTimetables.size} timetable files → ${ttDir}/`);
    }

    console.log('\n✓ Done! Run "npm run build-data" next to compile into build/.');
}

main().catch(err => {
    console.error('\nFatal:', err.message);
    process.exit(1);
});
