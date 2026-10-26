import { MODES, CATS, STYLES, RATES, esc, resolveLegs, toEUR, tripDays, fmtRange, fmtTime, fmtEUR, countryName, parseVideo, allCosts } from "./lib.js";
import { sb, TRIP_SELECT, fromRow, profileLink } from "./db.js";

const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const theme = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isMobile = () => matchMedia("(max-width: 760px)").matches;

// RLS returns published trips plus, when signed in, your own drafts.
async function loadTrips() {
  const { data, error } = await sb.from("trips").select(TRIP_SELECT).order("start_date", { ascending: false });
  if (error) { console.error(error); return []; }
  return data.map(fromRow).filter(t => t.stops.length);
}
// The session is shared with the editor (same origin), so signing in there counts here too.
const session = (await sb.auth.getSession()).data.session;
let [trips, following] = await Promise.all([loadTrips(), loadFollowing()]);
let tab = "trips", feedMode = "all", profile = null;

async function loadFollowing() {
  if (!session) return new Set();
  const { data } = await sb.from("follows").select("followee").eq("follower", session.user.id);
  return new Set((data || []).map(f => f.followee));
}

const panel = $("#panel"), scroller = $("#panelScroll"), body = $("#panelBody");
let current = null, stopIdx = -1, routeData = empty(), drawRaf = 0;
let stopMarkers = [], photoMarkers = [], vehicle = null;
const overviewMarkers = new Map();
const filter = { q: "", year: "", tag: "", country: "", owner: "" };
const initial = p => (p?.name || p?.handle || "?").trim()[0].toUpperCase();
// Without a handle there's no profile page yet, so the name is plain text
const byLine = p => !p ? "" : `<${p.handle ? `a href="${profileLink(p)}"` : "span"} class="by"><span class="avatar" aria-hidden="true">${esc(initial(p))}</span>${esc(p.name || p.handle)}</${p.handle ? "a" : "span"}>`;

function empty() { return { type: "FeatureCollection", features: [] }; }

