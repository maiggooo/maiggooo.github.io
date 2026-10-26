# Reisekarte (Trip Map)

An interactive, social travel log at `/trips/`. The site itself is static (GitHub Pages, no build step); trips, profiles, follows and photos live in Supabase.

| File | Purpose |
|---|---|
| `index.html`, `app.js` | Viewer: world map, trip list, feed, profiles, story mode, costs, lightbox |
| `editor.html`, `editor.js` | Editor: sign in, add stops, photos, vlogs, costs; saves live |
| `db.js` | Supabase connection and the mapping between database rows and trips |
| `lib.js` | Shared helpers: transport modes, cost categories, exchange rates, distances, GPX parsing |
| `trips.css` | All styling. Design tokens are at the top. |
| `supabase/schema.sql` | Database tables, access rules and photo storage. Already run in the project. |
| `data/trips.json`, `images/`, `data/tracks/` | The original demo trips and their files (now imported into Supabase) |

Libraries are loaded from CDNs with pinned versions:
- MapLibre GL 4.7.1, with free Carto basemaps (no API key)
- supabase-js 2.117.3
- marked 12.0.2, for stop descriptions
- exifr 7.1.3, used in the editor only

## Backend (Supabase)

- **Project:** `reisekarte` (`https://aabwbmfszderdsrphtqg.supabase.co`). `db.js` holds the URL and the *publishable* key. That key is meant to be public; the access rules in `schema.sql` decide what it can do. Never put the secret / `service_role` key in this folder.
- **Who can post:** sign-ups are turned off. Invite people in the dashboard under Authentication → Users → Add user → Send invitation. Supabase's built-in email only reaches members of your Supabase team; for friends, connect an email service first (Authentication → Emails → SMTP, e.g. Resend's free tier).
- **What visitors see:** published trips and everyone's profiles. Private trips are visible only to their owner.
- **Free plan:** 500 MB database, 1 GB photo storage. The project pauses after a week without any traffic.

## Run locally

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123/trips/ for the viewer, or http://localhost:8123/trips/editor.html for the editor. Use `localhost`, not `127.0.0.1`: only `localhost:8123` is allowed as a sign-in return address.

## Adding a trip (editor workflow)

1. Open the editor: click **✎** in the map's top bar (it opens the trip you are viewing), or go to `editor.html`. The first time, enter your email and click the link you receive. **+ Neue Reise** starts a new trip; give it a title. Its link name is generated from the title, and the countries and dates fill themselves in from the stops.
   - **🔒 Privat / 🌍 Öffentlich** at the top decides who sees the trip. New trips start private.
   - Under **Profil** (bottom) set your name and a username; the username gives you a profile link `#u=username`.
2. **Add a stop** in one of four ways:
   - **Search** a place ("Kolosseum Rom") and pick a result.
   - **📍 Ich bin hier** uses your phone's location and the current time.
   - **Tap the map.** The stop is named after the place automatically.
   - **📷 Fotos (mit Ort)**: photos with GPS land at the nearest stop within 3 km, or become a new stop.

   Place names come from OpenStreetMap's Nominatim service.
3. **Fill in a stop.** Tap its card to open it. Everything except the place is optional:
   - time
   - **★ rating** (tap the same star again to clear it)
   - text (Markdown)
   - photos
   - **💶 Ausgabe** (expense): amount, currency (defaults to the one you used last on this trip), what it was for, and a note
   - **▶ Vlog**: a YouTube or Vimeo link (unlisted works; for unlisted Vimeo keep the hash part). A link the editor doesn't recognize is marked red.
4. **Reorder and move.** Drag a card by its `⋮⋮` grip to reorder stops. Drag a marker on the map to move a stop.
5. **How you travelled.** Each card ends with "Weiter zu … mit" to pick the transport mode to the next stop. **GPX** imports a recorded track for that leg; it is thinned to at most 500 points and both stops snap to its ends.
6. **Photos** are resized in the browser to at most 1600 px and saved as WebP (JPEG in Safari, which cannot encode WebP). Convert iPhone HEIC photos to JPEG first unless you use Safari.
7. **Everything saves by itself** about a second after each change. The status next to "+ Neue Reise" shows "✓ Gespeichert"; if it shows "⚠ Nicht gespeichert", tap it to retry. Public trips update for visitors live, without reloading.

Exchange rates for the cost totals are `RATES` in `lib.js` (1 unit = x EUR); currencies listed there appear in the editor.

## Data format

Tables are defined in `supabase/schema.sql`: `profiles`, `trips` (one row per trip; `legs` as JSON), `stops` (one row per stop, ordered by `position`; `photos`, `videos`, `costs` as JSON), `follows`. `db.js` turns rows into the trip objects the viewer and editor use:

```jsonc
{
  "id": "lisbon-2026",          // link name (#trip=…), unique
  "title": "…", "start": "2026-05-01", "end": "2026-05-07", "published": true,
  "cover": "https://…/photo.webp", "summary": "…", "tags": ["Stadt"], "countries": ["PT"],
  "stops": [{
    "name": "Alfama", "lngLat": [-9.13, 38.71], "cc": "PT", "time": "2026-05-02T10:00",
    "md": "Markdown **text**", "rating": 5,
    "photos": [{ "src": "https://…", "alt": "…", "lngLat": [-9.13, 38.71] }],
    "videos": [{ "url": "https://youtu.be/…", "title": "…" }],
    "costs": [{ "cat": "food", "amount": 12.5, "cur": "EUR", "note": "…" }]
  }],
  "legs": [{ "mode": "walk", "coords": [[…], […]] }, { "mode": "plane" }]  // legs[i] = stop i → stop i+1
}
```

- **Modes:** `walk`, `car`, `train`, `plane`, `boat` (`MODES` in `lib.js`). Flights are drawn as great-circle arcs; a leg with `coords` (GPX import) follows the real track.
- **Cost categories:** `food`, `lodging`, `transport`, `activities`, `other` (`CATS` in `lib.js`).
- **Photos:** uploaded to the `photos` storage bucket under `<user id>/<trip id>/`. Only photos with a position get a thumbnail on the map (from zoom 11).
- **Vlogs:** a ▶ badge on the stop's pin; the player loads only on play (youtube-nocookie / Vimeo `dnt=1`). The demo vlog is someone else's public video used as a placeholder.

## Deep links

- `#trip=lisbon-2026` opens a trip.
- `#trip=lisbon-2026&stop=3` opens the trip at stop 3 (counting from 1).
- `#u=username` opens a profile: their trips, their posts in the feed, and a follow button.

In story mode the URL updates as you move between stops, so you can copy and share it at any point.

## Keyboard

| Key | Action |
|---|---|
| `←` `→` (or `k` `j`) | Previous / next stop |
| `Esc` | Back to the overview, or close the lightbox |
| `←` `→` in the lightbox | Previous / next photo |

## Deploying to GitHub Pages

Nothing extra to do. The folder is part of the `maiggooo.github.io` repo, so it is served at `https://maiggooo.github.io/trips/` on the next push. All paths are relative, so the folder also works under any other subpath.

Every push to `main` updates the site; trips and photos don't need a push, they live in Supabase.

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

- **Avatars:** `profiles.avatar_url` exists; the editor needs an upload field.
- **Old photos stay in storage** when you remove them from a stop (so undo works). Clean up in the dashboard under Storage if space gets tight.
