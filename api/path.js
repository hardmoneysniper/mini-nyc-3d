/**
 * PATH train real-time proxy. PATH's GTFS-RT feed
 * (https://path.transitdata.nyc/gtfsrt, public, no auth needed) is
 * genuinely limited: every entity is a dummy trip with a random,
 * unusable tripId and exactly one stopTimeUpdate — {routeId,
 * directionId, stopId, arrival.time}, no departure time, no way to link
 * one prediction to another as the same physical train. Confirmed by
 * fetching the live feed directly during design (see
 * docs/superpowers/specs/2026-07-21-path-train-integration-design.md)
 * and by data/panynj_rail_data/panynj README.md.
 *
 * Position estimation: group predictions into per-(routeId, directionId,
 * stationId) queues sorted by arrival time ascending — this is literally
 * the "next N arrivals" data the feed provides. For each pair of
 * consecutive stations (A, B) on a route/direction (known from the
 * static schedule in data/railways.json), pair the Nth-soonest
 * prediction at A with the Nth-soonest at B — same N. This assumes
 * trains reach consecutive stations in the order they left the previous
 * one (true for PATH: no overtaking). Since there's no departure time,
 * assume a fixed dwell after arrival-at-A before the train is considered
 * to depart toward B.
 *
 * The output uses the exact same {fs, ts} "without timetable" shape
 * MTA/NJT trains already use for live positions that don't match a
 * scheduled trip — the client's existing speed-based animation (used for
 * every agency on this map) renders the movement; no explicit
 * arrival/departure timestamps are needed or sent.
 *
 * Env vars:
 *   CORS_ORIGIN  restricts which origin may call this endpoint (optional)
 */

const fs = require('fs');
const path = require('path');

const GTFSRT_URL = 'https://path.transitdata.nyc/gtfsrt';
const DWELL_MS = 20 * 1000; // assumed post-arrival dwell before a train departs toward the next station

function normStationId(rawStopId) {
    return `PATH.${rawStopId}`;
}

// Loads PATH railways from data/railways.json and groups them by their raw
// route_id (stripping the "PATH." prefix and any ".bN" branch suffix), so a
// single real-time routeId can be checked against every branch railway that
// shares it.
function loadRailwaysByRoute() {
    const railwaysPath = path.join(__dirname, '..', 'data', 'railways.json');
    const all = JSON.parse(fs.readFileSync(railwaysPath, 'utf8'));
    const pathRailways = all.filter(r => r.id.startsWith('PATH.'));

    const byRoute = new Map();
    for (const railway of pathRailways) {
        const m = railway.id.match(/^PATH\.([^.]+)(?:\.b\d+)?$/);
        if (!m) continue;
        const routeId = m[1];
        if (!byRoute.has(routeId)) byRoute.set(routeId, []);
        byRoute.get(routeId).push(railway);
    }
    return byRoute;
}

async function fetchFeed() {
    const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
    const res = await fetch(GTFSRT_URL);
    if (!res.ok) throw new Error(`PATH GTFS-RT fetch failed: HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

function toNumber(val) {
    if (val == null) return 0;
    return typeof val.toNumber === 'function' ? val.toNumber() : Number(val);
}

// Groups feed entities into per-"routeId|directionId|stationId" queues of
// arrival times (ms), sorted ascending (soonest first).
function buildArrivalQueues(feed) {
    const queues = new Map();
    for (const entity of feed.entity || []) {
        const {trip, stopTimeUpdate} = entity.tripUpdate || {};
        if (!trip || !stopTimeUpdate || stopTimeUpdate.length === 0) continue;

        const {routeId, directionId} = trip;
        const update = stopTimeUpdate[0];
        if (!update.arrival || update.arrival.time == null || !update.stopId) continue;

        const stationId = normStationId(update.stopId);
        const key = `${routeId}|${directionId}|${stationId}`;
        const arrivalMs = toNumber(update.arrival.time) * 1000;

        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(arrivalMs);
    }
    for (const arr of queues.values()) arr.sort((a, b) => a - b);
    return queues;
}

// For one railway entry, returns its stations in the traversal order for
// the given directionId (0 = forward/ascending, 1 = reverse/descending) —
// matching the same ascending/descending convention every other railway
// in this app already uses.
function stationsForDirection(railway, directionId) {
    return directionId === 1 ? [...railway.stations].reverse() : railway.stations;
}

function buildTrainData(feed, railwaysByRoute) {
    const queues = buildArrivalQueues(feed);
    const now = Date.now();
    const trainData = [];

    for (const [routeId, railways] of railwaysByRoute) {
        for (const directionId of [0, 1]) {
            for (const railway of railways) {
                const stations = stationsForDirection(railway, directionId);

                for (let i = 0; i < stations.length - 1; i++) {
                    const stationA = stations[i];
                    const stationB = stations[i + 1];
                    const queueA = queues.get(`${routeId}|${directionId}|${stationA}`) || [];
                    const queueB = queues.get(`${routeId}|${directionId}|${stationB}`) || [];
                    const pairCount = Math.min(queueA.length, queueB.length);

                    for (let n = 0; n < pairCount; n++) {
                        const arrivalA = queueA[n];
                        const arrivalB = queueB[n];
                        const dwellEnd = arrivalA + DWELL_MS;

                        if (now < arrivalA || now >= arrivalB) continue; // not this leg's turn yet, or already past it

                        const id = `${railway.id}.${directionId}.${i}.${n + 1}`;
                        const entry = {id, o: 'PATH', r: railway.id, n: `${n + 1}`, d: directionId === 1 ? 'Inbound' : 'Outbound'};

                        if (now < dwellEnd) {
                            entry.fs = stationA; // dwelling at the station it just reached
                        } else {
                            entry.ts = stationB; // en route toward the next station
                        }

                        trainData.push(entry);
                    }
                }
            }
        }
    }

    return trainData;
}

module.exports = async function handler(req, res) {
    const allowedOrigin = process.env.CORS_ORIGIN;
    if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Cache-Control', 's-maxage=15');

    if (req.method === 'OPTIONS') {
        if (!allowedOrigin) { res.status(405).end(); return; }
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.status(204).end();
        return;
    }

    try {
        const railwaysByRoute = loadRailwaysByRoute();
        const feed = await fetchFeed();
        const trainData = buildTrainData(feed, railwaysByRoute);

        res.status(200).json({trainData, trainInfoData: []});
        console.log(`  /api/path → ${trainData.length} trains`);
    } catch (err) {
        console.error('PATH proxy error:', err.message);
        res.status(200).json({trainData: [], trainInfoData: []});
    }
};