/* ————————————— MAP ————————————— */
let styleKey = theme();
const map = new maplibregl.Map({
  container: "map", style: STYLES[styleKey], center: [20, 35], zoom: 1.6,
  attributionControl: { compact: true }, fadeDuration: RM ? 0 : 300,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

// site.js toggles data-theme; swap basemap with it. diff:false so style.load always fires.
new MutationObserver(() => {
  if (theme() === styleKey) return;
  styleKey = theme();
  map.setStyle(STYLES[styleKey], { diff: false });
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

map.on("style.load", () => {
  try { map.setPaintProperty("background", "background-color", cssVar("--map-bg")); } catch {}
  map.addSource("trips", { type: "geojson", data: tripsGeo(), cluster: true, clusterRadius: 60, clusterMaxZoom: 7 });
  // Invisible layer: makes the source load so querySourceFeatures works; markers are HTML.
  map.addLayer({ id: "trips-hit", type: "circle", source: "trips", paint: { "circle-opacity": 0, "circle-radius": 1 } });
  map.addSource("route", { type: "geojson", data: routeData });
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": cssVar("--casing"), "line-width": 9, "line-opacity": .9 } });
  for (const [m, s] of Object.entries(MODES)) {
    map.addLayer({ id: "route-" + m, type: "line", source: "route", filter: ["==", ["get", "mode"], m],
      layout: { "line-cap": s.dash ? "butt" : "round", "line-join": "round" },
      paint: { "line-color": s.color, "line-width": 5, ...(s.dash && { "line-dasharray": s.dash }) } });
  }
});

map.on("data", e => { if (e.sourceId === "trips" && e.isSourceLoaded) syncOverview(); });
map.on("moveend", syncOverview);
// Photo pins only make sense up close; far out they'd hide the stop numbers
const zoomClass = () => document.body.classList.toggle("far", map.getZoom() < 11);
map.on("zoomend", zoomClass);

function tripsGeo() {
  return { type: "FeatureCollection", features: visibleTrips().map(t => ({
    type: "Feature", properties: { id: t.id },
    geometry: { type: "Point", coordinates: t.stops[Math.floor(t.stops.length / 2)].lngLat },
  })) };
}

function padding() {
  if (isMobile()) return { top: 90, left: 30, right: 30, bottom: panel.getBoundingClientRect().height * (panel.classList.contains("expanded") ? 0.15 : 1) + 30 };
  // offset* ignores the slide-in transform, so this is right even mid-animation
  return { top: 90, bottom: 50, right: 80, left: panel.offsetLeft + panel.offsetWidth + 70 };
}

function fitCoords(coords, opts = {}) {
  const b = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); // flyTo({padding}) persists and would add up
  const maxZoom = opts.maxZoom ?? 13;
  const cam = map.cameraForBounds(b, { padding: padding(), maxZoom }) || map.cameraForBounds(b, { padding: 10, maxZoom });
  if (!cam) return Promise.resolve();
  const done = new Promise(r => map.once("moveend", r));
  map.flyTo({ ...cam, duration: RM ? 0 : 2200, essential: false });
  return done;
}

/* ————————————— OVERVIEW MARKERS ————————————— */
function syncOverview() {
  if (current || !map.getSource("trips")) return;
  const seen = new Set();
  let n = 0;
  for (const f of map.querySourceFeatures("trips")) {
    const p = f.properties, key = p.cluster ? "c" + p.cluster_id : p.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!overviewMarkers.has(key)) overviewMarkers.set(key, overviewMarker(f, n++));
  }
  for (const [k, m] of overviewMarkers) if (!seen.has(k)) { m.remove(); overviewMarkers.delete(k); }
}

function overviewMarker(f, i) {
  const p = f.properties, wrap = document.createElement("div");
  if (p.cluster) {
    wrap.innerHTML = `<button class="pin cluster drop" style="--i:${i}" aria-label="${p.point_count} Reisen — heranzoomen">${p.point_count}</button>`;
    wrap.firstChild.onclick = async () => {
      const z = await map.getSource("trips").getClusterExpansionZoom(p.cluster_id);
      map.easeTo({ center: f.geometry.coordinates, zoom: z + .5, duration: RM ? 0 : 800 });
    };
  } else {
    const t = trips.find(t => t.id === p.id);
    wrap.innerHTML = `<button class="pin trip-pin drop" style="--i:${i}" data-trip="${esc(t.id)}" aria-label="Reise öffnen: ${esc(t.title)}">
      <img src="${esc(t.cover)}" alt="" loading="lazy"><span class="pin-label">${esc(t.title)}</span></button>`;
    wrap.firstChild.onclick = () => location.hash = "trip=" + t.id;
  }
  return new maplibregl.Marker({ element: wrap, anchor: p.cluster ? "center" : "bottom" }).setLngLat(f.geometry.coordinates).addTo(map);
}

function clearOverviewMarkers() { overviewMarkers.forEach(m => m.remove()); overviewMarkers.clear(); }

/* ————————————— OVERVIEW PANEL ————————————— */
function visibleTrips() {
  const q = filter.q.toLowerCase();
  return trips.filter(t =>
    (!filter.owner || t.owner?.handle === filter.owner) &&
    (!filter.year || t.start.startsWith(filter.year)) &&
    (!filter.tag || t.tags?.includes(filter.tag)) &&
    (!filter.country || t.countries?.includes(filter.country)) &&
    (!q || [t.title, t.summary, ...(t.tags || []), ...(t.countries || []).map(countryName), ...t.stops.map(s => s.name)]
      .join(" ").toLowerCase().includes(q)));
}

function options(values, label, sel, fmt = v => v) {
  return `<option value="">${label}</option>` + [...new Set(values)].sort().map(v => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(fmt(v))}</option>`).join("");
}

function profileHead() {
  const own = profile.id === session?.user.id, n = visibleTrips().length;
  const btn = own ? `<a class="btn ghost" href="editor.html">Profil bearbeiten</a>`
    : session ? `<button class="btn ${following.has(profile.id) ? "ghost" : "primary"}" id="followBtn">${following.has(profile.id) ? "Entfolgen" : "Folgen"}</button>`
    : `<a class="btn ghost" href="editor.html">Anmelden zum Folgen</a>`;
  return `
    <a class="back-link" href="#">← Alle Reisen</a>
    <div class="panel-head profile-head">
      <span class="avatar big" aria-hidden="true">${esc(initial(profile))}</span>
      <div><h1 class="title">${esc(profile.name || profile.handle)}</h1><p class="kicker">@${esc(profile.handle)} · ${n} Reise${n === 1 ? "" : "n"}</p></div>
    </div>
    ${profile.bio ? `<p class="summary">${esc(profile.bio)}</p>` : ""}
    <div class="profile-actions">${btn}</div>`;
}

function renderOverview() {
  setPanel(`
    ${profile ? profileHead() : `<div class="panel-head">
      <p class="kicker">Reise­tagebuch · ${trips.length} Reisen</p>
      <h1 class="title">Wo wir <em>waren</em></h1>
    </div>`}
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="trips" aria-selected="${tab === "trips"}">Reisen</button>
      <button role="tab" data-tab="feed" aria-selected="${tab === "feed"}">Feed</button>
    </div>
    <div id="feedBox" ${tab === "feed" ? "" : "hidden"}></div>
    <div id="tripsBox" ${tab === "trips" ? "" : "hidden"}>
    <div class="filters" role="group" aria-label="Filter">
      <select id="fYear" aria-label="Jahr">${options(trips.map(t => t.start.slice(0, 4)), "Alle Jahre", filter.year)}</select>
      <select id="fTag" aria-label="Tag">${options(trips.flatMap(t => t.tags || []), "Alle Tags", filter.tag)}</select>
      <select id="fCountry" aria-label="Land">${options(trips.flatMap(t => t.countries || []), "Alle Länder", filter.country, countryName)}</select>
    </div>
    <ul class="trip-list" id="tripList"></ul>
    </div>`);
  $("#editLink").href = "editor.html";
  body.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { tab = b.dataset.tab; renderOverview(); });
  $("#followBtn")?.addEventListener("click", toggleFollow);
  if (tab === "feed") renderFeed();
  for (const [id, key] of [["fYear", "year"], ["fTag", "tag"], ["fCountry", "country"]])
    $("#" + id).onchange = e => { filter[key] = e.target.value; applyFilter(); };
  renderList();
}

function renderList() {
  const list = visibleTrips();
  $("#tripList").innerHTML = list.length ? list.map(t => `
    <li class="card trip-card reveal-card" data-trip="${esc(t.id)}">
      <a href="#trip=${esc(t.id)}">
        <img src="${esc(t.cover)}" alt="" loading="lazy">
        <div>
          <h2>${esc(t.title)}</h2>
          <p class="meta">${fmtRange(t)} · ${tripDays(t)} Tage</p>
          <p class="tags">${(t.tags || []).map(x => `<span class="chip">${esc(x)}</span>`).join("")}${vlogCount(t) ? `<span class="chip ghost">▶ ${vlogCount(t)} Vlog${vlogCount(t) > 1 ? "s" : ""}</span>` : ""}</p>
        </div>
      </a>
    </li>`).join("") : `<li class="empty">Keine Reise passt zum Filter.</li>`;
  list.forEach(t => {
    const li = $(`[data-trip="${CSS.escape(t.id)}"]`, $("#tripList"));
    li.onmouseenter = () => $(`.trip-pin[data-trip="${CSS.escape(t.id)}"]`)?.classList.add("hot");
    li.onmouseleave = () => $(`.trip-pin[data-trip="${CSS.escape(t.id)}"]`)?.classList.remove("hot");
  });
  observeCards();
}

const vlogCount = t => t.stops.reduce((n, s) => n + (s.videos?.length || 0), 0);

function applyFilter() {
  if (current) return;
  renderList();
  clearOverviewMarkers();
  map.getSource("trips")?.setData(tripsGeo());
}

$("#q").addEventListener("input", e => {
  filter.q = e.target.value;
  if (current) location.hash = ""; else applyFilter();
});

async function showOverview() {
  const wasTrip = current;
  clearTrip();
  current = null;
  if (wasTrip || !$("#tripList") || (profile?.handle || "") !== filter.owner) {
    profile = filter.owner ? await loadProfile(filter.owner) : null;
    renderOverview();
  }
  map.getSource("trips")?.setData(tripsGeo());
  const pts = visibleTrips().map(t => t.stops[Math.floor(t.stops.length / 2)].lngLat);
  if (pts.length) await fitCoords(pts, { maxZoom: 5 });
  syncOverview();
}

/* ————————————— FEED, PROFILES, FOLLOWS ————————————— */
async function loadProfile(handle) {
  const known = trips.find(t => t.owner?.handle === handle)?.owner;
  if (known) return known;
  const { data } = await sb.from("profiles").select("id, handle, name, bio").eq("handle", handle).maybeSingle();
  return data;
}

async function toggleFollow() {
  const on = following.has(profile.id);
  const { error } = on
    ? await sb.from("follows").delete().eq("follower", session.user.id).eq("followee", profile.id)
    : await sb.from("follows").insert({ followee: profile.id });
  if (error) return console.error(error);
  on ? following.delete(profile.id) : following.add(profile.id);
  renderOverview();
}

const ago = d => {
  const s = (new Date(d) - Date.now()) / 1000, rtf = new Intl.RelativeTimeFormat("de", { numeric: "auto" });
  for (const [unit, sec] of [["year", 31536e3], ["month", 2592e3], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]])
    if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
  return "gerade eben";
};

async function renderFeed() {
  const box = $("#feedBox");
  if (!box) return;
  const { data, error } = await sb.from("stops")
    .select("id, name, position, created_at, photos, videos, rating, md, trip:trips!inner(slug, title, owner:profiles(id, handle, name))")
    .order("created_at", { ascending: false }).limit(40);
  if (!$("#feedBox")) return; // panel changed while loading
  const items = (data || []).filter(s =>
    (!filter.owner || s.trip.owner?.handle === filter.owner) &&
    (feedMode === "all" || following.has(s.trip.owner?.id) || s.trip.owner?.id === session?.user.id));
  box.innerHTML = `
    ${session && !filter.owner ? `<div class="seg" role="group" aria-label="Feed-Filter">
      <button data-mode="all" aria-pressed="${feedMode === "all"}">Alle</button>
      <button data-mode="following" aria-pressed="${feedMode === "following"}">Folge ich</button></div>` : ""}
    ${error ? `<p class="empty">Feed gerade nicht erreichbar.</p>` : !items.length ? `<p class="empty">${feedMode === "following" ? "Noch nichts von Leuten, denen du folgst." : "Noch keine Beiträge."}</p>` : ""}
    <ul class="feed">${items.map(s => {
      const p = s.photos?.[0], o = s.trip.owner, text = (s.md || "").replace(/[*_#>`\[\]()]/g, "").slice(0, 140);
      return `<li class="card feed-item reveal-card">
        <div class="feed-head">${byLine(o)}<span class="meta">${ago(s.created_at)}</span></div>
        <a class="feed-body" href="#trip=${encodeURIComponent(s.trip.slug)}&stop=${s.position + 1}">
          ${p ? `<img src="${esc(p.src)}" alt="${esc(p.alt)}" loading="lazy">` : ""}
          <strong>${esc(s.name)}${s.rating ? ` <span class="rating">${"★".repeat(s.rating)}</span>` : ""}${s.videos?.length ? " ▶" : ""}</strong>
          <span class="meta">${esc(s.trip.title)}</span>
          ${text ? `<span class="feed-text">${esc(text)}${s.md.length > 140 ? " …" : ""}</span>` : ""}
        </a></li>`;
    }).join("")}</ul>`;
  box.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { feedMode = b.dataset.mode; renderFeed(); });
  observeCards();
}

// Live updates: someone adds or edits a stop → refresh lists; an open trip gets a reload button.
let refreshTimer;
sb.channel("stops-live").on("postgres_changes", { event: "*", schema: "public", table: "stops" }, () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    trips = await loadTrips();
    if (!current) { renderList(); if (tab === "feed") renderFeed(); map.getSource("trips")?.setData(tripsGeo()); }
    else $("#livePill").hidden = false;
  }, 1500);
}).subscribe();

$("#livePill").onclick = () => {
  $("#livePill").hidden = true;
  const id = current?.id;
  current = null;
  if (id) openTrip(id);
};

/* ————————————— TRIP ————————————— */
async function openTrip(id, stop) {
  const trip = trips.find(t => t.id === id);
  if (!trip) return showOverview();
  if (current !== trip) {
    clearTrip();
    clearOverviewMarkers();
    current = trip;
    stopIdx = -1;
    trip._legs ??= await resolveLegs(trip);
    if (current !== trip) return; // user navigated away while tracks loaded
    renderTrip(trip);
    if (stop == null) await fitCoords(trip._legs.flatMap(l => l.coords).concat(trip.stops.map(s => s.lngLat)));
    if (current !== trip) return;
    drawRoute(trip);
  }
  if (stop != null) goStop(stop);
}

function clearTrip() {
  cancelAnimationFrame(drawRaf);
  [...stopMarkers, ...photoMarkers].forEach(m => m.remove());
  stopMarkers = []; photoMarkers = [];
  vehicle?.remove(); vehicle = null;
  routeData = empty();
  map.getSource("route")?.setData(routeData);
  $("#storyNav").hidden = true;
  stopIdx = -1;
}

// Partial line along coords at fraction f of its length.
function partial(leg, f) {
  const target = leg.km * f, c = leg.coords, cum = leg.cum;
  let i = 1;
  while (i < c.length - 1 && cum[i] < target) i++;
  const seg = cum[i] - cum[i - 1] || 1, k = Math.max(0, Math.min(1, (target - cum[i - 1]) / seg));
  const tip = [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * k, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * k];
  return { coords: [...c.slice(0, i), tip], tip, from: c[i - 1], to: c[i] };
}

const ease = t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

function drawRoute(trip) {
  const legs = trip._legs, n = legs.length;
  const feature = (leg, coords) => ({ type: "Feature", properties: { mode: leg.mode }, geometry: { type: "LineString", coordinates: coords } });
  let popped = 0;
  const pop = upto => { while (popped <= upto && popped < trip.stops.length) addStopMarker(trip, popped++); };

  if (RM || !n) {
    routeData = { type: "FeatureCollection", features: legs.map(l => feature(l, l.coords)) };
    map.getSource("route")?.setData(routeData);
    pop(Infinity); addPhotoMarkers(trip);
    return;
  }
  // Every leg gets the same time, so a 9000 km flight doesn't dwarf a city walk.
  const perLeg = Math.max(700, Math.min(1400, 5200 / n)), t0 = performance.now();
  // MapLibre owns the wrapper's transform, so rotation goes on the inner element
  const wrap = document.createElement("div"), el = wrap.appendChild(document.createElement("span"));
  el.className = "vehicle";
  wrap.style.zIndex = 3;
  vehicle = new maplibregl.Marker({ element: wrap }).setLngLat(legs[0].coords[0]).addTo(map);

  const frame = now => {
    // rAF time can predate t0, hence the max(0)
    const p = Math.max(0, Math.min(n, (now - t0) / perLeg)), i = Math.min(n - 1, Math.floor(p)), f = p >= n ? 1 : ease(p - i);
    pop(Math.floor(p));
    const part = partial(legs[i], f);
    routeData = { type: "FeatureCollection", features: [...legs.slice(0, i).map(l => feature(l, l.coords)), feature(legs[i], part.coords)] };
    map.getSource("route")?.setData(routeData);
    const mode = MODES[legs[i].mode] || MODES.car;
    if (el.dataset.mode !== legs[i].mode) { el.dataset.mode = legs[i].mode; el.textContent = mode.icon; el.style.borderColor = mode.color; }
    vehicle.setLngLat(part.tip);
    if (legs[i].mode === "plane") {
      const a = map.project(part.from), b = map.project(part.to);
      el.style.setProperty("--rot", Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 45 + "deg"); // ✈️ points up-right
    } else el.style.setProperty("--rot", "0deg");
    if (p < n) drawRaf = requestAnimationFrame(frame);
    else { pop(Infinity); vehicle.remove(); vehicle = null; addPhotoMarkers(trip); }
  };
  drawRaf = requestAnimationFrame(frame);
}

function addStopMarker(trip, i) {
  const s = trip.stops[i], wrap = document.createElement("div");
  const vlog = s.videos?.length ? `<span class="badge" aria-hidden="true">▶</span>` : "";
  wrap.innerHTML = `<button class="pin stop-pin drop" aria-label="Stopp ${i + 1}: ${esc(s.name)}${vlog ? " (mit Vlog)" : ""}">${i + 1}${vlog}</button>`;
  wrap.firstChild.onclick = () => goStop(i);
  if (i === stopIdx) wrap.firstChild.classList.add("active");
  wrap.style.zIndex = 2; // above photo pins
  stopMarkers[i] = new maplibregl.Marker({ element: wrap }).setLngLat(s.lngLat).addTo(map);
}

function addPhotoMarkers(trip) {
  let n = 0;
  trip.stops.forEach((s, si) => s.photos?.forEach((ph, pi) => {
    if (!ph.lngLat) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = `<button class="pin photo-pin drop" style="--i:${n++}" aria-label="Foto öffnen: ${esc(ph.alt)}"><img src="${esc(ph.src)}" alt="" loading="lazy"></button>`;
    wrap.firstChild.onclick = e => openLightbox(s.photos, pi, e.currentTarget.firstChild);
    photoMarkers.push(new maplibregl.Marker({ element: wrap }).setLngLat(ph.lngLat).addTo(map));
  }));
}

/* ————————————— TRIP PANEL ————————————— */
function renderTrip(t) {
  const km = t._legs.reduce((s, l) => s + l.km, 0);
  const photos = t.stops.reduce((s, x) => s + (x.photos?.length || 0), 0);
  const costs = allCosts(t).filter(c => c.amount > 0).map(c => ({ ...c, eur: toEUR(c.amount, c.cur) }));
  const total = costs.reduce((s, c) => s + c.eur, 0);
  const stopCosts = i => costs.filter(c => c.stop === i);
  const rated = t.stops.filter(s => s.rating), avg = rated.reduce((n, s) => n + s.rating, 0) / rated.length;
  const starRow = n => `<span class="rating" role="img" aria-label="${n} von 5 Sternen">${"★".repeat(n)}<span class="dim">${"★".repeat(5 - n)}</span></span>`;

  setPanel(`
    <a class="back-link" href="#">← Alle Reisen</a>
    <img class="cover" src="${esc(t.cover)}" alt="${esc(t.title)}">
    <div class="panel-head">
      <p class="kicker">${fmtRange(t)}${t.published ? "" : " · 🔒 privat"}</p>
      <h1 class="title">${esc(t.title)}</h1>
      ${byLine(t.owner)}
      <p class="tags">${(t.tags || []).map(x => `<span class="chip">${esc(x)}</span>`).join("")}
        ${(t.countries || []).map(c => `<span class="chip ghost">${esc(countryName(c))}</span>`).join("")}
        ${rated.length ? `<span class="chip ghost" title="Durchschnitt aus ${rated.length} Bewertungen">★ ${avg.toFixed(1).replace(".", ",")}</span>` : ""}</p>
      <p class="summary">${esc(t.summary)}</p>
    </div>
    <dl class="stats">
      <div><dt>km</dt><dd data-count="${km}">0</dd></div>
      <div><dt>Länder</dt><dd data-count="${t.countries?.length || 0}">0</dd></div>
      <div><dt>Tage</dt><dd data-count="${tripDays(t)}">0</dd></div>
      <div><dt>Fotos</dt><dd data-count="${photos}">0</dd></div>
    </dl>
    <button class="btn primary" id="startStory">Story starten <span aria-hidden="true">→</span></button>
    <p class="legend">${[...new Set(t._legs.map(l => l.mode))].map(m => `<span><i style="--c:${MODES[m].color}"></i>${MODES[m].icon} ${MODES[m].label}</span>`).join("")}</p>
    ${costs.length ? costPanel(costs, total, tripDays(t)) : ""}
    <h2 class="section">Stopps</h2>
    <ol class="stops">${t.stops.map((s, i) => `
      <li class="card stop-card reveal-card" data-stop="${i}" id="stop-${i}">
        <button class="stop-head" data-go="${i}">
          <span class="num">${i + 1}</span>
          <span><strong>${esc(s.name)}</strong><span class="meta">${fmtTime(s.time)}</span></span>
          ${s.rating ? starRow(s.rating) : ""}
        </button>
        <div class="md">${marked.parse(s.md || "")}</div>
        ${s.photos?.length ? `<div class="gallery">${s.photos.map((p, pi) =>
          `<button data-ph="${pi}" aria-label="Foto vergrößern: ${esc(p.alt)}"><img src="${esc(p.src)}" alt="${esc(p.alt)}" loading="lazy"></button>`).join("")}</div>` : ""}
        ${(s.videos || []).map(vlogHTML).join("")}
        ${stopCosts(i).length ? `<p class="stop-costs">${stopCosts(i).map(c =>
          `<span title="${esc(CATS[c.cat]?.label)}">${CATS[c.cat]?.icon || ""} ${fmtEUR(c.eur, c.eur < 100 ? 2 : 0)}${c.note ? ` <span class="meta">${esc(c.note)}</span>` : ""}</span>`).join("")}</p>` : ""}
        ${i < t._legs.length ? `<p class="leg"><span style="--c:${MODES[t._legs[i].mode].color}">${MODES[t._legs[i].mode].icon}</span> ${MODES[t._legs[i].mode].label} · ${Math.round(t._legs[i].km)} km</p>` : ""}
      </li>`).join("")}
    </ol>`);

  $("#editLink").href = "editor.html#trip=" + encodeURIComponent(t.id);
  $("#startStory").onclick = () => goStop(0);
  body.querySelectorAll(".vlog").forEach(b => b.onclick = () => playVlog(b));
  body.querySelectorAll("[data-go]").forEach(b => b.onclick = () => goStop(+b.dataset.go));
  body.querySelectorAll(".stop-card").forEach(card => {
    const photos = t.stops[+card.dataset.stop].photos;
    card.querySelectorAll("[data-ph]").forEach(b => b.onclick = () => openLightbox(photos, +b.dataset.ph, b.firstChild));
  });
  body.querySelectorAll("[data-count]").forEach(el => countUp(el, +el.dataset.count));
  animateDonut();
  observeCards();
  observeStops();
  $("#storyNav").hidden = false;
  updateStoryLabel();
}

// The player iframe only loads on click, so no YouTube/Vimeo requests before that.
function vlogHTML(v) {
  const p = parseVideo(v.url);
  if (!p) return "";
  const title = esc(v.title || "Vlog");
  return `<button class="vlog" data-embed="${esc(p.embed)}" data-title="${title}" aria-label="Vlog abspielen: ${title}">
    ${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : ""}
    <span class="play" aria-hidden="true">▶</span><span class="vlog-title">${title}</span></button>`;
}

function playVlog(b) {
  const f = Object.assign(document.createElement("iframe"), {
    className: "vlog", src: b.dataset.embed, title: b.dataset.title, allowFullscreen: true,
    allow: "autoplay; fullscreen; picture-in-picture; encrypted-media",
  });
  b.replaceWith(f);
  f.focus();
}

function costPanel(costs, total, days) {
  const by = Object.keys(CATS).map(k => ({ k, eur: costs.filter(c => c.cat === k).reduce((s, c) => s + c.eur, 0) })).filter(x => x.eur);
  let off = 0;
  const arcs = by.map(x => {
    const pct = x.eur / total * 100, arc = `<circle r="15.915" cx="18" cy="18" pathLength="100" stroke="${CATS[x.k].color}"
      stroke-dasharray="0 100" data-dash="${pct} ${100 - pct}" stroke-dashoffset="${-off}"><title>${CATS[x.k].label}: ${fmtEUR(x.eur)}</title></circle>`;
    off += pct;
    return arc;
  }).join("");
  const foreign = costs.some(c => c.cur !== "EUR");
  return `
    <h2 class="section">Kosten</h2>
    <div class="card costs">
      <svg class="donut" viewBox="0 0 36 36" role="img" aria-label="Kosten nach Kategorie">${arcs}</svg>
      <div>
        <p class="big" data-count="${total}" data-eur>0</p>
        <p class="meta">${fmtEUR(total / days)} pro Tag${foreign ? " · umgerechnet" : ""}</p>
        <ul class="cat-list">${by.map(x => `<li><i style="--c:${CATS[x.k].color}"></i>${CATS[x.k].label}<span>${fmtEUR(x.eur)}</span></li>`).join("")}</ul>
      </div>
    </div>
    ${foreign ? `<p class="fine">Statische Kurse: ${Object.entries(RATES).filter(([k]) => k !== "EUR").map(([k, v]) => `1 ${k} = ${v} €`).join(" · ")}</p>` : ""}`;
}

function animateDonut() {
  const arcs = body.querySelectorAll(".donut circle");
  requestAnimationFrame(() => requestAnimationFrame(() => arcs.forEach((c, i) => {
    c.style.transitionDelay = RM ? "0s" : i * 0.12 + "s";
    c.setAttribute("stroke-dasharray", c.dataset.dash);
  })));
}

function countUp(el, to) {
  const fmt = v => el.hasAttribute("data-eur") ? fmtEUR(v) : Math.round(v).toLocaleString("de-DE");
  if (RM) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), d = 1300;
  const f = now => {
    const k = Math.min(1, (now - t0) / d);
    el.textContent = fmt(to * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}

/* ————————————— STORY MODE ————————————— */
let ignoreScrollUntil = 0;

function goStop(i, { scroll = true } = {}) {
  const t = current;
  if (!t) return;
  i = Math.max(0, Math.min(t.stops.length - 1, i));
  stopIdx = i;
  const s = t.stops[i];
  map.flyTo({ center: s.lngLat, zoom: s.zoom ?? 13.5, padding: padding(), duration: RM ? 0 : 2400, curve: 1.5, essential: false });
  stopMarkers.forEach((m, k) => m?.getElement().firstChild.classList.toggle("active", k === i));
  body.querySelectorAll(".stop-card").forEach(c => c.classList.toggle("active", +c.dataset.stop === i));
  if (scroll) {
    ignoreScrollUntil = performance.now() + 1200;
    $("#stop-" + i)?.scrollIntoView({ behavior: RM ? "auto" : "smooth", block: "start" });
  }
  updateStoryLabel();
  history.replaceState(null, "", `#trip=${t.id}&stop=${i + 1}`);
}

function updateStoryLabel() {
  if (!current) return;
  $("#storyLabel").textContent = stopIdx < 0 ? `${current.stops.length} Stopps` : `${stopIdx + 1} / ${current.stops.length} · ${current.stops[stopIdx].name}`;
  $("#prevStop").disabled = stopIdx <= 0;
  $("#nextStop").disabled = stopIdx >= current.stops.length - 1;
}

$("#prevStop").onclick = () => goStop(stopIdx - 1);
$("#nextStop").onclick = () => goStop(stopIdx + 1);

addEventListener("keydown", e => {
  if (!current || $("#lightbox").open || e.target.closest("input, select, textarea")) return;
  if (e.key === "ArrowRight" || e.key === "j") { e.preventDefault(); goStop(stopIdx + 1); }
  else if (e.key === "ArrowLeft" || e.key === "k") { e.preventDefault(); goStop(stopIdx - 1); }
  else if (e.key === "Escape") location.hash = "";
});

// Scrolling the panel steps through stops: the card crossing the upper band becomes active.
let stopIO;
function observeStops() {
  stopIO?.disconnect();
  stopIO = new IntersectionObserver(entries => {
    if (performance.now() < ignoreScrollUntil || stopIdx < 0) return; // story starts with the button / keys
    const hit = entries.find(e => e.isIntersecting);
    if (hit && +hit.target.dataset.stop !== stopIdx) goStop(+hit.target.dataset.stop, { scroll: false });
  }, { root: scroller, rootMargin: "-25% 0px -65% 0px" });
  body.querySelectorAll(".stop-card").forEach(c => stopIO.observe(c));
}

/* ————————————— PANEL / SHEET ————————————— */
let cardIO;
function observeCards() {
  cardIO ??= new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); cardIO.unobserve(e.target); } }), { root: scroller, rootMargin: "0px 0px -5% 0px" });
  body.querySelectorAll(".reveal-card:not(.in)").forEach(c => cardIO.observe(c));
}

