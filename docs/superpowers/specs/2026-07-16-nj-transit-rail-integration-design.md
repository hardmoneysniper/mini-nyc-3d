# NJ Transit Rail Integration — Design

## Context

Mini NYC 3D currently renders MTA Subway, LIRR, and Metro-North in real time, decoding MTA's
open (no-auth) GTFS-RT protobuf feeds directly in the browser. NJ Transit rail is the next
service to add. Static NJT rail GTFS data (`data/njt_rail_data/*.txt`) and NJT's GTFS/GTFSRT Web
API spec (`data/NJTRANSIT_Rail_GTFSRT_V1.pdf`) are already on hand.

Unlike MTA, NJT's real-time feeds require an authenticated token (username/password → token,
capped at 10 combined `getToken`/`isValidToken` calls per day). The token can never reach the
browser, so — unlike MTA — NJT real-time data must go through a server-side proxy, following the
pattern already established for aircraft data (`api/opensky.js` + local-dev mirror in
`server.js`).

## Goals

- Render NJ Transit's NYC-bound commuter rail lines plus Hudson-Bergen Light Rail and Newark
  Light Rail, with live train positions, delays, and service alerts.
- Reuse the existing static-data build pipeline and real-time loader patterns rather than
  inventing new ones.
- Keep NJT credentials out of git and respect the 10/day token-request cap.
- Rename the OpenSky-era aircraft proxy files to reflect that they've used adsb.lol since July
  2026, avoiding confusion for future contributors (unrelated cleanup the user asked to fold in
  here since it touches the same proxy pattern this design extends).

## Non-goals

- Atlantic City Line and River Line (`ATLC`, `RVLN`) — never serve the NYC area, excluded from
  route filtering.
- NJT bus data — out of scope; this feed is rail-only anyway.
- Building a persistent/external token store (e.g. Redis) — in-memory per-process caching is
  sufficient at this project's traffic scale (see "Token management" below).

## Housekeeping: aircraft proxy rename

Unrelated to NJT functionally, but the user asked to fold it in now since it's the same proxy
pattern this design extends, and doing it before adding a second proxy avoids further "opensky"
naming drift:

- `api/opensky.js` → `api/aircraft.js`
- `configs.flightUrl` → `'https://mini-nyc-3d.vercel.app/api/aircraft'`
- `configs.apiUrl.opensky` and `configs.openskyBbox` — deleted (confirmed unused anywhere in
  `src/`; dead config left over from the OpenSky→adsb.lol migration)
- `server.js` comments/variable names referencing "OpenSky" → "aircraft" (comments still note
  adsb.lol as the actual upstream data source)

## Architecture

```
data/njt_rail_data/*.txt (already downloaded)
        │
        ▼
scripts/convert-njt-gtfs.js  ──► data/railways.json, data/stations.json,
        │                        data/station-groups.json, data/coordinates.json
        │                        (merge-write: preserves existing MTA.* entries)
        ▼
npm run build-data  ──► build/data/*.json.gz  (served via GitHub Pages, as today)


NJT credentials (.env / credentials.json, gitignored)
        │
        ▼
api/njt.js (Vercel) + server.js mirror (local dev)
  - in-memory token cache (~20h assumed lifetime, no isValidToken calls)
  - fetches getTripUpdates + getVehiclePositions + getAlerts (protobuf)
  - decodes with GtfsRealtimeBindings (existing dependency)
  - merges into {trainData, trainInfoData} — same shape loader.js already produces for MTA
        │
        ▼
src/loader.js: loadDynamicNjtTrainData()  ──► loadJSON(configs.njtUrl)
        │
        ▼
map.js realtime update cycle: concat with MTA trainData/trainInfoData before rendering
```

## Static schedule data — `scripts/convert-njt-gtfs.js`

New script modeled on `scripts/convert-mta-gtfs.js`, reading the already-downloaded
`data/njt_rail_data/*.txt` directly (no network fetch — NJT schedules change rarely enough that a
manual re-download + rerun is the right cadence, and it avoids spending token quota on `getGTFS`).

- **Route filtering:** only the 15 in-scope routes — all commuter lines (`NEC`, `NJCL`, `NJCLL`,
  `MNE`, `MNEG`, `BNTN`, `BNTNM`, `MNBN`, `MNBNP`, `PASC`, `RARV`, `MRL`, `PRIN`) plus light rail
  (`HBLR`, `NLR`). Excludes `ATLC` (Atlantic City Line) and `RVLN` (River Line) — both run
  Philadelphia/Camden↔Trenton/Atlantic City and never reach the NYC area covered by this map.
- **ID scheme:** railway IDs `NJT.<route_id>`, station IDs `NJT.<stop_id>` — same convention as
  `MTA.<service>.<id>`.
- **Calendar handling:** reuses the existing `calendar_dates.txt`-only representative-date logic
  already in `convert-mta-gtfs.js` (this NJT feed has `calendar_dates.txt` but no `calendar.txt`,
  the same situation MNR already handles).
- **Direction labels:** `['Outbound', 'Inbound']`, matching LIRR/MNR's convention.
- **Train type:** `NJT.Regional` for commuter lines, `NJT.LightRail` for HBLR/Newark Light Rail,
  so they can be styled or animated differently later if desired.
