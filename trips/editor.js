// Local trip editor. Drafts live in localStorage, new photos in the Cache API
// (keyed by their final URL), and "Exportieren" bundles both into one zip to commit.
import { MODES, CATS, STYLES, esc, parseGPX, haversine, legCoords } from "./lib.js";

const KEY = "trips-editor-draft", CACHE = "trips-editor-images";
const $ = s => document.querySelector(s);
const ed = $("#ed");
const urls = new Map(); // src -> object URL for photos that are not committed yet
const base = new URL(".", location).href;
let data, sel = 0, selStop = -1;

const trip = () => data.trips[sel];
const imgSrc = src => urls.get(src) || src;
const list = s => s.split(",").map(x => x.trim()).filter(Boolean);
const slug = s => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "foto";
const round = n => Math.round(n * 1e5) / 1e5;
const localISO = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);

function toast(msg) {
  const t = document.body.appendChild(Object.assign(document.createElement("div"), { className: "toast", textContent: msg, role: "status" }));
  setTimeout(() => t.remove(), 2600);
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch { toast("Entwurf konnte nicht gespeichert werden (Speicher voll?)"); }
  }, 300);
}

async function load(fresh = false) {
  const saved = !fresh && localStorage.getItem(KEY);
  data = saved ? JSON.parse(saved) : await fetch("data/trips.json", { cache: "no-store" }).then(r => r.json());
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) {
    const src = req.url.replace(base, "");
    if (!urls.has(src)) urls.set(src, URL.createObjectURL(await (await cache.match(req)).blob()));
  }
  sel = Math.min(sel, data.trips.length - 1);
  if (!data.trips.length) newTrip();
  data.trips.forEach(normalize);
  renderAll();
}

// legs[i] connects stop i and i+1; keep the array in step with the stops.
function normalize(t) {
  t.legs ||= []; t.costs ||= []; t.tags ||= []; t.countries ||= [];
  while (t.legs.length < t.stops.length - 1) {
    const i = t.legs.length, km = haversine(t.stops[i].lngLat, t.stops[i + 1].lngLat);
    t.legs.push({ mode: km > 800 ? "plane" : km < 3 ? "walk" : "car" });
  }
  t.legs.length = Math.max(0, t.stops.length - 1);
  // A recorded track only fits while its ends still touch the stops
  t.legs.forEach((l, k) => {
    if (l.coords && (haversine(l.coords[0], t.stops[k].lngLat) > 2 || haversine(l.coords.at(-1), t.stops[k + 1].lngLat) > 2)) delete l.coords;
  });
}

function newTrip() {
  const today = new Date().toISOString().slice(0, 10);
  data.trips.unshift({ id: "reise-" + Date.now().toString(36), title: "Neue Reise", start: today, end: today, cover: "",
    summary: "", tags: [], countries: [], stops: [], legs: [], costs: [] });
  sel = 0; selStop = -1;
}

/* ————————————— RENDER ————————————— */
function renderAll() { renderSelect(); render(); drawMap(true); }