function setPanel(html) {
  body.innerHTML = html;
  scroller.scrollTop = 0;
  if (!RM) body.animate([{ opacity: 0, transform: "translateY(14px) scale(.985)" }, { opacity: 1, transform: "none" }],
    { duration: 520, easing: "cubic-bezier(.2,1.3,.4,1)" });
}

// Mobile bottom sheet: tap the handle to toggle, or drag it.
const handle = $("#sheetHandle");
function setSheet(open) { panel.classList.toggle("expanded", open); handle.setAttribute("aria-expanded", open); }
handle.addEventListener("pointerdown", e => {
  if (!isMobile()) return;
  const y0 = e.clientY, start = panel.getBoundingClientRect().top;
  let dy = 0;
  handle.setPointerCapture(e.pointerId);
  panel.classList.add("dragging");
  const move = ev => { dy = ev.clientY - y0; panel.style.transform = `translateY(${Math.max(0, start + dy - panel.offsetTop)}px)`; };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    panel.classList.remove("dragging");
    panel.style.transform = "";
    setSheet(Math.abs(dy) < 6 ? !panel.classList.contains("expanded") : dy < 0);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up, { once: true });
  handle.addEventListener("pointercancel", up, { once: true });
});

/* ————————————— LIGHTBOX (shared-element zoom) ————————————— */
const lb = $("#lightbox"), lbImg = $("#lbImg");
let lbPhotos = [], lbIdx = 0, lbThumb = null;

