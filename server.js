'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BUILD_DIR = path.join('f:', 'Cornell Tech', 'mini-nyc-3d', 'build');
const PORT = 3000;

const MIME = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.gz': 'application/octet-stream',
    '.png': 'image/png', '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json'
};

// Load NJT credentials from .env then credentials.json at startup
let _njtUsername = '', _njtPassword = '';
(function loadNjtCreds() {
    try {
        const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const m = line.match(/^(NJT_USERNAME|NJT_PASSWORD)=(.+)$/);
            if (!m) continue;
            if (m[1] === 'NJT_USERNAME') _njtUsername = m[2].trim();
            if (m[1] === 'NJT_PASSWORD') _njtPassword = m[2].trim();
        }
    } catch { /* no .env */ }
    if (!_njtUsername || !_njtPassword) {
        try {
            const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json'), 'utf8'));
            if (!_njtUsername) _njtUsername = c.njtUsername || '';
            if (!_njtPassword) _njtPassword = c.njtPassword || '';
        } catch { /* no credentials.json */ }
    }
    console.log(_njtUsername && _njtPassword ? '[njt] credentials loaded OK' : '[njt] credentials MISSING — /api/njt will fail');
})();

// ---------------------------------------------------------------------------
// Aircraft proxy — mirrors api/aircraft.js for local dev
//
//   • States:  api.adsb.lol (free, no authentication required)
//   • Routes:  api.adsbdb.com callsign lookup (free), 4-hour in-memory cache
//   • ATIS:    aviationweather.gov METAR fallback, overridden by live headings
// ---------------------------------------------------------------------------

const NYC_AIRPORTS = {
    KJFK: {lat: 40.6413, lng: -73.7781, iata: 'JFK'},
    KLGA: {lat: 40.7769, lng: -73.8740, iata: 'LGA'},
    KEWR: {lat: 40.6895, lng: -74.1745, iata: 'EWR'},
    KHPN: {lat: 40.9672, lng: -73.7076, iata: 'HPN'},
    KISP: {lat: 40.7952, lng: -73.1003, iata: 'ISP'}
};

const AIRPORT_RUNWAYS = {
    KJFK: {
        landing:   [{name:'13L',h:130},{name:'22L',h:220},{name:'31L',h:310},{name:'04L',h:40},
                    {name:'13R',h:130},{name:'22R',h:220},{name:'31R',h:310},{name:'04R',h:40}],
        departure: [{name:'13R',h:130},{name:'22R',h:220},{name:'31R',h:310},{name:'04R',h:40},
                    {name:'13L',h:130},{name:'22L',h:220},{name:'31L',h:310},{name:'04L',h:40}]
    },
    KLGA: {
        landing:   [{name:'31',h:310},{name:'22',h:220},{name:'13',h:130},{name:'04',h:40}],
        departure: [{name:'22',h:220},{name:'31',h:310},{name:'04',h:40},{name:'13',h:130}]
    },
    KEWR: {
        landing:   [{name:'22L',h:220},{name:'4L',h:40},{name:'29',h:290},{name:'22R',h:220},{name:'4R',h:40}],
        departure: [{name:'22R',h:220},{name:'4R',h:40},{name:'29',h:290},{name:'22L',h:220},{name:'4L',h:40}]
    },
    KHPN: {
        landing:   [{name:'16',h:160},{name:'34',h:340},{name:'11',h:110},{name:'29',h:290}],
        departure: [{name:'34',h:340},{name:'16',h:160},{name:'29',h:290},{name:'11',h:110}]
    },
    KISP: {
        landing:   [{name:'24',h:240},{name:'06',h:60},{name:'15R',h:150},{name:'33L',h:330}],
        departure: [{name:'06',h:60},{name:'24',h:240},{name:'33L',h:330},{name:'15R',h:150}]
    }
};

