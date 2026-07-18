import * as Comlink from 'comlink';
import geobuf from 'geobuf';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import Pbf from 'pbf';
import configs from './configs';
import {isString, loadJSON, removePrefix} from './helpers/helpers';
import {decode} from './helpers/helpers-gtfs';

// direction_id 0/1 → display label per service
const DIRECTION_LABELS = {
    Subway: ['Uptown',   'Downtown'],
    LIRR:   ['Outbound', 'Inbound'],
    MNR:    ['Outbound', 'Inbound']
};

// Feed prefix → operator/service label used in internal IDs
const MTA_FEED_SERVICE = {
    'nyct%2Fgtfs-ace': 'Subway',
    'nyct%2Fgtfs-bdfm': 'Subway',
    'nyct%2Fgtfs-g': 'Subway',
    'nyct%2Fgtfs-jz': 'Subway',
    'nyct%2Fgtfs-nqrw': 'Subway',
    'nyct%2Fgtfs-l': 'Subway',
    'nyct%2Fgtfs': 'Subway',
    'nyct%2Fgtfs-si': 'Subway',
    'lirr%2Fgtfs-lirr': 'LIRR',
    'mnr%2Fgtfs-mnr': 'MNR'
};

function getTimetableFileName(clock) {
    const calendar = clock.getCalendar() === 'Weekday' ? 'weekday' : 'holiday';

    return `timetable-${calendar}.json.gz`;
}

function getExtraTimetableFileNames(clock) {
    const calendar = clock.getCalendar();

    if (calendar === 'Saturday') {
        return ['timetable-saturday.json.gz'];
    }
    if (calendar === 'Holiday') {
        return ['timetable-sunday-holiday.json.gz'];
    }
    return [];
}

function toNumber(val) {
    if (val == null) return 0;
    return typeof val.toNumber === 'function' ? val.toNumber() : Number(val);
}

/**
 * Load all the static data.
 * @param {string} dataUrl - Data URL
 * @param {string} lang - IETF language tag for dictionary
 * @param {Promise} clockPromise - Promise for the Clock object representing the
 *     current time
 * @returns {Object} Loaded data
 */
export function loadStaticData(dataUrl, lang, clockPromise) {
    return Promise.all([
        loadJSON(`assets/dictionary-${lang}.json`),
        ...[
            'railways.json.gz',
            'stations.json.gz',
            'features.json.gz',
            'rail-directions.json.gz',
            'train-types.json.gz',
            'train-vehicles.json.gz',
            'operators.json.gz',
            'airports.json.gz',
            'flight-statuses.json.gz',
            'poi.json.gz'
        ].map(fileName => `${dataUrl}/${fileName}`).map(loadJSON),
        clockPromise.then(clock => Promise.all([
            getTimetableFileName(clock),
            ...getExtraTimetableFileNames(clock)
        ].map(fileName => `${dataUrl}/${fileName}`).map(loadJSON)))
    ]).then(data => ({
        dict: data[0],
        railwayData: data[1],
        stationData: data[2],
        featureCollection: data[3],
        railDirectionData: data[4],
        trainTypeData: data[5],
        trainVehicleData: data[6],
        operatorData: data[7],
        airportData: data[8],
        flightStatusData: data[9],
        poiData: data[10],
        timetableData: [].concat(...data[11])
    }));
}

/**
 * Load the timetable data.
 * @param {string} dataUrl - Data URL
 * @param {Clock} clock - Clock object representing the current time
 * @returns {Object} Loaded timetable data
 */
export function loadTimetableData(dataUrl, clock) {
    return Promise.all([
        getTimetableFileName(clock),
        ...getExtraTimetableFileNames(clock)
    ].map(fileName => `${dataUrl}/${fileName}`).map(loadJSON)).then(data => [].concat(...data));
}

/**
 * Load the dynamic data for trains from MTA GTFS-RT feeds.
 * No API key required — MTA feeds are open access.
 * @returns {Object} Loaded data
 */
