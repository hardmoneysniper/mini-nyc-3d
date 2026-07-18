'use strict';
/**
 * Shared merge-write helpers for the GTFS conversion scripts.
 * Each operator's script (MTA, NJT, ...) owns entries whose `id` is
 * prefixed with its own operator code (e.g. "MTA.", "NJT."). Merge-writing
 * means: read whatever is already on disk, strip out only the entries that
 * belong to the calling operator, then write back the union of "everyone
 * else's data" + "this operator's freshly generated data". That keeps the
 * conversion scripts safely rerunnable in any order.
 */
const fs = require('fs');

function readJSON(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, '\t'), 'utf8');
}

/** Merge an array of {id, ...} objects, replacing all entries whose id starts with "<prefix>." */
function mergeArrayById(existing, fresh, prefix) {
    const ownPrefix = `${prefix}.`;
    const kept = existing.filter(item => !item.id.startsWith(ownPrefix));
    return [...kept, ...fresh];
}

/** Merge station-groups.json: array of [[stationId, ...]] transfer groups, no top-level id */
function mergeStationGroups(existing, fresh, prefix) {
    const ownPrefix = `${prefix}.`;
    const kept = existing.filter(group => !group.flat().some(id => id.startsWith(ownPrefix)));
    return [...kept, ...fresh];
}

module.exports = {readJSON, writeJSON, mergeArrayById, mergeStationGroups};