function renderSelect() {
  $("#tripSel").innerHTML = data.trips.map((t, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${esc(t.title)} (${esc(t.start.slice(0, 4))})</option>`).join("")
    + `<option value="new">+ Neue Reise …</option>`;
}

function render() {
  const t = trip(), photos = t.stops.flatMap(s => s.photos);
  if (t.cover && !photos.some(p => p.src === t.cover)) photos.unshift({ src: t.cover, alt: t.cover.split("/").pop() });
  const opt = (v, cur, label = v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  ed.innerHTML = `
    <label>Titel<input data-f="title" value="${esc(t.title)}"></label>
    <div class="row">
      <label>ID / Ordner<input data-f="id" value="${esc(t.id)}"></label>
      <label>Tags<input data-f="tags" value="${esc(t.tags.join(", "))}" placeholder="Stadt, Meer"></label>
    </div>
    <div class="row">
      <label>Start<input type="date" data-f="start" value="${esc(t.start)}"></label>
      <label>Ende<input type="date" data-f="end" value="${esc(t.end)}"></label>
    </div>
    <label>Länder (ISO-Codes)<input data-f="countries" value="${esc(t.countries.join(", "))}" placeholder="PT, ES"></label>
    <label>Zusammenfassung<textarea data-f="summary">${esc(t.summary)}</textarea></label>
    <label>Titelbild<select data-f="cover">${opt("", t.cover, "— keins —")}${photos.map(p => opt(p.src, t.cover, p.alt || p.src.split("/").pop())).join("")}</select></label>
    <div class="drop-zone" data-drop="">Fotos hier ablegen oder klicken. Mit GPS landen sie beim nächsten Stopp (oder werden einer).</div>

    <h2 class="section">Stopps</h2>
    <p class="hint">Klick auf die Karte = neuer Stopp. Am ⋮⋮ ziehen zum Sortieren, Marker sind verschiebbar.</p>
    ${t.stops.map((s, i) => `
      <div class="card ed-stop${i === selStop ? " selected" : ""}" data-i="${i}">
        <div class="head">
          <span class="grip" title="Ziehen zum Sortieren" aria-hidden="true">⋮⋮</span><span class="num">${i + 1}</span>
          <input data-s="${i}" data-sf="name" value="${esc(s.name)}" aria-label="Name von Stopp ${i + 1}">
          <button class="x" data-act="del-stop" data-i="${i}" aria-label="Stopp ${i + 1} löschen">×</button>
        </div>
        <div class="row">
          <label>Zeit<input type="datetime-local" data-s="${i}" data-sf="time" value="${esc(s.time || "")}"></label>
          <label>Zoom<input type="number" step="0.5" min="3" max="18" data-s="${i}" data-sf="zoom" value="${s.zoom ?? ""}" placeholder="13.5"></label>
        </div>
        <label>Text (Markdown)<textarea data-s="${i}" data-sf="md">${esc(s.md || "")}</textarea></label>
        ${s.photos.length ? `<div class="ed-photos">${s.photos.map((p, k) => `
          <figure><img src="${esc(imgSrc(p.src))}" alt="">${p.lngLat ? `<span class="gps" title="Hat GPS-Position">📍</span>` : ""}
            <button class="x" data-act="del-photo" data-i="${i}" data-k="${k}" aria-label="Foto entfernen">×</button>
            <input data-ph="${i}:${k}" value="${esc(p.alt)}" placeholder="Alt-Text" aria-label="Alt-Text"></figure>`).join("")}</div>` : ""}
        <div class="drop-zone" data-drop="${i}">+ Fotos für diesen Stopp</div>
        ${i < t.legs.length ? `<div class="ed-leg">weiter mit
          <select data-leg="${i}">${Object.entries(MODES).map(([k, m]) => opt(k, t.legs[i].mode, `${m.icon} ${m.label}`)).join("")}</select>
          <button class="btn ghost" data-act="gpx" data-i="${i}">GPX…</button>
          ${t.legs[i].coords ? `<span>Track ✓ <button class="x" data-act="del-track" data-i="${i}" aria-label="Track entfernen">×</button></span>` : t.legs[i].track ? `<span>${esc(t.legs[i].track.split("/").pop())}</span>` : ""}
        </div>` : ""}
      </div>`).join("")}

    <h2 class="section">Kosten</h2>
    ${t.costs.map((c, i) => `
      <div class="ed-cost">
        <select data-c="${i}" data-cf="cat" aria-label="Kategorie">${Object.entries(CATS).map(([k, v]) => opt(k, c.cat, v.label)).join("")}</select>
        <input data-c="${i}" data-cf="note" value="${esc(c.note || "")}" placeholder="Notiz" aria-label="Notiz">
        <input data-c="${i}" data-cf="amount" type="number" step="0.01" value="${c.amount}" aria-label="Betrag">
        <select data-c="${i}" data-cf="cur" aria-label="Währung">${Object.keys(data.rates).map(k => opt(k, c.cur)).join("")}</select>
        <select data-c="${i}" data-cf="stop" aria-label="Stopp">${opt("", c.stop == null ? "" : String(c.stop), "— Reise —")}${t.stops.map((s, k) => opt(String(k), String(c.stop), `${k + 1}. ${s.name}`)).join("")}</select>
        <button class="x" data-act="del-cost" data-i="${i}" aria-label="Kosten löschen">×</button>
      </div>`).join("")}
    <button class="btn ghost" data-act="add-cost" style="margin-top:8px">+ Kosten</button>

    <h2 class="section">Export</h2>
    <p class="hint">Entwürfe speichern sich automatisch in diesem Browser. Zum Veröffentlichen: Zip exportieren, im Ordner <code>trips/</code> entpacken, committen.</p>
    <div class="ed-bar">
      <button class="btn primary" data-act="export-zip">Exportieren (.zip)</button>
      <button class="btn ghost" data-act="export-json">nur trips.json</button>
      <button class="btn ghost" data-act="del-trip">Reise löschen</button>
      <button class="btn ghost" data-act="reset">Entwurf verwerfen</button>
      <button class="btn ghost" data-act="clear-cache">Bilder-Cache leeren</button>
    </div>`;
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

map.on("click", e => {
  const t = trip();
  t.stops.push({ name: `Stopp ${t.stops.length + 1}`, lngLat: [round(e.lngLat.lng), round(e.lngLat.lat)], time: "", md: "", photos: [] });
  selStop = t.stops.length - 1;
  changed();
  ed.querySelector(`.ed-stop[data-i="${selStop}"] input`)?.focus();
});

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
    el.addEventListener("click", e => { e.stopPropagation(); selectStop(i); });
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

function selectStop(i) {
  selStop = i;
  document.querySelectorAll(".ed-stop").forEach(c => c.classList.toggle("selected", +c.dataset.i === i));
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
    t.stops.push({ name: "Neuer Stopp", lngLat, time: time || "", md: "", photos: [] });
    return t.stops.length - 1;
  }
  if (time && t.stops.some(s => s.time)) {
    const ts = new Date(time);
    return t.stops.reduce((b, s, i) => s.time && Math.abs(new Date(s.time) - ts) < Math.abs(new Date(t.stops[b].time || 0) - ts) ? i : b, 0);
  }
  if (selStop >= 0 && t.stops[selStop]) return selStop;
  if (!t.stops.length) {
    const c = map.getCenter();
    t.stops.push({ name: "Neuer Stopp", lngLat: [round(c.lng), round(c.lat)], time: time || "", md: "", photos: [] });
  }
  return 0;
}

async function addPhotos(files, stopIndex) {
  const t = trip(), cache = await caches.open(CACHE);
  const taken = new Set(t.stops.flatMap(s => s.photos.map(p => p.src)));
  let n = 0;
  toast(`${files.length} Foto(s) werden verkleinert …`);
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const exif = await exifr.parse(file).catch(() => null);
      const lngLat = exif?.longitude != null ? [round(exif.longitude), round(exif.latitude)] : null;
      const time = exif?.DateTimeOriginal instanceof Date ? localISO(exif.DateTimeOriginal) : null;
      const blob = await compress(file);
      const ext = blob.type === "image/webp" ? "webp" : "jpg", stem = slug(file.name.replace(/\.[^.]+$/, ""));
      let src = `images/${t.id}/${stem}.${ext}`;
      for (let k = 2; taken.has(src); k++) src = `images/${t.id}/${stem}-${k}.${ext}`;
      taken.add(src);
      await cache.put(new Request(src), new Response(blob, { headers: { "Content-Type": blob.type } }));
      urls.set(src, URL.createObjectURL(blob));
      const si = stopIndex ?? placePhoto(t, lngLat, time);
      t.stops[si].photos.push({ src, alt: "", lngLat, time });
      t.cover ||= src;
      n++;
    } catch (e) {
      console.error(e);
      toast(`${file.name}: konnte nicht gelesen werden (HEIC? Dann vorher als JPEG exportieren)`);
    }
  }
  changed();
  if (n) toast(`${n} Foto(s) hinzugefügt`);
}

/* ————————————— REORDER / DELETE (keeps cost→stop links right) ————————————— */
function remapCosts(t, mapIdx) {
  t.costs.forEach(c => {
    if (c.stop == null) return;
    const n = mapIdx(c.stop);
    if (n == null) delete c.stop; else c.stop = n;
  });
}

function moveStop(from, to) {
  const t = trip(), order = t.stops.map((_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]);
  t.stops = order.map(i => t.stops[i]);
  remapCosts(t, old => order.indexOf(old));
  selStop = to;
  changed();
}

function deleteStop(i) {
  const t = trip();
  t.stops.splice(i, 1);
  t.legs.splice(Math.min(i, t.legs.length - 1), 1);
  remapCosts(t, old => old === i ? null : old > i ? old - 1 : old);
  selStop = -1;
  changed();
}

/* ————————————— EXPORT ————————————— */
function download(blob, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const json = () => new Blob([JSON.stringify(data, null, 1) + "\n"], { type: "application/json" });

async function exportZip() {
  const zip = new JSZip(), cache = await caches.open(CACHE);
  zip.file("data/trips.json", json());
  const used = new Set(data.trips.flatMap(t => t.stops.flatMap(s => s.photos.map(p => p.src))));
  let n = 0;
  for (const req of await cache.keys()) {
    const src = req.url.replace(base, "");
    if (used.has(src)) { zip.file(src, await (await cache.match(req)).blob()); n++; }
  }
  download(await zip.generateAsync({ type: "blob" }), "trips-export.zip");
  toast(`Exportiert: trips.json + ${n} neue Foto(s)`);
}

/* ————————————— EVENTS ————————————— */
$("#tripSel").addEventListener("change", e => {
  if (e.target.value === "new") newTrip(); else sel = +e.target.value;
  selStop = -1;
  save();
  renderAll();
});

ed.addEventListener("input", e => {
  const el = e.target, t = trip(), d = el.dataset;
  if (d.f) {
    if (d.f === "tags" || d.f === "countries") t[d.f] = list(d.f === "countries" ? el.value.toUpperCase() : el.value);
    else if (d.f === "id") t.id = slug(el.value);
    else t[d.f] = el.value;
    if (d.f === "title" || d.f === "start") renderSelect();
  } else if (d.s) {
    const s = t.stops[+d.s];
    if (d.sf === "zoom") { if (el.value) s.zoom = +el.value; else delete s.zoom; }
    else s[d.sf] = el.value;
  } else if (d.c) {
    const c = t.costs[+d.c];
    if (d.cf === "amount") c.amount = +el.value;
    else if (d.cf === "stop") { if (el.value === "") delete c.stop; else c.stop = +el.value; }
    else if (d.cf === "note") { if (el.value) c.note = el.value; else delete c.note; }
    else c[d.cf] = el.value;
  } else if (d.ph) {
    const [i, k] = d.ph.split(":").map(Number);
    t.stops[i].photos[k].alt = el.value;
  } else if (d.leg) {
    t.legs[+d.leg].mode = el.value;
    drawMap();
  } else return;
  save();
});

let gpxLeg = -1, fileStop = null;
ed.addEventListener("click", async e => {
  const zone = e.target.closest(".drop-zone");
  if (zone) { fileStop = zone.dataset.drop === "" ? null : +zone.dataset.drop; $("#fileIn").click(); return; }
  const card = e.target.closest(".ed-stop");
  if (card && !e.target.closest("[data-act]")) selectStop(+card.dataset.i);
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const t = trip(), i = +b.dataset.i;
  switch (b.dataset.act) {
    case "del-stop": if (confirm(`Stopp „${t.stops[i].name}“ löschen?`)) deleteStop(i); break;
    case "del-photo": {
      const [p] = t.stops[i].photos.splice(+b.dataset.k, 1);
      if (t.cover === p.src) t.cover = t.stops.flatMap(s => s.photos)[0]?.src || "";
      changed();
      break;
    }
    case "gpx": gpxLeg = i; $("#gpxIn").click(); break;
    case "del-track": delete t.legs[i].coords; changed(); break;
    case "add-cost": t.costs.push({ cat: "food", amount: 0, cur: "EUR" }); changed(); break;
    case "del-cost": t.costs.splice(i, 1); changed(); break;
    case "export-json": download(json(), "trips.json"); break;
    case "export-zip": exportZip(); break;
    case "del-trip":
      if (confirm(`Reise „${t.title}“ aus dem Entwurf löschen?`)) { data.trips.splice(sel, 1); sel = 0; selStop = -1; save(); await load(); }
      break;
    case "reset":
      if (confirm("Alle Entwürfe verwerfen und trips.json neu laden?")) { localStorage.removeItem(KEY); await load(true); toast("Entwurf verworfen"); }
      break;
    case "clear-cache":
      if (confirm("Erst nach dem Commit! Nicht exportierte Fotos gehen verloren. Bilder-Cache leeren?")) {
        await caches.delete(CACHE); urls.clear(); toast("Bilder-Cache geleert");
      }
      break;
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
  toast(`Track mit ${coords.length} Punkten importiert`);
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

await load();