export function loadDynamicTrainData() {
    const baseUrl = configs.apiUrl.mta;

    const feedPromises = configs.mtaFeeds.map(feed => {
        const service = MTA_FEED_SERVICE[feed];

        return fetch(`${baseUrl}${feed}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`MTA feed ${feed} returned HTTP ${response.status}`);
                }
                return response.arrayBuffer();
            })
            .then(buffer => ({
                service,
                feed: GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer))
            }))
            .catch(err => {
                console.warn(`Failed to load MTA feed ${feed}:`, err);
                return {service, feed: {entity: []}};
            });
    });

    return Promise.all(feedPromises).then(results => {
        const trainData = new Map(),
            trainInfoData = [],
            now = new Date().toISOString().replace('T', ' ').slice(0, 19);

        for (const {service, feed} of results) {
            for (const entity of feed.entity || []) {

                // Vehicle positions — current location on track
                if (entity.vehicle) {
                    const {trip, stopId, currentStatus, timestamp} = entity.vehicle;

                    if (!trip || !trip.tripId) continue;

                    const {tripId, routeId, directionId} = trip,
                        id = `MTA.${service}.${tripId}`,
                        normSid = sid => service === 'Subway' ? sid.replace(/[NS]$/, '') : sid,
                        stopRef = stopId ? `MTA.${service}.${normSid(stopId)}` : undefined,
                        entry = trainData.get(id) || {id, o: 'MTA', r: `MTA.${service}.${routeId}`, n: tripId};

                    entry.d = (DIRECTION_LABELS[service] || DIRECTION_LABELS.Subway)[directionId === 0 ? 0 : 1];
                    entry.date = timestamp ? new Date(toNumber(timestamp) * 1000).toISOString().replace('T', ' ').slice(0, 19) : now;

                    // currentStatus: 0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSIT_TO
                    if (stopRef) {
                        if (currentStatus === 1) {
                            entry.fs = stopRef;
                        } else {
                            entry.ts = stopRef;
                        }
                    }

                    trainData.set(id, entry);
                }

                // Trip updates — stop sequence and delays
                if (entity.tripUpdate) {
                    const {trip, stopTimeUpdate} = entity.tripUpdate;

                    if (!trip || !trip.tripId) continue;

                    const {tripId, routeId, directionId} = trip,
                        id = `MTA.${service}.${tripId}`,
                        entry = trainData.get(id) || {id, o: 'MTA', r: `MTA.${service}.${routeId}`, n: tripId};

                    entry.d = (DIRECTION_LABELS[service] || DIRECTION_LABELS.Subway)[directionId === 0 ? 0 : 1];

                    if (stopTimeUpdate && stopTimeUpdate.length > 0) {
                        const first = stopTimeUpdate[0],
                            last = stopTimeUpdate[stopTimeUpdate.length - 1],
                            toStopId = s => `MTA.${service}.${service === 'Subway' ? s.stopId.replace(/[NS]$/, '') : s.stopId}`;

                        entry.os = [toStopId(first)];
                        entry.ds = [toStopId(last)];

                        const delaySec = toNumber((first.departure && first.departure.delay) ||
                                                   (first.arrival && first.arrival.delay) || 0);

                        entry.delay = delaySec * 1000;
                    }

                    if (!entry.date) entry.date = now;

                    trainData.set(id, entry);
                }

                // Service alerts
                if (entity.alert) {
                    const {informedEntity, headerText} = entity.alert;

                    if (!informedEntity || !headerText) continue;

                    const text = (headerText.translation && headerText.translation[0] && headerText.translation[0].text) || '';

                    for (const informed of informedEntity) {
                        if (informed.routeId) {
                            trainInfoData.push({
                                operator: 'MTA',
                                railway: `MTA.${service}.${informed.routeId}`,
                                status: {en: text},
                                text: {en: text}
                            });
                        }
                    }
                }
            }
        }

        return {
            trainData: Array.from(trainData.values()),
            trainInfoData
        };
    });
}

/**
 * Load the dynamic data for flights via the aircraft proxy (adsb.lol,
 * no authentication required). Returns empty stubs if configs.flightUrl
 * is not configured.
 * @returns {Object} Loaded data
 */
export function loadDynamicFlightData() {
    if (!configs.flightUrl) {
        return Promise.resolve({
            atisData: {landing: [], departure: []},
            flightData: []
        });
    }
    return loadJSON(configs.flightUrl).then(data => ({
        atisData: data.atisData || {landing: [], departure: []},
        flightData: data.flightData || []
    }));
}

export function loadBusData(source, clock, lang) {
    const workerUrl = URL.createObjectURL(new Blob([`WORKER_STRING`], {type: 'text/javascript'})),
        worker = new Worker(workerUrl),
        proxy = Comlink.wrap(worker),
        date = clock.getDate(),
        hours = date.getHours();

    if (hours < 3) {
        date.setHours(hours - 24);
    }

    const year = date.getFullYear(),
        month = `0${date.getMonth() + 1}`.slice(-2),
        day = `0${date.getDate()}`.slice(-2),
        dayOfWeek = date.getDay(),
        dateString = `${year}${month}${day}`,
        dayString = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dayOfWeek];

    return new Promise(resolve => {
        proxy.load(source, dateString, dayString, lang, Comlink.proxy(data => {
            proxy[Comlink.releaseProxy]();
            worker.terminate();
            resolve(Object.assign({
                featureCollection: geobuf.decode(new Pbf(data[0]))
            }, decode(new Pbf(data[1]))));
        }));
    });
}

export function loadDynamicBusData(url) {
    return fetch(url)
        .then(response => response.arrayBuffer())
        .then(data => GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(data)));
}

// Kept for API compatibility with the GTFS plugin data-source plumbing in map.js
export function updateOdptUrl(url) {
    return isString(url) ? url : undefined;
}
