// Trip editor. Signed-in users edit their own trips; every change saves to Supabase
// a moment later (debounced), photos upload straight to Supabase Storage.
import { MODES, CATS, STYLES, RATES, esc, parseGPX, haversine, legCoords, parseVideo } from "./lib.js";
import { sb, TRIP_SELECT, fromRow, toRows } from "./db.js";

const $ = s => document.querySelector(s);
const ed = $("#ed");
let data, sel = 0, selStop = -1, me = null, profile = null;

const trip = () => data.trips[sel];
const uuid = () => crypto.randomUUID();
const list = s => s.split(",").map(x => x.trim()).filter(Boolean);
const slug = s => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "reise";
const round = n => Math.round(n * 1e5) / 1e5;
const localISO = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);

function toast(msg, undo) {
  const t = document.body.appendChild(Object.assign(document.createElement("div"), { className: "toast", textContent: msg, role: "status" }));
  if (undo) {
    const b = t.appendChild(Object.assign(document.createElement("button"), { className: "toast-undo", textContent: "Rückgängig" }));
    b.onclick = () => { undo(); t.remove(); };
  }
  setTimeout(() => t.remove(), undo ? 6000 : 2600);
}

// Deletes happen at once with an undo toast instead of confirm(): some in-app
// and mobile browsers block native dialogs, which made delete silently do nothing.
function undoable(msg, fn) {
  const before = JSON.stringify(data), selBefore = sel;
  fn();
  toast(msg, () => { data = JSON.parse(before); sel = selBefore; selStop = -1; save(); renderAll(); });
}

/* ————————————— SAVING (debounced, to Supabase) ————————————— */
const dirty = new Set();
let saveTimer, saving = null;

function setState(state) {
  const el = $("#syncState");
  el.dataset.state = state;
  el.textContent = { saved: "✓ Gespeichert", saving: "Speichert …", error: "⚠ Nicht gespeichert · erneut versuchen" }[state];
}

function save() {
  dirty.add(trip());
  setState("saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 800);
}

async function flush() {
  if (saving) return saving.then(flush); // one sync at a time
  const todo = [...dirty];
  dirty.clear();
  saving = Promise.all(todo.filter(t => data.trips.includes(t)).map(syncTrip))
    .then(() => setState(dirty.size ? "saving" : "saved"))
    .catch(e => { console.error(e); todo.forEach(t => dirty.add(t)); setState("error"); })
    .finally(() => { saving = null; });
  return saving;
}

async function syncTrip(t) {
  const { trip: row, stops } = toRows(t, me.id);
  let { error } = await sb.from("trips").upsert(row);
  if (error?.code === "23505") { // someone else already uses this link name
    t.id = `${t.id}-${uuid().slice(0, 4)}`;
    ({ error } = await sb.from("trips").upsert({ ...row, slug: t.id }));
  }
  if (error) throw error;
  const keep = stops.map(s => s.id), gone = (t._synced || []).filter(id => !keep.includes(id));
  if (gone.length) { const r = await sb.from("stops").delete().in("id", gone); if (r.error) throw r.error; }
  if (stops.length) { const r = await sb.from("stops").upsert(stops); if (r.error) throw r.error; }
  t._synced = keep;
}

$("#syncState").addEventListener("click", () => { if ($("#syncState").dataset.state === "error") { setState("saving"); flush(); } });
addEventListener("beforeunload", e => { if (dirty.size || saving) e.preventDefault(); });

/* ————————————— SIGN-IN ————————————— */
function renderSignIn(msg = "") {
  $("#tripSel").hidden = $("#newTrip").hidden = $("#syncState").hidden = true;
  ed.innerHTML = `
    <h1 class="title">Anmelden</h1>
    <p class="hint">Du bekommst einen Link per E-Mail. Nur eingeladene Adressen funktionieren.</p>
    <form id="signIn" class="place-search">
      <input type="email" id="email" required placeholder="du@beispiel.de" autocomplete="email" aria-label="E-Mail">
      <button class="btn primary" type="submit">Link schicken</button>
    </form>
    <p class="hint" id="signInMsg" role="status">${esc(msg)}</p>`;
}

ed.addEventListener("submit", async e => {
  if (e.target.id !== "signIn") return;
  e.preventDefault();
  const msg = $("#signInMsg");
  msg.textContent = "Wird gesendet …";
  const { error } = await sb.auth.signInWithOtp({
    email: $("#email").value.trim(),
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
  });
  msg.textContent = error
    ? (/signup|not allowed|not found/i.test(error.message) ? "Diese Adresse ist nicht eingeladen." : "Fehler: " + error.message)
    : "Link ist unterwegs — öffne ihn auf diesem Gerät.";
}, true);

/* ————————————— LOAD ————————————— */
async function load() {
  const [{ data: rows, error }, { data: prof }] = await Promise.all([
    sb.from("trips").select(TRIP_SELECT).eq("owner", me.id).order("start_date", { ascending: false }),
    sb.from("profiles").select("*").eq("id", me.id).single(),
  ]);
  if (error) { toast("Laden fehlgeschlagen: " + error.message); return; }
  profile = prof;
  data = { trips: rows.map(t => ({ ...fromRow(t), _synced: t.stops.map(s => s.id) })) };
  $("#tripSel").hidden = $("#newTrip").hidden = $("#syncState").hidden = false;
  setState("saved");
  // The viewer's ✎ button links here as editor.html#trip=<id>
  const want = data.trips.findIndex(t => t.id === new URLSearchParams(location.hash.slice(1)).get("trip"));
  sel = want >= 0 ? want : Math.min(sel, data.trips.length - 1);
  if (!data.trips.length) newTrip();
  data.trips.forEach(normalize);
  renderAll();
}

/* ————————————— PROFILE ————————————— */
let profileTimer;
function saveProfile() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(async () => {
    const { name, handle, bio } = profile;
    const { error } = await sb.from("profiles").update({ name, handle: handle || null, bio }).eq("id", me.id);
    const h = ed.querySelector('[data-p="handle"]');
    h?.classList.toggle("bad", !!error);
    if (error) toast(error.code === "23505" ? "Dieser Name ist schon vergeben" : "Profil nicht gespeichert: nur a–z, 0–9, _ (3–24 Zeichen)");
  }, 800);
}