const DEFAULT_RUNWAYS = {
    KJFK: {landing: '13L', departure: '13R'},
    KLGA: {landing: '31',  departure: '22'},
    KEWR: {landing: '22L', departure: '22R'},
    KHPN: {landing: '16',  departure: '34'},
    KISP: {landing: '24',  departure: '06'}
};

// IATA→ICAO lookup for fast reverse mapping
const IATA_TO_ICAO = Object.fromEntries(
    Object.entries(NYC_AIRPORTS).map(([icao, ap]) => [ap.iata, icao])
);
const NYC_IATAS = new Set(Object.values(NYC_AIRPORTS).map(ap => ap.iata));

function bestRunway(bearing, runways) {
    let best = runways[0].name, bestDiff = Infinity;
    for (const {name, h} of runways) {
        const diff = Math.abs(((bearing - h + 180) % 360) - 180);
        if (diff < bestDiff) { bestDiff = diff; best = name; }
    }
    return best;
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const easternFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit'
});
function toEastern(unixMs) {
    return easternFmt.format(new Date(unixMs)).replace(/^24:/, '00:');
}

function estimateTimeMs(distKm, alt, vertRate, speedKmh) {
    const distMs = (distKm / speedKmh) * 3_600_000;
    const altMs  = (alt > 50 && Math.abs(vertRate) > 0.5)
        ? (alt / Math.abs(vertRate)) * 1000 : distMs;
    const w = Math.min(1, distKm / 10);
    return w * distMs + (1 - w) * altMs;
}

function airportObj(iata, name) {
    return {id: iata, title: {en: name}};
}

// adsb.lol reports altitude in feet and vertical rate in ft/min
const FT_TO_M     = 1 / 3.28084;
const FTMIN_TO_MS = 0.00508;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function httpsGet(url, extraHeaders) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: Object.assign(
                {'User-Agent': 'mini-nyc-3d/0.1.0', Accept: 'application/json'},
                extraHeaders
            )
        }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                try { resolve({status: r.statusCode, body: JSON.parse(d)}); }
                catch { resolve({status: r.statusCode, body: null}); }
            });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ---------------------------------------------------------------------------
// Route cache — 4-hour TTL; callsigns don't change mid-flight
// ---------------------------------------------------------------------------
const routeCache = new Map();

async function lookupRoute(callsign) {
    if (!callsign || callsign.length < 3) return null;
    const now = Date.now();
    const cached = routeCache.get(callsign);
    if (cached !== undefined && now < cached.expires) return cached.data;
    try {
        const {status, body} = await httpsGet(
            `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`
        );
        const r = status === 200 && body?.response?.flightroute;
        const data = (r && r.origin?.iata_code && r.destination?.iata_code)
            ? {originIata: r.origin.iata_code, originName: r.origin.name,
               destIata: r.destination.iata_code, destName: r.destination.name}
            : null;
        routeCache.set(callsign, {data, expires: now + (data ? 4 : 0.167) * 60 * 60 * 1000});
        return data;
    } catch {
        routeCache.set(callsign, {data: null, expires: now + 10 * 60 * 1000});
        return null;
    }
}

// ---------------------------------------------------------------------------
// State cache — 30-second TTL
// ---------------------------------------------------------------------------
let cachedStates = [], statesExpiresAt = 0;
let cachedAtis   = null, atisExpiresAt = 0;

// 50 nm radius centred between JFK/LGA/EWR covers all five NYC-area airports
const STATES_URL = 'https://api.adsb.lol/v2/lat/40.77/lon/-73.90/dist/50';
const METAR_URL  = 'https://aviationweather.gov/api/data/metar?ids=KJFK,KLGA,KEWR,KHPN,KISP&format=json&taf=false&hours=1';

