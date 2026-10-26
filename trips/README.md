# Reisekarte (Trip Map)

An interactive travel log at `/trips/`. It is 100% static: no build step and no server code. Open `index.html` through any static host and it works.

| File | Purpose |
|---|---|
| `index.html`, `app.js` | Public viewer: world map, trip list, story mode, costs, lightbox |
| `editor.html`, `editor.js` | Local editor (not linked from the site) |
| `lib.js` | Shared helpers: transport modes, cost categories, distances, GPX parsing |
| `trips.css` | All styling. Design tokens are at the top. |
| `data/trips.json` | All trips |
| `data/tracks/` | Optional GPX or GeoJSON tracks for single legs |
| `images/<trip-id>/` | Photos |

Libraries are loaded from CDNs with pinned versions:
- MapLibre GL 4.7.1, with free Carto basemaps (no API key)
- marked 12.0.2, for stop descriptions
- exifr 7.1.3 and JSZip 3.10.1, used in the editor only

## Run locally

The pages load `trips.json` with `fetch`, so they need a local server. Opening them as `file://` does not work.

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123/trips/ for the viewer, or http://localhost:8123/trips/editor.html for the editor.

## Adding a trip (editor workflow)

1. Open the editor: click **✎** in the map's top bar (it opens the trip you are viewing), or go to `editor.html`. Pick **+ Neue Reise** from the dropdown for a new trip.
2. Fill in the title, dates, tags and countries. Countries are ISO codes such as `PT` or `JP`. **Set the ID first.** It becomes the image folder `images/<id>/`.
3. **Click the map** to add stops in order.
   - Drag a card by its `⋮⋮` grip to reorder stops.
   - Drag a marker on the map to move a stop.
4. Each stop has a time, an optional zoom level and a Markdown text.
5. Set the transport mode for each leg ("weiter mit …").
   - **GPX…** imports a recorded track for that leg.
   - The import thins the track to at most 500 points and snaps both stops to the track's ends.
6. **Drop photos** onto a stop, or onto the drop zone at the top.
   - Photos are resized in the browser to at most 1600 px and saved as WebP (JPEG in Safari, which cannot encode WebP).
   - When a photo has EXIF GPS, it gets a map position and goes to the nearest stop within 3 km. If no stop is that close, a new stop is created there.
   - Photos without GPS go to the stop with the closest timestamp, or else to the selected stop.
   - Convert iPhone HEIC photos to JPEG first unless you use Safari.
7. **Vlogs:** click **▶ Vlog-Link** on a stop and paste a YouTube or Vimeo link (unlisted works; for unlisted Vimeo keep the hash part of the link). A link the editor doesn't recognize is marked red.
8. Add costs. Each cost has a category, an amount and a currency, and can be linked to a stop. Exchange rates are under `rates` in `trips.json` (1 unit = x EUR). Edit them there.
9. Drafts save automatically to this browser:
   - The JSON goes to localStorage.
   - New photos go to the Cache API.
   - You can close the tab and come back later.

### Publishing

1. In the editor, click **Exportieren (.zip)**. You get `trips-export.zip` with `data/trips.json` and the new photos under `images/…`.
2. Unzip it **into the `trips/` folder** and overwrite `data/trips.json`.
3. Check the result at http://localhost:8123/trips/, then commit and push:

   ```bash
   git add trips && git commit -m "Trip: Lissabon" && git push
   ```

4. Optional: click **Bilder-Cache leeren** and **Entwurf verwerfen**. The editor then starts again from the committed `trips.json`.

You can also edit `data/trips.json` by hand. The editor and the viewer read the same format.

## Data format