function normalize(t) {
  t.legs ||= []; t.tags ||= []; t.countries ||= [];
  t.dbId ||= uuid();
  t.stops.forEach(s => { s.photos ||= []; s.dbId ||= uuid(); });
  // Old format kept costs on the trip; move them to their stop (trip-wide ones to the first)
  if (t.costs?.length && t.stops.length) {
    t.costs.forEach(({ stop, ...c }) => (t.stops[stop ?? 0].costs ||= []).push(c));
    delete t.costs;
  }
  // legs[i] connects stop i and i+1; keep the array in step with the stops
  while (t.legs.length < t.stops.length - 1) {
    const i = t.legs.length, km = haversine(t.stops[i].lngLat, t.stops[i + 1].lngLat);
    t.legs.push({ mode: km > 800 ? "plane" : km < 3 ? "walk" : "car" });
  }
  t.legs.length = Math.max(0, t.stops.length - 1);
  // A recorded track only fits while its ends still touch the stops
  t.legs.forEach((l, k) => {
    if (l.coords && (haversine(l.coords[0], t.stops[k].lngLat) > 2 || haversine(l.coords.at(-1), t.stops[k + 1].lngLat) > 2)) delete l.coords;
  });
  // Countries and dates follow the stops, so nobody has to type ISO codes
  t.countries = [...new Set([...t.countries, ...t.stops.map(s => s.cc).filter(Boolean)])];
  const days = t.stops.map(s => s.time?.slice(0, 10)).filter(Boolean).sort();
  if (days.length) { if (days[0] < t.start) t.start = days[0]; if (days.at(-1) > t.end) t.end = days.at(-1); }
}

// The trip ID is its link name (#trip=…); derive it from the title until the trip is public or has stops saved.
function syncId(t) {
  if (t.published || t._synced?.length) return; // shared links must keep working
  const stem = slug(t.title) + "-" + t.start.slice(0, 4);
  let id = stem;
  for (let k = 2; data.trips.some(o => o !== t && o.id === id); k++) id = `${stem}-${k}`;
  t.id = id;
}

function newTrip() {
  const today = new Date().toISOString().slice(0, 10);
  data.trips.unshift({ dbId: uuid(), id: "", title: "Neue Reise", start: today, end: today, cover: "",
    summary: "", tags: [], countries: [], stops: [], legs: [], published: false });
  syncId(data.trips[0]);
  sel = 0; selStop = -1;
}