async function fetchStates() {
    const now = Date.now();
    if (now < statesExpiresAt) return cachedStates;
    const {status, body} = await httpsGet(STATES_URL);
    if (status !== 200) throw new Error(`States ${status}`);
    // adsb.lol returns objects (not arrays); altitude in feet, rate in ft/min
    cachedStates = (body?.ac || [])
        .filter(s => s.lat != null && s.lon != null)
        .map(s => {
            const onGround = s.alt_baro === 'ground' || s.gnd === 1;
            const altFt    = typeof s.alt_baro === 'number' ? s.alt_baro : null;
            return {
                icao24:   s.hex,
                callsign: (s.flight || '').trim(),
                lon:      s.lon,
                lat:      s.lat,
                baroAlt:  altFt != null ? altFt * FT_TO_M : null,
                onGround,
                heading:  s.track,
                vertRate: typeof s.baro_rate === 'number' ? s.baro_rate * FTMIN_TO_MS : null,
                geoAlt:   typeof s.alt_geom === 'number'  ? s.alt_geom  * FT_TO_M    : null
            };
        });
    statesExpiresAt = now + 30 * 1000;
    return cachedStates;
}

function filterCandidates(states) {
    const ALTITUDE_MAX   = 1500; // m — arrivals: ILS ~700m; departures climb fast so need higher ceiling
    const ARRIVAL_DIST   = 25;   // km — ILS glideslope established by ~15 km
    const DEPARTURE_DIST = 35;   // km — departures move away from airport quickly
    const candidates = [], seen = new Set();
    for (const s of states) {
        if (s.onGround) continue;
        if (s.lat == null || s.lon == null) continue;
        const alt = s.baroAlt != null ? s.baroAlt : s.geoAlt;
        if (alt == null || alt > ALTITUDE_MAX) continue;
        let nearestIcao = null, nearestIata = null, nearestDist = Infinity;
        for (const [icao, ap] of Object.entries(NYC_AIRPORTS)) {
            const d = haversineKm(s.lat, s.lon, ap.lat, ap.lng);
            if (d < nearestDist) { nearestDist = d; nearestIcao = icao; nearestIata = ap.iata; }
        }
        if (!nearestIcao || nearestDist > 60) continue;
        const id = `${s.icao24}-${nearestIcao}`;
        if (seen.has(id)) continue;
        seen.add(id);
        candidates.push({s, nearestIcao, nearestIata, nearestDist, alt, id,
            ARRIVAL_DIST, DEPARTURE_DIST});
    }
    return candidates;
}

async function lookupAllRoutes(candidates) {
    const callsigns = [...new Set(candidates.map(c => c.s.callsign).filter(Boolean))];
    const results = await Promise.allSettled(callsigns.map(cs => lookupRoute(cs)));
    const routeMap = new Map();
    callsigns.forEach((cs, i) => {
        if (results[i].status === 'fulfilled') routeMap.set(cs, results[i].value);
    });
    return routeMap;
}

