'use strict';
/**
 * Shared service-calendar derivation, used by both the MTA and NJT GTFS
 * conversion scripts. Two GTFS calendar shapes exist in practice:
 *   - calendar.txt lists each service_id's weekday/Saturday/Sunday flags
 *     directly (MTA Subway, LIRR).
 *   - Some feeds (MTA Metro-North, NJ Transit rail) only ship
 *     calendar_dates.txt — one row per (service_id, specific date). In that
 *     case we pick one representative upcoming date per calendar type
 *     (Weekday/Saturday/Holiday) to avoid exploding into hundreds of
 *     near-duplicate service IDs.
 */

function calType(row) {
    const sat = row.saturday === '1';
    const sun = row.sunday   === '1';
    if (sat && sun) return 'SaturdayHoliday';
    if (sat)        return 'Saturday';
    if (sun)        return 'Holiday';
    return 'Weekday';
}

/**
 * @param {Array} calendar - parsed calendar.txt rows (may be [])
 * @param {Array} calendarDates - parsed calendar_dates.txt rows (may be [])
 * @returns {{svcCal: Map<string,string>, repDates: string[]}}
 *   svcCal maps service_id -> 'Weekday'|'Saturday'|'Holiday'|'SaturdayHoliday'.
 *   When derived from calendar_dates.txt, svcCal._calendarDatesOnly is true
 *   and repDates lists the representative dates that were selected.
 */
function buildServiceCalendar(calendar, calendarDates) {
    const svcCal = new Map();
    for (const row of calendar) svcCal.set(row.service_id, calType(row));

    if (calendarDates.length > 0 && svcCal.size === 0) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const dateToSids = new Map();
        for (const row of calendarDates) {
            if (row.exception_type !== '1') continue;
            const d = row.date;
            if (!dateToSids.has(d)) dateToSids.set(d, []);
            dateToSids.get(d).push(row.service_id);
        }

        const repSids = new Set();
        const found = {Weekday: false, Saturday: false, Holiday: false};

        for (const dateStr of [...dateToSids.keys()].sort()) {
            const year = +dateStr.slice(0, 4), mon = +dateStr.slice(4, 6) - 1, day = +dateStr.slice(6, 8);
            const d = new Date(year, mon, day);
            if (d < today) continue;
            const dow = d.getDay();
            const type = dow === 0 ? 'Holiday' : dow === 6 ? 'Saturday' : 'Weekday';
            if (!found[type]) {
                found[type] = true;
                for (const sid of dateToSids.get(dateStr)) svcCal.set(sid, type);
                repSids.add(dateStr);
            }
            if (found.Weekday && found.Saturday && found.Holiday) break;
        }
        svcCal._calendarDatesOnly = true;
        return {svcCal, repDates: [...repSids]};
    }
    return {svcCal, repDates: []};
}

module.exports = {buildServiceCalendar, calType};
