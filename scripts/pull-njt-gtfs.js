'use strict';
/**
 * scripts/pull-njt-gtfs.js
 *
 * Pulls a fresh NJ Transit rail static GTFS zip from NJT's authenticated
 * getGTFS endpoint and unzips it into data/njt_rail_data/, replacing the
 * current contents. Downloads to a temp directory first and only replaces
 * the real directory once the unzip produces the expected files, so a
 * failed pull never leaves data/njt_rail_data/ half-broken.
 *
 * NJT's getToken (needed once per run) is capped at 10 combined
 * getToken/isValidToken calls/day; getGTFS itself is unlimited once a
 * token is obtained.
 *
 * Usage:
 *   node scripts/pull-njt-gtfs.js
 *
 * Credentials: reads NJT_USERNAME/NJT_PASSWORD from process.env first
 * (so this works unmodified under GitHub Actions, where secrets arrive as
 * env vars), falling back to .env then credentials.json for local runs —
 * same layered pattern server.js already uses.
 *
 * After this script succeeds, run:
 *   node scripts/convert-njt-gtfs.js
 *   npm run build-data
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const NJT_BASE = process.env.NJT_API_BASE || 'https://raildata.njtransit.com';
const TARGET_DIR = path.join('data', 'njt_rail_data');
const EXPECTED_FILES = ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt'];

function loadCredentials() {
    let username = process.env.NJT_USERNAME || '';
    let password = process.env.NJT_PASSWORD || '';
    if (username && password) return {username, password};

    try {
        const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const m = line.match(/^(NJT_USERNAME|NJT_PASSWORD)=(.+)$/);
            if (!m) continue;
            if (m[1] === 'NJT_USERNAME' && !username) username = m[2].trim();
            if (m[1] === 'NJT_PASSWORD' && !password) password = m[2].trim();
        }
    } catch { /* no .env */ }

    if (!username || !password) {
        try {
            const c = JSON.parse(fs.readFileSync('credentials.json', 'utf8'));
            if (!username) username = c.njtUsername || '';
            if (!password) password = c.njtPassword || '';
        } catch { /* no credentials.json */ }
    }

    return {username, password};
}

async function postForm(pathName, fields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return fetch(`${NJT_BASE}${pathName}`, {method: 'POST', body: form});
}

async function getToken(username, password) {
    if (!username || !password) throw new Error('NJT_USERNAME/NJT_PASSWORD not configured');
    const res = await postForm('/api/GTFSRT/getToken', {username, password});
    const body = await res.json().catch(() => null);
    if (!body || body.Authenticated !== 'True' || !body.UserToken) {
        throw new Error(`NJT getToken failed: ${body?.errorMessage || res.status}`);
    }
    console.log('[pull-njt-gtfs] fetched new token');
    return body.UserToken;
}

async function getGTFSZip(token) {
    const res = await postForm('/api/GTFSRT/getGTFS', {token});
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const body = await res.json().catch(() => null);
        throw new Error(`NJT getGTFS failed: ${body?.errorMessage || res.status}`);
    }
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer);
}

async function main() {
    const {username, password} = loadCredentials();
    const token = await getToken(username, password);

    console.log('[pull-njt-gtfs] downloading getGTFS zip...');
    const zipBuffer = await getGTFSZip(token);
    console.log(`[pull-njt-gtfs] downloaded ${(zipBuffer.length / 1e6).toFixed(2)} MB`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'njt-gtfs-'));
    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(tmpDir, true);

    const missing = EXPECTED_FILES.filter(f => !fs.existsSync(path.join(tmpDir, f)));
    if (missing.length > 0) {
        throw new Error(`getGTFS zip is missing expected files: ${missing.join(', ')} (extracted to ${tmpDir} for inspection)`);
    }

    fs.rmSync(TARGET_DIR, {recursive: true, force: true});
    fs.mkdirSync(TARGET_DIR, {recursive: true});
    for (const file of fs.readdirSync(tmpDir)) {
        fs.copyFileSync(path.join(tmpDir, file), path.join(TARGET_DIR, file));
    }
    fs.rmSync(tmpDir, {recursive: true, force: true});

    console.log(`[pull-njt-gtfs] replaced ${TARGET_DIR}/ with fresh data`);
    console.log('\n✓ Done! Run "node scripts/convert-njt-gtfs.js" next.');
}

main().catch(err => {
    console.error('\nFatal:', err.message);
    process.exit(1);
});