function buildFlightData(candidates, routeMap, nowMs) {
    const flights = [];
    const headingVotes = {};
    const APPROACH_KMH = 268;  // ~145 kt
    const CLIMB_KMH    = 370;  // ~200 kt

    for (const {s, nearestIcao, nearestIata, nearestDist, alt, id,
                ARRIVAL_DIST, DEPARTURE_DIST} of candidates) {
        const vertRate = s.vertRate ?? 0;
        const heading  = s.heading;
        const cs       = (s.callsign || s.icao24).trim();
        const route    = routeMap.get(cs) ?? null;
        const hasRoute = route != null;

        // When route is known, use its actual NYC airport rather than nearest geographic airport.
        // This fixes cases where a plane is closer to LGA but route says it's going to JFK.
        const routeDestIsNYC   = hasRoute && NYC_IATAS.has(route.destIata);
        const routeOriginIsNYC = hasRoute && NYC_IATAS.has(route.originIata);

        if (hasRoute && !routeDestIsNYC && !routeOriginIsNYC) continue;

        const effectiveArrIata = routeDestIsNYC   ? route.destIata   : nearestIata;
        const effectiveDepIata = routeOriginIsNYC ? route.originIata : nearestIata;
        const effectiveArrIcao = IATA_TO_ICAO[effectiveArrIata] ?? nearestIcao;
        const effectiveDepIcao = IATA_TO_ICAO[effectiveDepIata] ?? nearestIcao;

        const effectiveArrDist = haversineKm(s.lat, s.lon,
            NYC_AIRPORTS[effectiveArrIcao].lat, NYC_AIRPORTS[effectiveArrIcao].lng);
        const effectiveDepDist = haversineKm(s.lat, s.lon,
            NYC_AIRPORTS[effectiveDepIcao].lat, NYC_AIRPORTS[effectiveDepIcao].lng);

        const isArrival = routeDestIsNYC
            || (!hasRoute && vertRate < -2.0 && nearestDist <= ARRIVAL_DIST);
        // Require alt > 200m for unrouted departures — prevents go-arounds (plane aborts
        // landing close to runway then climbs) from being misclassified as new departures.
        const isDeparture = routeOriginIsNYC
            || (!hasRoute && vertRate > 2.0 && nearestDist <= DEPARTURE_DIST && alt > 200);

        const arrDist = routeDestIsNYC   ? effectiveArrDist : nearestDist;
        const depDist = routeOriginIsNYC ? effectiveDepDist : nearestDist;

        if (isArrival && arrDist <= ARRIVAL_DIST && alt > 50 && alt <= 700) { // arrivals: keep tight ceiling (ILS glideslope)
            const rwys = AIRPORT_RUNWAYS[effectiveArrIcao];
            const timeToLandMs = estimateTimeMs(arrDist, alt, vertRate, APPROACH_KMH);

            if (heading != null && rwys) {
                const rwy = bestRunway(heading, rwys.landing);
                if (!headingVotes[effectiveArrIcao]) headingVotes[effectiveArrIcao] = {landing: {}, departure: {}};
                headingVotes[effectiveArrIcao].landing[rwy] = (headingVotes[effectiveArrIcao].landing[rwy] ?? 0) + 1;
            }

            const flight = {id: `${id}-arr`, n: cs, ar: effectiveArrIata, sat: toEastern(nowMs + timeToLandMs)};
            if (route) flight.or = airportObj(route.originIata, route.originName);
            flights.push(flight);

        } else if (isDeparture && depDist <= DEPARTURE_DIST && alt <= 1500) { // departures: higher ceiling, they climb fast
            const rwys = AIRPORT_RUNWAYS[effectiveDepIcao];
            const timeAloftMs = alt > 50
                ? estimateTimeMs(depDist, alt, vertRate, CLIMB_KMH)
                : 30_000;

            if (heading != null && rwys) {
                const rwy = bestRunway(heading, rwys.departure);
                if (!headingVotes[effectiveDepIcao]) headingVotes[effectiveDepIcao] = {landing: {}, departure: {}};
                headingVotes[effectiveDepIcao].departure[rwy] = (headingVotes[effectiveDepIcao].departure[rwy] ?? 0) + 1;
            }

            const flight = {id: `${id}-dep`, n: cs, dp: effectiveDepIata, sdt: toEastern(nowMs - timeAloftMs)};
            if (route) flight.ds = airportObj(route.destIata, route.destName);
            flights.push(flight);
        }
    }
    return {flights, headingVotes};
}

function topRunway(votes) {
    let best = null, bestCount = 0;
    for (const [rwy, count] of Object.entries(votes || {})) {
        if (count > bestCount) { bestCount = count; best = rwy; }
    }
    return best;
}