```jsonc
{
  "rates": { "EUR": 1, "JPY": 0.0061 },          // static conversion to EUR
  "trips": [{
    "id": "lisbon-2026",                          // URL + image folder
    "title": "…", "start": "2026-05-01", "end": "2026-05-07",
    "cover": "images/lisbon-2026/cover.webp",
    "summary": "…", "tags": ["Stadt"], "countries": ["PT"],
    "stops": [{
      "name": "Alfama", "lngLat": [-9.13, 38.71], // [longitude, latitude]
      "time": "2026-05-02T10:00", "zoom": 14,     // zoom optional (default 13.5)
      "md": "Markdown **text**",
      "photos": [{ "src": "images/…/x.webp", "alt": "Describe the photo", "lngLat": [-9.13, 38.71] | null, "time": null }],
      "videos": [{ "url": "https://youtu.be/…", "title": "Vlog title" }]   // optional, YouTube or Vimeo
    }],
    "legs": [                                     // legs[i] = stop i → stop i+1
      { "mode": "walk", "track": "data/tracks/walk.geojson" },  // or .gpx
      { "mode": "plane" },                        // drawn as a great-circle arc
      { "mode": "car", "coords": [[…], […]] }      // inline track (editor GPX import)
    ],
    "costs": [{ "cat": "food", "amount": 12.5, "cur": "EUR", "stop": 1, "note": "…" }]
  }]
}
```

- **Modes:** `walk`, `car`, `train`, `plane`, `boat`. Their colors, dashes and icons are in `MODES` in `lib.js`.
- **Cost categories:** `transport`, `lodging`, `food`, `activities`, `other`. They are defined in `CATS` in `lib.js`.
- **Photo markers:** only photos with `lngLat` get a round thumbnail on the map. They show from zoom 11 upward.
- **Vlogs:** a stop with a vlog gets a small ▶ badge on its map pin, and the stop card shows the video's thumbnail. The player (youtube-nocookie / Vimeo with `dnt=1`) loads only when someone presses play. The demo vlog on the Lisbon trip is someone else's public video used as a placeholder; replace it with your own.
- **Overview pin:** the trip's pin on the world map sits on its middle stop.

## Deep links

- `#trip=lisbon-2026` opens a trip.
- `#trip=lisbon-2026&stop=3` opens the trip at stop 3 (counting from 1).

In story mode the URL updates as you move between stops, so you can copy and share it at any point.

## Keyboard

| Key | Action |
|---|---|
| `←` `→` (or `k` `j`) | Previous / next stop |
| `Esc` | Back to the overview, or close the lightbox |
| `←` `→` in the lightbox | Previous / next photo |

## Deploying to GitHub Pages

Nothing extra to do. The folder is part of the `maiggooo.github.io` repo, so it is served at `https://maiggooo.github.io/trips/` on the next push. All paths are relative, so the folder also works under any other subpath.

`editor.html` is published too, but it only changes the visitor's own browser storage. Nobody can change your trips through it. To keep it off the live site anyway, move it out of the repo and serve it from a local copy.

## Changing the styling

- **Colors and fonts** come from the main site's `../site.css`: `--paper`, `--ink`, `--accent`, `--muted`, `--rule-soft`, and Fraunces / Inter / JetBrains Mono. Changing them there changes the map too.
- **Shape tokens** are at the top of `trips.css`:
  - `--radius`, `--radius-sm`, `--pill`
  - `--shadow-1`, `--shadow-2`
  - `--panel-w`, `--peek` (how far the mobile bottom sheet opens)
  - `--spring`, `--ease`
  - `--map-bg`, `--casing`, `--pin-ring`

  For the hard-edged editorial look of the rest of the site, set `--radius: 0` and `--shadow-2: 3px 3px 0 var(--ink)`.
- **Basemap:** `STYLES` in `lib.js`. Voyager is used in light mode and Dark Matter in dark mode. They switch with the site's theme toggle.
- **Motion:** all animations respect `prefers-reduced-motion`. With it on, the map jumps instead of flying, the route appears without drawing, and other animations become simple fades.

## Later (not built yet)

The structure leaves room for these:

- **Phone uploads via Firebase/Supabase:** replace the `fetch("data/trips.json")` call at the top of `app.js` with a call to the backend. The editor's `save()` and `addPhotos()` are the two places to send data there instead of localStorage and the Cache API.
- **Private trips:** add `"private": true` to a trip and filter it out in `app.js`. That needs the backend first, because everything in a static repo is public.