function lbShow(i, dir = 0) {
  lbIdx = (i + lbPhotos.length) % lbPhotos.length;
  const p = lbPhotos[lbIdx];
  lbImg.src = p.src; lbImg.alt = p.alt || "";
  $("#lbCap").textContent = p.alt || "";
  $("#lbCount").textContent = `${lbIdx + 1} / ${lbPhotos.length}`;
  if (dir && !RM) lbImg.animate([{ opacity: 0, transform: `translateX(${dir * 40}px)` }, { opacity: 1, transform: "none" }], { duration: 280, easing: "ease-out" });
}

function flip(from, to) {
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  return `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${a.width / b.width})`;
}

async function openLightbox(photos, i, thumb) {
  lbPhotos = photos; lbThumb = thumb;
  lbShow(i);
  lb.showModal();
  if (RM || !thumb) return;
  await lbImg.decode().catch(() => {});
  lbImg.animate([{ transform: flip(thumb, lbImg), borderRadius: "50%" }, { transform: "none", borderRadius: "12px" }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
}

async function closeLightbox() {
  // Zoom back into the thumbnail only if it's still the photo we opened from
  const back = lbThumb?.isConnected && lbThumb.getAttribute("src") === lbPhotos[lbIdx].src;
  if (!RM && back) await lbImg.animate([{ transform: "none" }, { transform: flip(lbThumb, lbImg), opacity: .4 }], { duration: 300, easing: "cubic-bezier(.4,0,.2,1)" }).finished;
  lb.close();
}

$("#lbClose").onclick = closeLightbox;
$("#lbPrev").onclick = () => lbShow(lbIdx - 1, -1);
$("#lbNext").onclick = () => lbShow(lbIdx + 1, 1);
lb.addEventListener("cancel", e => { e.preventDefault(); closeLightbox(); });
lb.addEventListener("click", e => { if (e.target === lb) closeLightbox(); });
lb.addEventListener("keydown", e => {
  if (e.key === "ArrowRight") lbShow(lbIdx + 1, 1);
  if (e.key === "ArrowLeft") lbShow(lbIdx - 1, -1);
});
let swipeX = null;
lbImg.addEventListener("pointerdown", e => { swipeX = e.clientX; });
lbImg.addEventListener("pointerup", e => {
  const dx = e.clientX - (swipeX ?? e.clientX);
  swipeX = null;
  if (Math.abs(dx) > 50) lbShow(lbIdx + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
});

/* ————————————— ROUTING ————————————— */
function route() {
  const h = new URLSearchParams(location.hash.slice(1));
  const id = h.get("trip"), s = h.get("stop");
  filter.owner = h.get("u") || "";
  if (id) openTrip(id, s ? +s - 1 : null);
  else showOverview();
}
addEventListener("hashchange", route);
renderOverview(); // paint the list right away; the map catches up on load
map.once("load", route);