async function fetchAtis(headingVotes = {}) {
    const now = Date.now();
    const landing = [], departure = [], reported = new Set();

    if (!cachedAtis || now >= atisExpiresAt) {
        try {
            const {status, body} = await httpsGet(METAR_URL);
            if (status === 200 && Array.isArray(body)) {
                for (const m of body) {
                    const rwys = AIRPORT_RUNWAYS[m.icaoId], windDeg = Number(m.wdir);
                    if (!rwys) continue;
                    reported.add(m.icaoId);
                    const lRwy = !isFinite(windDeg) ? DEFAULT_RUNWAYS[m.icaoId]?.landing  : bestRunway(windDeg, rwys.landing);
                    const dRwy = !isFinite(windDeg) ? DEFAULT_RUNWAYS[m.icaoId]?.departure : bestRunway(windDeg, rwys.departure);
                    if (lRwy) landing.push(`${m.icaoId}.${lRwy}`);
                    if (dRwy) departure.push(`${m.icaoId}.${dRwy}`);
                }
            }
        } catch { /* ignore */ }
        for (const [icao, def] of Object.entries(DEFAULT_RUNWAYS)) {
            if (!reported.has(icao)) {
                landing.push(`${icao}.${def.landing}`);
                departure.push(`${icao}.${def.departure}`);
            }
        }
        cachedAtis = {landing: [...landing], departure: [...departure]};
        atisExpiresAt = now + 5 * 60 * 1000;
    } else {
        landing.push(...cachedAtis.landing);
        departure.push(...cachedAtis.departure);
    }

    for (const [icao, votes] of Object.entries(headingVotes)) {
        const lRwy = topRunway(votes.landing), dRwy = topRunway(votes.departure);
        if (lRwy) {
            const idx = landing.findIndex(s => s.startsWith(`${icao}.`));
            if (idx >= 0) landing[idx] = `${icao}.${lRwy}`; else landing.push(`${icao}.${lRwy}`);
        }
        if (dRwy) {
            const idx = departure.findIndex(s => s.startsWith(`${icao}.`));
            if (idx >= 0) departure[idx] = `${icao}.${dRwy}`; else departure.push(`${icao}.${dRwy}`);
        }
    }
    return {landing, departure};
}

async function handleAircraft(res) {
    try {
        const states     = await fetchStates();
        const candidates = filterCandidates(states);
        const routeMap   = await lookupAllRoutes(candidates);
        const {flights: flightData, headingVotes} = buildFlightData(candidates, routeMap, Date.now());
        const atisData   = await fetchAtis(headingVotes);

        const ttlSec   = Math.round((statesExpiresAt - Date.now()) / 1000);
        const arrDep   = `${flightData.filter(f=>f.ar).length}arr/${flightData.filter(f=>f.dp).length}dep`;
        const routes   = [...routeMap.entries()].filter(([,v])=>v).map(([cs,r])=>`${cs}:${r.originIata}→${r.destIata}`).join(' ') || 'none';
        const votes    = Object.entries(headingVotes).map(([icao,v])=>`${icao}:${topRunway(v.landing)||'?'}/${topRunway(v.departure)||'?'}`).join(' ') || 'none';

        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify({atisData, flightData}));
        console.log(`  /api/aircraft → ${arrDep} | TTL ${ttlSec}s | routes: ${routes} | votes: ${votes}`);
        console.log(`  ATIS L=[${atisData.landing.join(',')}] D=[${atisData.departure.join(',')}]`);
    } catch (err) {
        console.error('  [aircraft] error:', err.message);
        const atisData = await fetchAtis().catch(() => ({landing: [], departure: []}));
        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify({atisData, flightData: []}));
    }
}

// ---------------------------------------------------------------------------
// NJ Transit rail proxy — mirrors api/njt.js for local dev
//
//   • Auth:    username/password → token; 10/day combined getToken+isValidToken
//              quota, so the token is cached ~20h and never validated defensively.
//   • Feeds:   getTripUpdates, getVehiclePositions, getAlerts (GTFS-RT protobuf)
// ---------------------------------------------------------------------------
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const NJT_BASE = process.env.NJT_API_BASE || 'https://raildata.njtransit.com';
const NJT_TOKEN_TTL_MS = 20 * 60 * 60 * 1000;
const NJT_DIRECTIONS = ['Outbound', 'Inbound'];

let _njtToken = null, _njtTokenObtainedAt = 0, _njtTokenPromise = null;

function toNumber(val) {
    if (val == null) return 0;
    return typeof val.toNumber === 'function' ? val.toNumber() : Number(val);
}

