'use strict';
/**
 * scripts/convert-mta-gtfs.js
 *
 * Downloads MTA GTFS static feeds and converts them into the
 * mini-nyc-3d data format consumed by the build pipeline.
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

// ---------------------------------------------------------------------------
// Feed definitions
// ---------------------------------------------------------------------------
const FEEDS = [
    {
        service: 'Subway',
        url: 'https://web.mta.info/developers/data/nyct/subway/google_transit.zip',
        carComposition: 10
    },
    {
        service: 'LIRR',
        url: 'https://web.mta.info/developers/data/lirr/google_transit.zip',
        carComposition: 8
    },
    {
        service: 'MNR',
        url: 'https://web.mta.info/developers/data/mnr/google_transit.zip',
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

/** Map GTFS calendar row to our calendar type string */
function calType(row) {
    const sat = row.saturday === '1';
    const sun = row.sunday   === '1';
    if (sat && sun) return 'SaturdayHoliday';
    if (sat)        return 'Saturday';
    if (sun)        return 'Holiday';
    return 'Weekday';
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, '\t'), 'utf8');
}

// ---------------------------------------------------------------------------
// Per-feed processor
// ---------------------------------------------------------------------------
async function processFeed({service, url, carComposition}) {
    console.log(`\n[${service}] Downloading ${url} ...`);
    const buf = await download(url);
    console.log(`[${service}] ${(buf.length / 1e6).toFixed(1)} MB downloaded. Parsing...`);
    const zip = new AdmZip(buf);

    const routes       = parseCSV(zip, 'routes.txt');
    const stops        = parseCSV(zip, 'stops.txt');
    const trips        = parseCSV(zip, 'trips.txt');
    const calendar     = parseCSV(zip, 'calendar.txt', false);
    const calendarDates = parseCSV(zip, 'calendar_dates.txt', false);
    const transfers    = parseCSV(zip, 'transfers.txt', false);
    const shapes       = parseCSV(zip, 'shapes.txt', false);

    // stop_times.txt is the large one — warn then parse
    console.log(`[${service}] Parsing stop_times.txt (this may take a moment)...`);
    const stopTimes = parseCSV(zip, 'stop_times.txt');
    console.log(`[${service}] ${stopTimes.length.toLocaleString()} stop-time rows loaded.`);

    // --- calendar lookup: service_id → type ---
    const svcCal = new Map();
    for (const row of calendar) svcCal.set(row.service_id, calType(row));

    // For feeds that only use calendar_dates.txt (e.g. MNR), derive calendar type
    // from the day-of-week of the service date, but keep only ONE representative
    // date per calendar type (the nearest upcoming date) to avoid trip explosion.
    if (calendarDates.length > 0 && svcCal.size === 0) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Build date → [service_id] map (exception_type 1 = added)
        const dateToSids = new Map();
        for (const row of calendarDates) {
            if (row.exception_type !== '1') continue;
            const d = row.date; // 'YYYYMMDD'
            if (!dateToSids.has(d)) dateToSids.set(d, []);
            dateToSids.get(d).push(row.service_id);
        }

        // For each calendar type pick the first upcoming date
        const repSids = new Set();
        const found = {Weekday: false, Saturday: false, Holiday: false};

        for (const dateStr of [...dateToSids.keys()].sort()) {
            const year = +dateStr.slice(0, 4), mon = +dateStr.slice(4, 6) - 1, day = +dateStr.slice(6, 8);
            const d = new Date(year, mon, day);
            if (d < today) continue; // skip past dates
            const dow = d.getDay(); // 0=Sun, 6=Sat
            const type = dow === 0 ? 'Holiday' : dow === 6 ? 'Saturday' : 'Weekday';
            if (!found[type]) {
                found[type] = true;
                for (const sid of dateToSids.get(dateStr)) svcCal.set(sid, type);
                repSids.add(dateStr);
            }
            if (found.Weekday && found.Saturday && found.Holiday) break;
        }
        console.log(`[${service}] calendar_dates: representative dates selected: ${[...repSids].join(', ')}`);
        // Mark this feed as calendar_dates-only so the timetable loop can skip non-representative trips
        svcCal._calendarDatesOnly = true;
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
    const railways = [];
    const routeStations = new Map(); // normRouteId → [normStopId, ...]
    const routeShapeIds = new Map(); // normRouteId → shape_id (captured for shapes pass below)

    for (const route of routes) {
        const routeId    = normRoute(route.route_id, service);
        const routeTrips = tripsByRoute.get(route.route_id) || [];

        // Use an upbound representative trip to capture canonical station order + shape
        const repTrip = routeTrips.find(t => t.direction_id === '0') || routeTrips[0];
        const stationList = [];
        if (repTrip) {
            for (const st of stsByTrip.get(repTrip.trip_id) || []) {
                const sid = normStop(st.stop_id, service);
                if (!stationList.includes(sid)) stationList.push(sid);
            }
            if (repTrip.shape_id) routeShapeIds.set(routeId, repTrip.shape_id);
        }
        routeStations.set(routeId, stationList);

        railways.push({
            id:            routeId,
            title:         {en: route.route_long_name || route.route_short_name || route.route_id},
            stations:      stationList,
            ascending:     dirs[0],
            descending:    dirs[1],
            color:         route.route_color ? `#${route.route_color}` : '#888888',
            carComposition
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

    // Map route → shape (shape_ids captured in the routes loop above)
    const railwayShapes = [];
    for (const [routeId, shapeId] of routeShapeIds) {
        const pts = shapePoints.get(shapeId);
        if (!pts || pts.length === 0) continue;

        railwayShapes.push({
            id: routeId,
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

    // railways.json
    writeJSON('data/railways.json', allRailways);
    console.log(`\nWrote data/railways.json        (${allRailways.length} railways)`);

    // stations.json
    writeJSON('data/stations.json', allStations);
    console.log(`Wrote data/stations.json        (${allStations.length} stations)`);

    // station-groups.json
    writeJSON('data/station-groups.json', allStationGroups);
    console.log(`Wrote data/station-groups.json  (${allStationGroups.length} groups)`);

    // coordinates.json — preserve existing airways, replace railways with NYC shapes
    let existingAirways = [];
    try {
        const existing = JSON.parse(fs.readFileSync('data/coordinates.json', 'utf8'));
        existingAirways = existing.airways || [];
    } catch { /* file absent or invalid — start fresh */ }
    writeJSON('data/coordinates.json', {
        airways:  existingAirways,
        railways: allRailwayShapes
    });
    console.log(`Wrote data/coordinates.json     (${allRailwayShapes.length} railway shapes, ${existingAirways.length} airways preserved)`);

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