function addStop(stop, { focus = true } = {}) {
  const t = trip();
  t.stops.push({ dbId: uuid(), name: `Stopp ${t.stops.length + 1}`, time: "", md: "", photos: [], ...stop });
  selStop = t.stops.length - 1;
  changed();
  map.easeTo({ center: stop.lngLat, zoom: Math.max(map.getZoom(), 11), duration: 600 });
  if (focus) ed.querySelector(`.ed-stop[data-i="${selStop}"] [data-sf="name"]`)?.select();
  return t.stops[selStop];
}

/* ————————————— PLACES (OpenStreetMap Nominatim, max 1 request/s) ————————————— */
const NOMINATIM = "https://nominatim.openstreetmap.org";
const placeName = r => r.name || r.display_name?.split(",")[0] || "Ort";

async function reverse([lng, lat]) {
  try {
    const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&accept-language=de`).then(r => r.json());
    return r.error ? null : { name: placeName(r), cc: r.address?.country_code?.toUpperCase() };
  } catch { return null; }
}

// Name a fresh stop after the place it sits on, unless the user already renamed it.
async function nameStop(s) {
  const placeholder = s.name, p = await reverse(s.lngLat);
  if (!p) return;
  if (s.name === placeholder) s.name = p.name;
  s.cc = p.cc;
  changed();
}

async function searchPlaces(q) {
  const box = $("#placeResults");
  box.innerHTML = `<li class="meta">Suche …</li>`;
  try {
    const res = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=6&addressdetails=1&accept-language=de&q=${encodeURIComponent(q)}`).then(r => r.json());
    box.innerHTML = res.length ? res.map((r, k) => `<li><button data-act="pick-place" data-k="${k}">
        <strong>${esc(placeName(r))}</strong><span class="meta">${esc(r.display_name)}</span></button></li>`).join("")
      : `<li class="meta">Nichts gefunden.</li>`;
    box._results = res;
  } catch { box.innerHTML = `<li class="meta">Suche gerade nicht erreichbar.</li>`; }
}

/* ————————————— RENDER ————————————— */
function renderAll() { renderSelect(); render(); drawMap(true); }