async function njtPostForm(pathName, fields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return fetch(`${NJT_BASE}${pathName}`, {method: 'POST', body: form});
}

async function fetchNjtToken() {
    if (!_njtUsername || !_njtPassword) throw new Error('NJT credentials not configured');
    const res = await njtPostForm('/api/GTFSRT/getToken', {username: _njtUsername, password: _njtPassword});
    const body = await res.json().catch(() => null);
    if (!body || body.Authenticated !== 'True' || !body.UserToken) {
        throw new Error(`NJT getToken failed: ${body?.errorMessage || res.status}`);
    }
    console.log('  [njt] fetched new token');
    return body.UserToken;
}

// `staleToken` is the token value the caller observed as rejected ("Invalid
// token."). On a forced refresh, if `_njtToken` no longer matches it, a
// sibling call already refreshed the cache in the meantime — reuse that
// instead of burning another real getToken call against NJT's 10/day cap.
async function getNjtToken(forceRefresh, staleToken) {
    const now = Date.now();
    if (!forceRefresh && _njtToken && now - _njtTokenObtainedAt < NJT_TOKEN_TTL_MS) return _njtToken;
    if (forceRefresh && staleToken !== undefined && staleToken !== _njtToken) return _njtToken;
    if (!_njtTokenPromise) {
        _njtTokenPromise = fetchNjtToken()
            .then(token => { _njtToken = token; _njtTokenObtainedAt = Date.now(); _njtTokenPromise = null; return token; })
            .catch(err => { _njtTokenPromise = null; throw err; });
    }
    return _njtTokenPromise;
}

async function fetchNjtProto(pathName) {
    let token = await getNjtToken(false);
    let res = await njtPostForm(pathName, {token});

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const body = await res.json().catch(() => null);
        if (body?.errorMessage?.includes('Invalid token')) {
            token = await getNjtToken(true, token);
            res = await njtPostForm(pathName, {token});
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

function buildNjtTrainAndInfoData(tripUpdatesFeed, vehiclePositionsFeed, alertsFeed) {
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

        entry.d = NJT_DIRECTIONS[directionId === 0 ? 0 : 1];
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

        entry.d = NJT_DIRECTIONS[directionId === 0 ? 0 : 1];
        if (stopTimeUpdate && stopTimeUpdate.length > 0) {
            const first = stopTimeUpdate[0], last = stopTimeUpdate[stopTimeUpdate.length - 1];
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
                    operator: 'NJT', railway: `NJT.${informed.routeId}`,
                    status: {en: text}, text: {en: text}
                });
            }
        }
    }

    return {trainData: Array.from(trainData.values()), trainInfoData};
}

async function handleNjt(res) {
    try {
        const [tripUpdatesFeed, vehiclePositionsFeed, alertsFeed] = await Promise.all([
            fetchNjtProto('/api/GTFSRT/getTripUpdates'),
            fetchNjtProto('/api/GTFSRT/getVehiclePositions'),
            fetchNjtProto('/api/GTFSRT/getAlerts')
        ]);
        const {trainData, trainInfoData} = buildNjtTrainAndInfoData(tripUpdatesFeed, vehiclePositionsFeed, alertsFeed);
        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify({trainData, trainInfoData}));
        console.log(`  /api/njt → ${trainData.length} trains | ${trainInfoData.length} alerts`);
    } catch (err) {
        console.error('  [njt] error:', err.message);
        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify({trainData: [], trainInfoData: []}));
    }
}

// ---------------------------------------------------------------------------
// PATH train proxy — mirrors api/path.js for local dev
//
//   • Auth:   none — https://path.transitdata.nyc/gtfsrt is public.
//   • Limits: the feed gives only single-stop arrival predictions with no
//             trip continuity; see api/path.js's header comment for the
//             full explanation of the position-estimation approach.
// ---------------------------------------------------------------------------
const PATH_GTFSRT_URL = 'https://path.transitdata.nyc/gtfsrt';
const PATH_DWELL_MS = 20 * 1000; // assumed post-arrival dwell before a train departs toward the next station

