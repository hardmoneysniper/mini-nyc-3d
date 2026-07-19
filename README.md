# Mini NYC 3D

A real-time 3D digital map of New York City's public transport system.

## Cheat Sheet

Operation | Description
--- | ---
Mouse or finger drag | Pan
Mouse wheel rotation | Zoom in/out
Right click or Ctrl key + mouse drag | Tilt up/down and rotate
Shift key + mouse drag | Box zoom
Pinch in/out | Zoom in/out
Two-finger drag | Tilt up/down and rotate
Double-click or triple-tap | Zoom in
Shift key + Double-click or two-finger tap | Zoom out
Click or tap the search button | Show/hide the route search panel
Click or tap +/- buttons | Zoom in/out
Click or tap the compass button | Reset bearing to north
Click or tap the compass button + mouse or finger drag | Rotate
Click or tap the fullscreen button | Toggle the fullscreen mode
Click or tap the eye button | Toggle the underground mode
Click or tap the playback button | Toggle the playback mode
Click or tap the battery button | Toggle the eco mode
Click or tap the layer button | Show/hide the layer display settings panel
Click or tap the camera button | Show/hide the tracking mode settings panel
Click or tap the info button | Show/hide the app info panel
Click or tap a train/bus/station | Enable tracking or select station
Click or tap the map | Disable tracking or deselect station
Hover a train/bus/station | Show the train/bus/station information

## Language Support

Currently, the following languages are supported.

Language | User Interface | Map Labels | Stations, Railways, etc.
--- | --- | --- | ---
English | Yes | Yes | Yes
Spanish | Yes | Yes | Yes
French | Yes | Yes | -
Chinese (Simplified) | Yes | Yes | -
Chinese (Traditional) | Yes | Yes | -
Korean | Yes | Yes | -

## About Data

Transit data is sourced from the [MTA open data feeds](https://api.mta.info/) — no API key required. This covers real-time train positions, timetables, and service status for the NYC Subway, LIRR, and Metro-North. Flight data for JFK, LGA, and EWR is provided by [adsb.lol](https://adsb.lol) — also no API key required.

NJ Transit rail data (real-time positions, delays, and service alerts) is provided by [NJ Transit's GTFS/GTFSRT Web API](https://developer.njtransit.com/registration), which requires a free developer account.

> **Planned for v2:** PATH real-time data via the [511NY Open Data API](https://511ny.org/developers).

## How to Build

The latest LTS version of Node.js is required.

1. Get a [Mapbox](https://account.mapbox.com/auth/signup/) access token (select **Map Loads for Web**).
2. Aircraft data needs no signup (adsb.lol is unauthenticated).
3. Register at [NJ Transit's developer portal](https://developer.njtransit.com/registration) for rail real-time data, and set `NJT_USERNAME` / `NJT_PASSWORD` in a `.env` file (see `.env.example`).

From the root directory:

```bash
npm install
npm run fetch-gtfs       # downloads MTA GTFS and generates data/ JSON files (~5 min)
npm run fetch-njt-gtfs   # converts the local NJT rail GTFS in data/njt_rail_data/
npm run build-all
```

Your Mapbox token is already wired in `public/index.html`. To use a different token, edit the `accessToken` field in `index.html`:

```js
const map = new mt3d.Map({
    container: 'map',
    accessToken: 'pk.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
});
```

## License

Mini NYC 3D is based on [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d) by Akihiko Kusanagi, available under the [MIT License](https://opensource.org/licenses/MIT). This derivative work is also released under the MIT License.