function renderSelect() {
  $("#tripSel").innerHTML = data.trips.map((t, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${esc(t.title)} (${esc(t.start.slice(0, 4))})</option>`).join("");
}

const opt = (v, cur, label = v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
const stars = (i, n) => `<span class="stars" role="group" aria-label="Bewertung">${[1, 2, 3, 4, 5].map(k =>
  `<button data-act="star" data-i="${i}" data-n="${k}" class="${k <= (n || 0) ? "on" : ""}" aria-label="${k} Stern${k > 1 ? "e" : ""}" aria-pressed="${k === n}">★</button>`).join("")}</span>`;

function stopCard(t, s, i) {
  const spent = (s.costs || []).length;
  return `
    <details class="card ed-stop${i === selStop ? " selected" : ""}" data-i="${i}"${i === selStop ? " open" : ""}>
      <summary class="head">
        <span class="grip" title="Ziehen zum Sortieren" aria-hidden="true">⋮⋮</span><span class="num">${i + 1}</span>
        <span class="name">${esc(s.name)}</span>
        <span class="badges">${s.rating ? `<span class="mini-stars">${"★".repeat(s.rating)}</span>` : ""}${s.photos.length ? `📷${s.photos.length}` : ""}${s.videos?.length ? " ▶" : ""}${spent ? " 💶" : ""}</span>
        <button class="x" data-act="del-stop" data-i="${i}" aria-label="Stopp ${i + 1} löschen">×</button>
      </summary>
      <label>Name<input data-s="${i}" data-sf="name" value="${esc(s.name)}"></label>
      <div class="row">
        <label>Wann<input type="datetime-local" data-s="${i}" data-sf="time" value="${esc(s.time || "")}"></label>
        <label>Bewertung <span class="opt">optional</span>${stars(i, s.rating)}</label>
      </div>
      <label>Was war los? <span class="opt">Markdown</span><textarea data-s="${i}" data-sf="md" placeholder="Erzähl kurz …">${esc(s.md || "")}</textarea></label>

      <div class="ed-photos">${s.photos.map((p, k) => `
        <figure><img src="${esc(p.src)}" alt="" loading="lazy">${p.lngLat ? `<span class="gps" title="Hat GPS-Position">📍</span>` : ""}
          <button class="x" data-act="del-photo" data-i="${i}" data-k="${k}" aria-label="Foto entfernen">×</button>
          <input data-ph="${i}:${k}" value="${esc(p.alt)}" placeholder="Beschreibung" aria-label="Bildbeschreibung"></figure>`).join("")}
        <button class="drop-zone add-tile" data-drop="${i}" aria-label="Fotos hinzufügen">＋<span>Fotos</span></button>
      </div>

      ${(s.videos || []).map((v, k) => `
        <div class="ed-vlog">
          <input data-v="${i}:${k}" data-vf="url" value="${esc(v.url)}" placeholder="YouTube- oder Vimeo-Link" aria-label="Vlog-Link"${v.url && !parseVideo(v.url) ? ' class="bad"' : ""}>
          <input data-v="${i}:${k}" data-vf="title" value="${esc(v.title || "")}" placeholder="Titel" aria-label="Vlog-Titel">
          <button class="x" data-act="del-video" data-i="${i}" data-k="${k}" aria-label="Vlog entfernen">×</button>
        </div>`).join("")}

      ${(s.costs || []).map((c, k) => `
        <div class="ed-cost">
          <input data-sc="${i}:${k}" data-cf="amount" type="number" inputmode="decimal" step="0.01" min="0" value="${c.amount || ""}" placeholder="0,00" aria-label="Betrag">
          <select data-sc="${i}:${k}" data-cf="cur" aria-label="Währung">${Object.keys(RATES).map(r => opt(r, c.cur)).join("")}</select>
          <select data-sc="${i}:${k}" data-cf="cat" aria-label="Wofür">${Object.entries(CATS).map(([key, v]) => opt(key, c.cat, `${v.icon} ${v.label}`)).join("")}</select>
          <input data-sc="${i}:${k}" data-cf="note" value="${esc(c.note || "")}" placeholder="Notiz" aria-label="Notiz">
          <button class="x" data-act="del-cost" data-i="${i}" data-k="${k}" aria-label="Ausgabe löschen">×</button>
        </div>`).join("")}

      <div class="add-row">
        <button class="btn ghost" data-act="add-cost" data-i="${i}">💶 Ausgabe</button>
        <button class="btn ghost" data-act="add-video" data-i="${i}">▶ Vlog</button>
      </div>

      ${i < t.legs.length ? `<div class="ed-leg">Weiter zu ${i + 2} mit
        <select data-leg="${i}">${Object.entries(MODES).map(([k, m]) => opt(k, t.legs[i].mode, `${m.icon} ${m.label}`)).join("")}</select>
        <button class="btn ghost" data-act="gpx" data-i="${i}" title="Aufgezeichnete Strecke (GPX) importieren">GPX</button>
        ${t.legs[i].coords ? `<span>Strecke ✓ <button class="x" data-act="del-track" data-i="${i}" aria-label="Strecke entfernen">×</button></span>` : ""}
      </div>` : ""}
    </details>`;
}

function render() {
  const t = trip(), photos = t.stops.flatMap(s => s.photos);
  if (t.cover && !photos.some(p => p.src === t.cover)) photos.unshift({ src: t.cover, alt: t.cover.split("/").pop() });
  $("#backLink").href = "./#trip=" + encodeURIComponent(t.id);
  history.replaceState(null, "", "#trip=" + encodeURIComponent(t.id));
  const fresh = !t.stops.length;
  ed.innerHTML = `
    <label class="pub-toggle">
      <input type="checkbox" data-f="published"${t.published ? " checked" : ""}>
      <span>${t.published ? "🌍 Öffentlich: alle sehen diese Reise, neue Stopps sofort" : "🔒 Privat: nur du siehst diese Reise"}</span>
    </label>
    <details class="trip-meta"${fresh ? " open" : ""}>
      <summary><span class="title">${esc(t.title)}</span><span class="meta">Reise-Details</span></summary>
      <label>Titel<input data-f="title" value="${esc(t.title)}"></label>
      <div class="row">
        <label>Von<input type="date" data-f="start" value="${esc(t.start)}"></label>
        <label>Bis<input type="date" data-f="end" value="${esc(t.end)}"></label>
      </div>
      <label>Worum ging's? <span class="opt">optional</span><textarea data-f="summary">${esc(t.summary)}</textarea></label>
      <label>Tags <span class="opt">mit Komma</span><input data-f="tags" value="${esc(t.tags.join(", "))}" placeholder="Stadt, Meer"></label>
      ${photos.length ? `<label>Titelbild<select data-f="cover">${photos.map(p => opt(p.src, t.cover, p.alt || p.src.split("/").pop())).join("")}</select></label>` : ""}
      <button class="btn ghost" data-act="del-trip" style="margin-top:10px">Reise löschen</button>
    </details>

    <section class="add-stop" aria-label="Stopp hinzufügen">
      <h2 class="section">Stopp hinzufügen</h2>
      <form id="placeForm" class="place-search" role="search">
        <input id="placeQ" type="search" placeholder="Ort suchen, z. B. „Alfama Lissabon“" aria-label="Ort suchen" autocomplete="off">
        <button class="btn primary" type="submit">Suchen</button>
      </form>
      <ul id="placeResults" class="place-results"></ul>
      <div class="add-row">
        <button class="btn ghost" data-act="here">📍 Ich bin hier</button>
        <button class="drop-zone btn ghost" data-drop="">📷 Fotos (mit Ort)</button>
      </div>
      <p class="hint">…oder einfach auf die Karte tippen.</p>
    </section>

    ${t.stops.length ? `<h2 class="section">Stopps <span class="meta">${t.stops.length}</span></h2>` : ""}
    ${t.stops.map((s, i) => stopCard(t, s, i)).join("")}

    <details class="publish">
      <summary>Profil · ${esc(profile.name || me.email)}</summary>
      <label>Name<input data-p="name" value="${esc(profile.name || "")}"></label>
      <label>Benutzername <span class="opt">für deinen Link, a–z 0–9 _</span><input data-p="handle" value="${esc(profile.handle || "")}" placeholder="maiko" autocapitalize="off"></label>
      <label>Über dich <span class="opt">optional</span><textarea data-p="bio">${esc(profile.bio || "")}</textarea></label>
      <div class="add-row">
        ${profile.handle ? `<a class="btn ghost" href="./#u=${encodeURIComponent(profile.handle)}">Mein Profil ansehen</a>` : ""}
        <button class="btn ghost" data-act="sign-out">Abmelden</button>
      </div>
    </details>`;
}

/* ————————————— MAP ————————————— */
const theme = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";
let styleKey = theme(), markers = [];
const map = new maplibregl.Map({ container: "map", style: STYLES[styleKey], center: [10, 45], zoom: 3, attributionControl: { compact: true } });
map.addControl(new maplibregl.NavigationControl(), "bottom-right");
new MutationObserver(() => { if (theme() !== styleKey) map.setStyle(STYLES[styleKey = theme()], { diff: false }); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
map.on("style.load", () => {
  map.addSource("legs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "legs", type: "line", source: "legs", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": 4, "line-color": ["match", ["get", "mode"], ...Object.entries(MODES).flatMap(([k, m]) => [k, m.color]), "#888"] } });
  drawMap();
});

map.on("click", e => nameStop(addStop({ lngLat: [round(e.lngLat.lng), round(e.lngLat.lat)] }, { focus: false })));

let drawToken = 0;
async function drawMap(fit = false) {
  if (!data) return; // style can load before trips.json
  const t = trip(), token = ++drawToken;
  markers.forEach(m => m.remove());
  markers = t.stops.map((s, i) => {
    const el = document.createElement("div");
    el.innerHTML = `<div class="pin stop-pin${i === selStop ? " active" : ""}">${i + 1}</div>`;
    const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(s.lngLat).addTo(map);
    m.on("dragend", () => { const p = m.getLngLat(); s.lngLat = [round(p.lng), round(p.lat)]; changed(false); });
    el.addEventListener("click", e => { e.stopPropagation(); selectStop(i, true); });
    return m;
  });
  const feats = await Promise.all(t.legs.map(async (l, i) => ({ type: "Feature", properties: { mode: l.mode },
    geometry: { type: "LineString", coordinates: await legCoords(t, i) } })));
  if (token !== drawToken) return;
  map.getSource("legs")?.setData({ type: "FeatureCollection", features: feats });
  if (fit && t.stops.length) {
    const b = t.stops.reduce((b, s) => b.extend(s.lngLat), new maplibregl.LngLatBounds(t.stops[0].lngLat, t.stops[0].lngLat));
    const p = $(".panel");
    map.fitBounds(b, { padding: { top: 60, bottom: 60, right: 60, left: p.offsetLeft + p.offsetWidth + 60 }, maxZoom: 12, duration: 800 });
  }
}

function selectStop(i, open = false) {
  selStop = i;
  document.querySelectorAll(".ed-stop").forEach(c => {
    c.classList.toggle("selected", +c.dataset.i === i);
    if (open && +c.dataset.i === i) { c.open = true; c.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  });
  markers.forEach((m, k) => m.getElement().firstChild.classList.toggle("active", k === i));
  const s = trip().stops[i];
  if (s) map.easeTo({ center: s.lngLat, duration: 500 });
}

// Structural change: normalize, save, re-render form (optional) and map.
function changed(rerender = true) {
  normalize(trip());
  save();
  if (rerender) render();
  drawMap();
}

/* ————————————— PHOTOS ————————————— */
async function compress(file, max = 1600) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  // Safari can't encode WebP and silently returns PNG; use JPEG there instead
  const webp = await new Promise(r => c.toBlob(r, "image/webp", 0.82));
  return webp?.type === "image/webp" ? webp : new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
}

// Where does a dropped photo go? GPS → nearest stop (or a new one), else closest time, else the selected stop.
function placePhoto(t, lngLat, time) {
  if (lngLat) {
    let best = -1, bestKm = 3;
    t.stops.forEach((s, i) => { const km = haversine(s.lngLat, lngLat); if (km < bestKm) { best = i; bestKm = km; } });
    if (best >= 0) return best;
    t.stops.push({ dbId: uuid(), name: "Neuer Stopp", lngLat, time: time || "", md: "", photos: [] });
    nameStop(t.stops.at(-1));
    return t.stops.length - 1;
  }
  if (time && t.stops.some(s => s.time)) {
    const ts = new Date(time);
    return t.stops.reduce((b, s, i) => s.time && Math.abs(new Date(s.time) - ts) < Math.abs(new Date(t.stops[b].time || 0) - ts) ? i : b, 0);
  }
  if (selStop >= 0 && t.stops[selStop]) return selStop;
  if (!t.stops.length) {
    const c = map.getCenter();
    t.stops.push({ dbId: uuid(), name: "Neuer Stopp", lngLat: [round(c.lng), round(c.lat)], time: time || "", md: "", photos: [] });
  }
  return 0;
}

async function addPhotos(files, stopIndex) {
  const t = trip();
  let n = 0;
  toast(`${files.length} Foto(s) werden verkleinert und hochgeladen …`);
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const exif = await exifr.parse(file).catch(() => null);
      const lngLat = exif?.longitude != null ? [round(exif.longitude), round(exif.latitude)] : null;
      const time = exif?.DateTimeOriginal instanceof Date ? localISO(exif.DateTimeOriginal) : null;
      const blob = await compress(file);
      // Storage policy: each user may only write into the folder named after their user id
      const path = `${me.id}/${t.dbId}/${uuid()}.${blob.type === "image/webp" ? "webp" : "jpg"}`;
      const up = await sb.storage.from("photos").upload(path, blob, { contentType: blob.type });
      if (up.error) throw up.error;
      const src = sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
      const si = stopIndex ?? placePhoto(t, lngLat, time);
      t.stops[si].photos.push({ src, alt: "", lngLat, time });
      t.cover ||= src;
      selStop = si;
      n++;
    } catch (e) {
      console.error(e);
      toast(`${file.name}: ${e.message?.includes("Bucket") || e.statusCode ? "Hochladen fehlgeschlagen" : "konnte nicht gelesen werden (HEIC? Dann vorher als JPEG exportieren)"}`);
    }
  }
  changed();
  if (n) toast(`${n} Foto(s) hinzugefügt`);
}

/* ————————————— REORDER / DELETE ————————————— */
function moveStop(from, to) {
  const t = trip();
  t.stops.splice(to, 0, t.stops.splice(from, 1)[0]);
  selStop = to;
  changed();
}

function deleteStop(i) {
  const t = trip();
  t.stops.splice(i, 1);
  t.legs.splice(Math.min(i, t.legs.length - 1), 1);
  selStop = -1;
  changed();
}

/* ————————————— EVENTS ————————————— */
$("#tripSel").addEventListener("change", e => { sel = +e.target.value; selStop = -1; renderAll(); });
$("#newTrip").addEventListener("click", () => { newTrip(); save(); renderAll(); ed.querySelector('[data-f="title"]')?.select(); });

ed.addEventListener("submit", e => {
  if (e.target.id !== "placeForm") return;
  e.preventDefault();
  const q = $("#placeQ").value.trim();
  if (q) searchPlaces(q);
});

ed.addEventListener("input", e => {
  const el = e.target, t = trip(), d = el.dataset;
  if (d.p) {
    profile[d.p] = d.p === "handle" ? el.value.trim().toLowerCase() : el.value;
    return saveProfile();
  }
  if (d.f === "published") {
    t.published = el.checked;
    el.nextElementSibling.textContent = t.published ? "🌍 Öffentlich: alle sehen diese Reise, neue Stopps sofort" : "🔒 Privat: nur du siehst diese Reise";
  } else if (d.f) {
    t[d.f] = d.f === "tags" ? list(el.value) : el.value;
    if (d.f === "title" || d.f === "start") { syncId(t); renderSelect(); ed.querySelector(".trip-meta .title").textContent = t.title; }
  } else if (d.s) {
    t.stops[+d.s][d.sf] = el.value;
    if (d.sf === "name") el.closest(".ed-stop").querySelector(".name").textContent = el.value;
    if (d.sf === "time") normalize(t);
  } else if (d.sc) {
    const [i, k] = d.sc.split(":").map(Number), c = t.stops[i].costs[k];
    if (d.cf === "amount") c.amount = +el.value || 0;
    else if (d.cf === "note") { if (el.value) c.note = el.value; else delete c.note; }
    else c[d.cf] = el.value;
  } else if (d.v) {
    const [i, k] = d.v.split(":").map(Number);
    t.stops[i].videos[k][d.vf] = el.value.trim();
    if (d.vf === "url") el.classList.toggle("bad", !!el.value && !parseVideo(el.value));
  } else if (d.ph) {
    const [i, k] = d.ph.split(":").map(Number);
    t.stops[i].photos[k].alt = el.value;
  } else if (d.leg) {
    t.legs[+d.leg].mode = el.value;
    drawMap();
  } else return;
  save();
});

// Opening a stop card selects it on the map too
ed.addEventListener("toggle", e => {
  const card = e.target.closest?.(".ed-stop");
  if (card?.open && +card.dataset.i !== selStop) selectStop(+card.dataset.i);
}, true);

let gpxLeg = -1, fileStop = null;
ed.addEventListener("click", e => {
  const zone = e.target.closest(".drop-zone");
  if (zone) { fileStop = zone.dataset.drop === "" ? null : +zone.dataset.drop; $("#fileIn").click(); return; }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  e.preventDefault(); // buttons inside <summary> must not toggle the card
  const card = b.closest(".ed-stop");
  if (card) selStop = +card.dataset.i; // keep the card open across the re-render
  const t = trip(), i = +b.dataset.i, k = +b.dataset.k;
  switch (b.dataset.act) {
    case "pick-place": {
      const r = $("#placeResults")._results[k];
      addStop({ lngLat: [round(+r.lon), round(+r.lat)], name: placeName(r), cc: r.address?.country_code?.toUpperCase() });
      break;
    }
    case "here":
      if (!navigator.geolocation) return toast("Standort wird von diesem Browser nicht unterstützt");
      toast("Standort wird gesucht …");
      navigator.geolocation.getCurrentPosition(
        p => nameStop(addStop({ lngLat: [round(p.coords.longitude), round(p.coords.latitude)], time: localISO(new Date()) }, { focus: false })),
        () => toast("Standort nicht verfügbar — Freigabe erlauben oder Ort suchen"),
        { enableHighAccuracy: true, timeout: 15000 });
      break;
    case "star": {
      const s = t.stops[i], n = +b.dataset.n;
      if (s.rating === n) delete s.rating; else s.rating = n; // tap the same star again to clear
      changed();
      break;
    }
    case "del-stop": undoable(`„${t.stops[i].name}“ gelöscht`, () => deleteStop(i)); break;
    case "del-photo": undoable("Foto entfernt", () => {
      const [p] = t.stops[i].photos.splice(k, 1);
      if (t.cover === p.src) t.cover = t.stops.flatMap(s => s.photos)[0]?.src || "";
      changed();
    }); break;
    case "add-video":
      (t.stops[i].videos ||= []).push({ url: "", title: "" });
      changed();
      ed.querySelector(`[data-v="${i}:${t.stops[i].videos.length - 1}"]`)?.focus();
      break;
    case "del-video": undoable("Vlog entfernt", () => {
      t.stops[i].videos.splice(k, 1);
      if (!t.stops[i].videos.length) delete t.stops[i].videos;
      changed();
    }); break;
    case "add-cost": {
      // Default to the currency used last on this trip — abroad that's usually the local one
      const cur = [...t.stops.flatMap(s => s.costs || [])].pop()?.cur || "EUR";
      (t.stops[i].costs ||= []).push({ amount: 0, cur, cat: "food" });
      changed();
      ed.querySelector(`[data-sc="${i}:${t.stops[i].costs.length - 1}"][data-cf="amount"]`)?.focus();
      break;
    }
    case "del-cost": undoable("Ausgabe gelöscht", () => {
      t.stops[i].costs.splice(k, 1);
      if (!t.stops[i].costs.length) delete t.stops[i].costs;
      changed();
    }); break;
    case "gpx": gpxLeg = i; $("#gpxIn").click(); break;
    case "del-track": delete t.legs[i].coords; changed(); break;
    case "del-trip": undoable(`Reise „${t.title}“ gelöscht`, () => {
      sb.from("trips").delete().eq("id", t.dbId).then(r => r.error && toast("Löschen fehlgeschlagen: " + r.error.message));
      data.trips.splice(sel, 1);
      if (!data.trips.length) newTrip();
      sel = 0; selStop = -1;
      renderAll();
    }); break;
    case "sign-out": sb.auth.signOut().then(() => location.reload()); break;
  }
});

$("#fileIn").addEventListener("change", e => { addPhotos([...e.target.files], fileStop); e.target.value = ""; });

$("#gpxIn").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let coords = parseGPX(await file.text());
  if (coords.length < 2) return toast("Keine Trackpunkte in der GPX-Datei");
  const step = Math.ceil(coords.length / 500); // keep trips.json small
  coords = coords.filter((_, k) => k % step === 0 || k === coords.length - 1).map(([x, y]) => [round(x), round(y)]);
  const t = trip(), leg = t.legs[gpxLeg];
  // Snap the stops to the track ends so the line connects cleanly
  t.stops[gpxLeg].lngLat = coords[0];
  t.stops[gpxLeg + 1].lngLat = coords.at(-1);
  leg.coords = coords;
  delete leg.track;
  changed();
  toast(`Strecke mit ${coords.length} Punkten importiert`);
});

// Drag & drop: files onto drop zones, stop cards by their grip.
let dragFrom = -1;
ed.addEventListener("pointerdown", e => { const card = e.target.closest(".grip")?.closest(".ed-stop"); if (card) card.draggable = true; });
ed.addEventListener("dragstart", e => {
  const card = e.target.closest?.(".ed-stop");
  if (!card) return;
  dragFrom = +card.dataset.i;
  card.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
});
ed.addEventListener("dragend", e => { const card = e.target.closest?.(".ed-stop"); if (card) { card.draggable = false; card.classList.remove("dragging"); } dragFrom = -1; });
ed.addEventListener("dragover", e => {
  const files = e.dataTransfer.types.includes("Files"), zone = e.target.closest(".drop-zone");
  if ((files && zone) || (!files && dragFrom >= 0 && e.target.closest(".ed-stop"))) e.preventDefault();
  ed.querySelectorAll(".drop-zone.over").forEach(z => z !== zone && z.classList.remove("over"));
  if (files) zone?.classList.add("over");
});
ed.addEventListener("drop", e => {
  e.preventDefault();
  const zone = e.target.closest(".drop-zone");
  if (e.dataTransfer.files.length && zone) {
    zone.classList.remove("over");
    addPhotos([...e.dataTransfer.files], zone.dataset.drop === "" ? null : +zone.dataset.drop);
  } else if (dragFrom >= 0) {
    const card = e.target.closest(".ed-stop");
    if (card && +card.dataset.i !== dragFrom) moveStop(dragFrom, +card.dataset.i);
  }
});

// Magic-link sign-in lands back here; onAuthStateChange also fires for the stored session on start.
sb.auth.onAuthStateChange((event, session) => {
  if (session && session.user.id !== me?.id) { me = session.user; setTimeout(load); } // setTimeout: don't await inside the callback
  if (!session && event !== "INITIAL_SESSION") { me = null; renderSignIn(); }
});
const { data: { session } } = await sb.auth.getSession();
if (!session) renderSignIn();