- **Colors:** each railway keeps its own `route_color` from `routes.txt` (e.g. NEC red, NJCL
  blue, Raritan Valley orange) — per-line color drives track and train rendering today via
  `railways.json`'s `color` field, unchanged from how LIRR/MNR already work.

**Merge-write change to both conversion scripts.** `convert-mta-gtfs.js` currently overwrites
`data/railways.json`, `data/stations.json`, `data/station-groups.json`, and the railway shapes in
`data/coordinates.json` wholesale. If `convert-njt-gtfs.js` writes the same way, whichever script
runs last wipes out the other's output. Both scripts change to **merge-write**: read the existing
JSON file, strip only entries whose ID belongs to their own prefix (`MTA.` or `NJT.`), append
freshly generated entries, write back. This makes both scripts safely rerunnable in any order —
required groundwork, since without it adding NJT actively breaks MTA data on the next
`fetch-gtfs` run.

## Real-time proxy — `api/njt.js` (Vercel) + `server.js` mirror

**Credentials.** `NJT_USERNAME` / `NJT_PASSWORD` added to `.env` and `credentials.json` (both
already gitignored), mirroring the existing OpenSky client ID/secret pattern. Never appear in
frontend code or committed files.

**Hosting.** Deploy to Vercel first, same as the aircraft proxy — but keep the NJT token/fetch
logic in a small platform-agnostic module (plain functions, no Vercel-request-shape coupling) so
moving it to Render/Railway/Fly.io later is a matter of pointing `configs.njtUrl` at a new
deployment, not rewriting logic. This hedges against the real risk that NJT's servers block
Vercel's datacenter IP ranges the way OpenSky did — test against NJT's **test** environment
(`testraildata.njtransit.com`) from the deployed Vercel function before trusting it in production.

**Token management.** NJT's 10/day combined `getToken`+`isValidToken` cap rules out defensive
validation (`isValidToken` itself spends quota). Design:
- Cache the token in memory with an assumed ~20-hour lifetime (no published TTL, but the docs'
  "call once per day" framing implies a full day of validity).
- Never call `isValidToken`.
- If a data call (`getTripUpdates`/`getVehiclePositions`/`getAlerts`) returns `"Invalid token."`,
  treat it as expired: fetch one fresh token, retry once.
- Log every actual `getToken` call so quota usage is visible during development.
- On Vercel this cache lives per warm lambda instance — acceptable at this project's traffic
  level, and self-healing (via the retry-on-invalid-token path) if a cold start burns an extra
  call.

**Fetching + decoding.** POST the cached token to `getTripUpdates`, `getVehiclePositions`, and
`getAlerts` in parallel. Decode each with `GtfsRealtimeBindings` (existing dependency, already
used client-side for MTA — now also used server-side here). Merge trip-update and
vehicle-position entities by trip ID into the same shape `loader.js` already produces for MTA:

```js
{id: `NJT.${tripId}`, o: 'NJT', r: `NJT.${routeId}`, n, d, fs/ts, os/ds, delay}
```

Alerts become `trainInfoData` entries the same way MTA's alert entities do. Response shape:
`{trainData, trainInfoData}` — identical to what `loadDynamicTrainData()` already returns for
MTA. CDN-cached ~15s (matches `configs.realtimeCheckInterval`).

## Client wiring

- **`src/loader.js`:** new `loadDynamicNjtTrainData()` — `loadJSON(configs.njtUrl)`, same
  pattern as `loadDynamicFlightData()` (a proxy-JSON fetch, not client-side protobuf decoding,
  since NJT can't skip the auth proxy the way MTA does).
- **`src/configs.js`:** new `njtUrl` config, `/api/njt` locally and
  `https://mini-nyc-3d.vercel.app/api/njt` in production — same pattern as `flightUrl`.
- **Realtime update cycle:** wherever `loadDynamicTrainData()` is currently called on
  `configs.realtimeCheckInterval`, also call `loadDynamicNjtTrainData()` and concatenate
  `trainData`/`trainInfoData` from both before the map updates. Exact call site to be confirmed
  in the implementation plan.

## Map styling

- **`data/operators.json`:** new `NJT` entry using MTA's existing blue (`#0039A6`) rather than a
  distinct NJT brand color — this only affects the operator-level color (e.g. any legend/toggle
  UI), not individual line/train rendering.
- **Per-line color:** unchanged from the static-data section above — each railway keeps its own
  `route_color` from NJT's GTFS data, so trains and tracks render in each line's real color (NEC
  red, NJCL blue, etc.) rather than a single uniform NJT color.
- **No `map.js` changes needed** — confirmed railway color/rendering already reads entirely from
  `railways.json`'s per-railway `color` field; LIRR/MNR required zero `map.js` changes when they
  were added, and NJT follows the same data-driven path.

## Verification plan

1. Run `scripts/convert-njt-gtfs.js`; confirm `data/railways.json`/`data/stations.json` gain
   ~15 new `NJT.*` entries alongside existing `MTA.*` entries (not replacing them).
2. `npm run build-data` + local `server.js`; confirm NJT lines/stations render with correct
   per-line colors and positions near Newark, Hoboken, and NY Penn Station.
3. Test the `/api/njt` proxy against NJT's **test** environment first, to avoid burning
   production token quota during development.
4. Confirm `getToken` is called only once per dev session via the added log line.
5. Confirm live NJT trains animate along their tracks in real time, delays reflect
   `getTripUpdates` data, and service alerts populate `trainInfoData`.
