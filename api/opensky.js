/**
 * Aircraft proxy — uses adsb.lol (free, cloud-accessible ADS-B aggregator,
 * no authentication required, not blocked from Vercel datacenters).
 *
 *   • States:  api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}
 *   • Routes:  api.adsbdb.com callsign lookup (free, no auth) per aircraft
 *   • ATIS:    aviationweather.gov METAR + live aircraft headings
 *   • Response: {atisData, flightData}
 *
 * Flight object fields:
 *   Arrivals:   {id, n, ar, sat, or}   — 'or' = origin airport {id, title}
 *   Departures: {id, n, dp, sdt, ds}   — 'ds' = destination airport {id, title}
 *
 * Env vars:
 *   CORS_ORIGIN  restricts which origin may call this endpoint (optional)
 */

// 50 nm radius centred between JFK/LGA/EWR covers all five NYC-area airports
const STATES_URL  = 'https://api.adsb.lol/v2/lat/40.77/lon/-73.90/dist/50';
const METAR_URL   = 'https://aviationweather.gov/api/data/metar?ids=KJFK,KLGA,KEWR,KHPN,KISP&format=json&taf=false&hours=1';
const ADSBDB_URL  = 'https://api.adsbdb.com/v0/callsign/';

// adsb.lol reports altitude in feet and vertical rate in ft/min
const FT_TO_M     = 1 / 3.28084;
const FTMIN_TO_MS = 0.00508;

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
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit'
});
function toEastern(unixMs) {
    return easternFmt.format(new Date(unixMs)).replace(/^24:/, '00:');
}

function estimateTimeMs(distKm, alt, vertRate, speedKmh) {
    const distMs = (distKm / speedKmh) * 3_600_000;
    const altMs  = (alt > 50 && Math.abs(vertRate) > 0.5)
        ? (alt / Math.abs(vertRate)) * 1000
        : distMs;
    const w = Math.min(1, distKm / 10);
    return w * distMs + (1 - w) * altMs;
}

function airportObj(iata, name) {
    return {id: iata, title: {en: name}};
}