function pathNormStationId(rawStopId) {
    return `PATH.${rawStopId}`;
}

// Loads PATH railways from data/railways.json and groups them by their raw
// route_id (stripping the "PATH." prefix and any ".bN" branch suffix), so a
// single real-time routeId can be checked against every branch railway that
// shares it.
function loadPathRailwaysByRoute() {
    const railwaysPath = path.join(__dirname, 'data', 'railways.json');
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

async function fetchPathFeed() {
    const res = await fetch(PATH_GTFSRT_URL);
    if (!res.ok) throw new Error(`PATH GTFS-RT fetch failed: HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

// Groups feed entities into per-"routeId|directionId|stationId" queues of
// arrival times (ms), sorted ascending (soonest first).
function buildPathArrivalQueues(feed) {
    const queues = new Map();
    for (const entity of feed.entity || []) {
        const {trip, stopTimeUpdate} = entity.tripUpdate || {};
        if (!trip || !stopTimeUpdate || stopTimeUpdate.length === 0) continue;

        const {routeId, directionId} = trip;
        const update = stopTimeUpdate[0];
        if (!update.arrival || update.arrival.time == null || !update.stopId) continue;

        const stationId = pathNormStationId(update.stopId);
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
function pathStationsForDirection(railway, directionId) {
    return directionId === 1 ? [...railway.stations].reverse() : railway.stations;
}

function buildPathTrainData(feed, railwaysByRoute) {
    const queues = buildPathArrivalQueues(feed);
    const now = Date.now();
    const trainData = [];

    for (const [routeId, railways] of railwaysByRoute) {
        for (const directionId of [0, 1]) {
            for (const railway of railways) {
                const stations = pathStationsForDirection(railway, directionId);

                for (let i = 0; i < stations.length - 1; i++) {
                    const stationA = stations[i];
                    const stationB = stations[i + 1];
                    const queueA = queues.get(`${routeId}|${directionId}|${stationA}`) || [];
                    const queueB = queues.get(`${routeId}|${directionId}|${stationB}`) || [];
                    const pairCount = Math.min(queueA.length, queueB.length);

                    for (let n = 0; n < pairCount; n++) {
                        const arrivalA = queueA[n];
                        const arrivalB = queueB[n];
                        const dwellEnd = arrivalA + PATH_DWELL_MS;

                        if (now < arrivalA || now >= arrivalB) continue; // not this leg's turn yet, or already past it

                        const id = `PATH.${routeId}.${directionId}.${i}.${n + 1}`;
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

async function handlePath(res) {
    try {
        const railwaysByRoute = loadPathRailwaysByRoute();
        const feed = await fetchPathFeed();
        const trainData = buildPathTrainData(feed, railwaysByRoute);
        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify({trainData, trainInfoData: []}));
        console.log(`  /api/path → ${trainData.length} trains`);
    } catch (err) {
        console.error('  [path] error:', err.message);
        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify({trainData: [], trainInfoData: []}));
    }
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/aircraft') { handleAircraft(res); return; }
    if (url === '/api/njt') { handleNjt(res); return; }
    if (url === '/api/path') { handlePath(res); return; }

    let filePath = path.join(BUILD_DIR, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(filePath)) filePath = path.join(BUILD_DIR, 'index.html');

    const ext = path.extname(filePath);
    try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
        res.end(data);
        if (!url.match(/\.(js|css)$/)) console.log(`  GET ${url} → 200 (${(data.length/1024).toFixed(0)}KB)`);
    } catch {
        res.writeHead(404); res.end('Not found: ' + url);
        console.log(`  GET ${url} → 404`);
    }
}).listen(PORT, () => {
    console.log('Mini NYC 3D → http://localhost:3000');
    console.log('Routes: api.adsbdb.com (free, 4h cache) | States: adsb.lol (free, no auth, 30s cache)');
    console.log('Watching requests...\n');
});
