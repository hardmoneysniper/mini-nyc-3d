/**
 * NJ Transit rail real-time proxy — NJT's GTFS-RT feeds require an
 * authenticated token (see data/NJTRANSIT_Rail_GTFSRT_V1.pdf), unlike
 * MTA's open feeds which the client decodes directly. This proxy holds the
 * token server-side and returns decoded, pre-shaped {trainData, trainInfoData}
 * — the same shape src/loader.js already produces for MTA.
 *
 * Token quota: getToken/isValidToken are capped at 10 combined calls/day.
 * We never call isValidToken; we cache the token in memory for ~20 hours
 * and only re-fetch on an explicit "Invalid token." response.
 *
 * Env vars:
 *   NJT_USERNAME, NJT_PASSWORD  — required, NJT developer portal credentials
 *   NJT_API_BASE                — optional, defaults to production;
 *                                  set to https://testraildata.njtransit.com
 *                                  to verify against NJT's test environment
 *   CORS_ORIGIN                 — optional, restricts which origin may call this endpoint
 */

const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const NJT_BASE = process.env.NJT_API_BASE || 'https://raildata.njtransit.com';
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000; // assumed ~20h lifetime, no published TTL

const DIRECTION_LABELS = ['Outbound', 'Inbound'];

let _token = null, _tokenObtainedAt = 0, _tokenPromise = null;

async function postForm(pathName, fields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return fetch(`${NJT_BASE}${pathName}`, {method: 'POST', body: form});
}

async function fetchToken() {
    const username = process.env.NJT_USERNAME;
    const password = process.env.NJT_PASSWORD;
    if (!username || !password) throw new Error('NJT_USERNAME/NJT_PASSWORD not configured');

    const res = await postForm('/api/GTFSRT/getToken', {username, password});
    const body = await res.json().catch(() => null);
    if (!body || body.Authenticated !== 'True' || !body.UserToken) {
        throw new Error(`NJT getToken failed: ${body?.errorMessage || res.status}`);
    }
    console.log('[njt] fetched new token');
    return body.UserToken;
}

// `staleToken` is the token value the caller observed as rejected ("Invalid
// token."). On a forced refresh, if `_token` no longer matches it, a sibling
// call already refreshed the cache in the meantime — reuse that instead of
// burning another real getToken call against NJT's 10/day cap.
async function getToken(forceRefresh, staleToken) {
    const now = Date.now();
    if (!forceRefresh && _token && now - _tokenObtainedAt < TOKEN_TTL_MS) return _token;
    if (forceRefresh && staleToken !== undefined && staleToken !== _token) return _token;
    if (!_tokenPromise) {
        _tokenPromise = fetchToken()
            .then(token => { _token = token; _tokenObtainedAt = Date.now(); _tokenPromise = null; return token; })
            .catch(err => { _tokenPromise = null; throw err; });
    }
    return _tokenPromise;
}

// Fetches a GTFSRT proto endpoint with the cached token, retrying once with
// a fresh token if the response is an "Invalid token." JSON error (NJT's
// success responses are binary protobuf; only error responses are JSON).
async function fetchProto(pathName) {
    let token = await getToken(false);
    let res = await postForm(pathName, {token});

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const body = await res.json().catch(() => null);
        if (body?.errorMessage?.includes('Invalid token')) {
            token = await getToken(true, token);
            res = await postForm(pathName, {token});
        } else {
            throw new Error(`NJT ${pathName} failed: ${body?.errorMessage || res.status}`);
        }
    }

    const buffer = await res.arrayBuffer();
    // NJT returns a genuinely empty (0-byte) body for a feed with no active
    // entities (observed live on getAlerts) rather than a minimal valid
    // FeedMessage — decode() throws "missing required 'header'" on an empty
    // buffer, so treat 0 bytes as an empty feed instead of an error.
    if (buffer.byteLength === 0) return {entity: []};
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

function toNumber(val) {
    if (val == null) return 0;
    return typeof val.toNumber === 'function' ? val.toNumber() : Number(val);
}

function buildTrainAndInfoData(tripUpdatesFeed, vehiclePositionsFeed, alertsFeed) {
    const trainData = new Map();
    const trainInfoData = [];
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    for (const entity of vehiclePositionsFeed.entity || []) {
        const {trip, stopId, currentStatus, timestamp} = entity.vehicle || {};
        if (!trip || !trip.tripId) continue;

        const {tripId, routeId, directionId} = trip,
            id = `NJT.${tripId}`,
            stopRef = stopId ? `NJT.${stopId}` : undefined,
            entry = trainData.get(id) || {id, o: 'NJT', r: `NJT.${routeId}`, n: tripId};

        entry.d = DIRECTION_LABELS[directionId === 0 ? 0 : 1];
        entry.date = timestamp ? new Date(toNumber(timestamp) * 1000).toISOString().replace('T', ' ').slice(0, 19) : now;

        if (stopRef) {
            if (currentStatus === 1) entry.fs = stopRef;
            else entry.ts = stopRef;
        }

        trainData.set(id, entry);
    }

    for (const entity of tripUpdatesFeed.entity || []) {
        const {trip, stopTimeUpdate} = entity.tripUpdate || {};
        if (!trip || !trip.tripId) continue;

        const {tripId, routeId, directionId} = trip,
            id = `NJT.${tripId}`,
            entry = trainData.get(id) || {id, o: 'NJT', r: `NJT.${routeId}`, n: tripId};

        entry.d = DIRECTION_LABELS[directionId === 0 ? 0 : 1];

        if (stopTimeUpdate && stopTimeUpdate.length > 0) {
            const first = stopTimeUpdate[0],
                last = stopTimeUpdate[stopTimeUpdate.length - 1];

            entry.os = [`NJT.${first.stopId}`];
            entry.ds = [`NJT.${last.stopId}`];

            const delaySec = toNumber((first.departure && first.departure.delay) ||
                                       (first.arrival && first.arrival.delay) || 0);
            entry.delay = delaySec * 1000;
        }

        if (!entry.date) entry.date = now;
        trainData.set(id, entry);
    }

    for (const entity of alertsFeed.entity || []) {
        const {informedEntity, headerText} = entity.alert || {};
        if (!informedEntity || !headerText) continue;

        const text = (headerText.translation && headerText.translation[0] && headerText.translation[0].text) || '';

        for (const informed of informedEntity) {
            if (informed.routeId) {
                trainInfoData.push({
                    operator: 'NJT',
                    railway: `NJT.${informed.routeId}`,
                    status: {en: text},
                    text: {en: text}
                });
            }
        }
    }

    return {trainData: Array.from(trainData.values()), trainInfoData};
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
        const [tripUpdatesFeed, vehiclePositionsFeed, alertsFeed] = await Promise.all([
            fetchProto('/api/GTFSRT/getTripUpdates'),
            fetchProto('/api/GTFSRT/getVehiclePositions'),
            fetchProto('/api/GTFSRT/getAlerts')
        ]);

        const {trainData, trainInfoData} = buildTrainAndInfoData(tripUpdatesFeed, vehiclePositionsFeed, alertsFeed);
        res.status(200).json({trainData, trainInfoData});
        console.log(`  /api/njt → ${trainData.length} trains | ${trainInfoData.length} alerts`);
    } catch (err) {
        console.error('NJT proxy error:', err.message);
        res.status(200).json({trainData: [], trainInfoData: []});
    }
};