// Fetch route for one callsign from adsbdb.com with a 3-second timeout.
// Returns {originIata, originName, destIata, destName} or null.
async function fetchRoute(callsign) {
    if (!callsign || callsign.length < 3) return null;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${ADSBDB_URL}${encodeURIComponent(callsign)}`, {
            signal: controller.signal,
            headers: {'User-Agent': 'mini-nyc-3d/0.1.0', Accept: 'application/json'}
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        const data = await res.json();
        const r = data?.response?.flightroute;
        if (!r?.origin?.iata_code || !r?.destination?.iata_code) return null;
        return {
            originIata: r.origin.iata_code,
            originName: r.origin.name,
            destIata:   r.destination.iata_code,
            destName:   r.destination.name
        };
    } catch {
        return null;
    }
}

// Filter states to candidates near NYC airports within altitude/distance thresholds.
function filterCandidates(states) {
    const ALTITUDE_MAX   = 1500; // m — arrivals: ILS ~700m; departures climb fast so need higher ceiling
    const ARRIVAL_DIST   = 25;   // km — ILS glideslope established by ~15 km
    const DEPARTURE_DIST = 35;   // km — departures move away from airport quickly

    const candidates = [];
    const seen = new Set();

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

// Parallel route lookups for all unique callsigns in candidates.
async function lookupRoutes(candidates) {
    const callsigns = [...new Set(
        candidates.map(c => (c.s.callsign || '').trim()).filter(Boolean)
    )];
    const results = await Promise.allSettled(callsigns.map(cs => fetchRoute(cs)));
    const routeMap = new Map();
    callsigns.forEach((cs, i) => {
        if (results[i].status === 'fulfilled' && results[i].value) {
            routeMap.set(cs, results[i].value);
        }
    });
    return routeMap;
}

// IATA→ICAO lookup for fast reverse mapping
const IATA_TO_ICAO = Object.fromEntries(
    Object.entries(NYC_AIRPORTS).map(([icao, ap]) => [ap.iata, icao])
);
const NYC_IATAS = new Set(Object.values(NYC_AIRPORTS).map(ap => ap.iata));

// Build flightData and headingVotes from candidates + route map.
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

async function fetchAtis(headingVotes = {}) {
    const landing = [], departure = [], reported = new Set();
    try {
        const res = await fetch(METAR_URL, {
            headers: {'User-Agent': 'mini-nyc-3d/0.1.0', Accept: 'application/json'}
        });
        if (res.ok) {
            const metars = await res.json();
            if (Array.isArray(metars)) {
                for (const m of metars) {
                    const rwys = AIRPORT_RUNWAYS[m.icaoId];
                    const windDeg = Number(m.wdir);
                    if (!rwys) continue;
                    reported.add(m.icaoId);
                    const lRwy = !isFinite(windDeg) ? DEFAULT_RUNWAYS[m.icaoId]?.landing  : bestRunway(windDeg, rwys.landing);
                    const dRwy = !isFinite(windDeg) ? DEFAULT_RUNWAYS[m.icaoId]?.departure : bestRunway(windDeg, rwys.departure);
                    if (lRwy) landing.push(`${m.icaoId}.${lRwy}`);
                    if (dRwy) departure.push(`${m.icaoId}.${dRwy}`);
                }
            }
        }
    } catch { /* fall through to defaults */ }
    for (const [icao, def] of Object.entries(DEFAULT_RUNWAYS)) {
        if (!reported.has(icao)) {
            landing.push(`${icao}.${def.landing}`);
            departure.push(`${icao}.${def.departure}`);
        }
    }
    function topRunway(votes) {
        let best = null, bestCount = 0;
        for (const [rwy, count] of Object.entries(votes)) {
            if (count > bestCount) { bestCount = count; best = rwy; }
        }
        return best;
    }
    for (const [icao, votes] of Object.entries(headingVotes)) {
        const lRwy = topRunway(votes.landing  || {});
        const dRwy = topRunway(votes.departure || {});
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

module.exports = async function handler(req, res) {
    const allowedOrigin = process.env.CORS_ORIGIN;
    if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Cache-Control', 's-maxage=30');

    if (req.method === 'OPTIONS') {
        if (!allowedOrigin) { res.status(405).end(); return; }
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.status(204).end();
        return;
    }

    try {
        const statesRes = await fetch(STATES_URL, {
            headers: {'User-Agent': 'mini-nyc-3d/0.1.0'}
        });
        if (!statesRes.ok) throw new Error(`States ${statesRes.status}`);
        const data = await statesRes.json();

        // adsb.lol returns objects (not arrays); altitude in feet, rate in ft/min
        const states = (data.ac || [])
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

        const candidates = filterCandidates(states);
        const routeMap   = await lookupRoutes(candidates);
        const {flights: flightData, headingVotes} = buildFlightData(candidates, routeMap, Date.now());
        const atisData   = await fetchAtis(headingVotes);

        if (req.query?.debug === '1' || req.url?.includes('debug=1')) {
            const debugCandidates = candidates.map(c => {
                const cs = (c.s.callsign || c.s.icao24).trim();
                const route = routeMap.get(cs) ?? null;
                return {
                    cs, alt: c.alt, vr: c.s.vertRate, nearest: c.nearestIata,
                    dist: +c.nearestDist.toFixed(1),
                    route: route ? `${route.originIata}→${route.destIata}` : null
                };
            });
            return res.status(200).json({atisData, flightData, debug: {
                totalStates: states.length, candidates: debugCandidates
            }});
        }

        res.status(200).json({atisData, flightData});
    } catch (err) {
        const causeCode = err.cause?.code ?? err.cause?.message ?? '(none)';
        console.error('Aircraft proxy error:', err.message, '| cause:', causeCode);
        const atisData = await fetchAtis().catch(() => ({landing: [], departure: []}));
        const isDebug  = req.query?.debug === '1' || req.url?.includes('debug=1');
        res.status(200).json({
            atisData, flightData: [],
            ...(isDebug && {error: err.message, cause: causeCode})
        });
    }
};
