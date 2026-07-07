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

// ---------------------------------------------------------------------------
// OpenSky proxy — OAuth2 authenticated, mirrors api/opensky.js for local dev
//
//   • Auth:     OAuth2 client credentials → Bearer token; realm: opensky-network
//               Falls back to anonymous if credentials are missing; verified at startup
//   • Credits:  4000/day authenticated; bbox costs 1 credit/call
//               30s cache → 2880 calls/day = 72% of daily quota
//   • Routes:   api.adsbdb.com callsign lookup (free), 4-hour in-memory cache
//   • ATIS:     aviationweather.gov METAR fallback, overridden by live headings
// ---------------------------------------------------------------------------

// Load credentials from .env then credentials.json at startup
let _clientId = '', _clientSecret = '';
(function loadCreds() {
    try {
        const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const m = line.match(/^(OPENSKY_CLIENT_ID|OPENSKY_CLIENT_SECRET)=(.+)$/);
            if (!m) continue;
            if (m[1] === 'OPENSKY_CLIENT_ID')     _clientId     = m[2].trim();
            if (m[1] === 'OPENSKY_CLIENT_SECRET')  _clientSecret = m[2].trim();
        }
    } catch { /* no .env */ }
    if (!_clientId || !_clientSecret) {
        try {
            const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json'), 'utf8'));
            if (!_clientId)     _clientId     = c.clientId     || '';
            if (!_clientSecret) _clientSecret = c.clientSecret || '';
        } catch { /* no credentials.json — anonymous fallback */ }
    }
})();

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
// OAuth2 token manager — caches token in memory, refreshes 30s before expiry
// ---------------------------------------------------------------------------
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
let _token = null, _tokenExpiresAt = 0;

function httpsPost(url, formBody) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const opts = {
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(formBody),
                'User-Agent': 'mini-nyc-3d/0.1.0'
            }
        };
        const req = https.request(opts, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                try { resolve({status: r.statusCode, body: JSON.parse(d)}); }
                catch { resolve({status: r.statusCode, body: null}); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(formBody);
        req.end();
    });
}

async function getToken() {
    const now = Date.now();
    if (_token && now < _tokenExpiresAt) return _token;
    if (!_clientId || !_clientSecret) return null;
    try {
        const formBody = `grant_type=client_credentials` +
            `&client_id=${encodeURIComponent(_clientId)}` +
            `&client_secret=${encodeURIComponent(_clientSecret)}`;
        const {status, body} = await httpsPost(TOKEN_URL, formBody);
        if (status !== 200 || !body?.access_token) {
            console.error('[opensky] token error:', status, body?.error || '');
            return null;
        }
        _token = body.access_token;
        _tokenExpiresAt = now + ((body.expires_in || 1800) - 30) * 1000;
        return _token;
    } catch (e) {
        console.error('[opensky] token error:', e.message);
        return null;
    }
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
// State cache — 30-second TTL → 2880 calls/day = 72% of 4000-credit/day quota
// ---------------------------------------------------------------------------
let cachedStates = [], statesExpiresAt = 0;
let cachedAtis   = null, atisExpiresAt = 0;

const STATES_URL = 'https://opensky-network.org/api/states/all?lamin=40.5&lomin=-74.5&lamax=41.2&lomax=-73.0';
const METAR_URL  = 'https://aviationweather.gov/api/data/metar?ids=KJFK,KLGA,KEWR,KHPN,KISP&format=json&taf=false&hours=1';

async function fetchStates() {
    const now = Date.now();
    if (now < statesExpiresAt) return cachedStates;
    const token = await getToken();
    const headers = token ? {Authorization: `Bearer ${token}`} : {};
    const {status, body} = await httpsGet(STATES_URL, headers);
    if (status !== 200) throw new Error(`States ${status}`);
    cachedStates = (body?.states || [])
        .filter(s => s[5] != null && s[6] != null)
        .map(s => ({
            icao24: s[0], callsign: (s[1] || '').trim(),
            lon: s[5], lat: s[6], baroAlt: s[7], onGround: s[8],
            heading: s[10], vertRate: s[11], geoAlt: s[13]
        }));
    statesExpiresAt = now + 30 * 1000;
    return cachedStates;
}

function filterCandidates(states) {
    const ALTITUDE_MAX = 700, ARRIVAL_DIST = 25, DEPARTURE_DIST = 20;
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
    const flights = [], headingVotes = {};
    const APPROACH_KMH = 268, CLIMB_KMH = 370;
    for (const {s, nearestIcao, nearestIata, nearestDist, alt, id,
                ARRIVAL_DIST, DEPARTURE_DIST} of candidates) {
        const vertRate = s.vertRate ?? 0, heading = s.heading;
        const cs    = s.callsign || s.icao24;
        const route = routeMap.get(cs) ?? null;
        const rwys  = AIRPORT_RUNWAYS[nearestIcao];

        const routeIsArrival   = route?.destIata   === nearestIata;
        const routeIsDeparture = route?.originIata === nearestIata;
        if (route && !routeIsArrival && !routeIsDeparture) continue;

        const isArrival   = routeIsArrival   || (!route && vertRate < -2.0 && nearestDist <= ARRIVAL_DIST);
        const isDeparture = routeIsDeparture || (!route && vertRate > 2.0  && nearestDist <= DEPARTURE_DIST);

        function vote(type) {
            if (heading == null || !rwys) return;
            const rwy = bestRunway(heading, rwys[type]);
            if (!headingVotes[nearestIcao]) headingVotes[nearestIcao] = {landing:{}, departure:{}};
            headingVotes[nearestIcao][type][rwy] = (headingVotes[nearestIcao][type][rwy] ?? 0) + 1;
        }

        if (isArrival && nearestDist <= ARRIVAL_DIST && alt > 50) {
            const t = estimateTimeMs(nearestDist, alt, vertRate, APPROACH_KMH);
            vote('landing');
            const f = {id: `${id}-arr`, n: cs, ar: nearestIata, sat: toEastern(nowMs + t)};
            if (route) f.or = airportObj(route.originIata, route.originName);
            flights.push(f);
        } else if (isDeparture && nearestDist <= DEPARTURE_DIST) {
            const t = alt > 50 ? estimateTimeMs(nearestDist, alt, vertRate, CLIMB_KMH) : 30_000;
            vote('departure');
            const f = {id: `${id}-dep`, n: cs, dp: nearestIata, sdt: toEastern(nowMs - t)};
            if (route) f.ds = airportObj(route.destIata, route.destName);
            flights.push(f);
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

async function handleOpenSky(res) {
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
        console.log(`  /api/opensky → ${arrDep} | TTL ${ttlSec}s | routes: ${routes} | votes: ${votes}`);
        console.log(`  ATIS L=[${atisData.landing.join(',')}] D=[${atisData.departure.join(',')}]`);
    } catch (err) {
        console.error('  [opensky] error:', err.message);
        const atisData = await fetchAtis().catch(() => ({landing: [], departure: []}));
        res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify({atisData, flightData: []}));
    }
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/opensky') { handleOpenSky(res); return; }

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
    const authMode = _clientId ? `auth (${_clientId})` : 'anonymous fallback';
    console.log('Mini NYC 3D → http://localhost:3000');
    console.log(`Routes: api.adsbdb.com (free, 4h cache) | States: OpenSky ${authMode} (30s cache, ~2880 calls/day)`);
    if (_clientId) {
        getToken().then(token => {
            console.log(token
                ? '  [auth] OpenSky OAuth2 token OK'
                : '  [auth] OpenSky OAuth2 token FAILED — requests will use anonymous API');
        });
    }
    console.log('Watching requests...\n');
});
