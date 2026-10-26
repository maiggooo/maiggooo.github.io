// Shared by the viewer (app.js) and the editor (editor.js).

export const MODES = {
  walk:  { label: "Zu Fuß", icon: "🚶", color: "#2f8a4a", dash: [0.2, 1.8] },
  car:   { label: "Auto",   icon: "🚗", color: "#7a5cc8", dash: null },
  train: { label: "Zug",    icon: "🚆", color: "#c8442a", dash: [2.5, 1.2] },
  plane: { label: "Flug",   icon: "✈️", color: "#2a6bc8", dash: [1, 2] },
  boat:  { label: "Boot",   icon: "⛴️", color: "#1a9aa8", dash: [4, 2] },
};

export const CATS = {
  transport:  { label: "Transport",   color: "#2a6bc8" },
  lodging:    { label: "Unterkunft",  color: "#c8442a" },
  food:       { label: "Essen",       color: "#e0a030" },
  activities: { label: "Aktivitäten", color: "#2f8a4a" },
  other:      { label: "Sonstiges",   color: "#8a857a" },
};

export const STYLES = {
  light: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  dark:  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function haversine([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// Cumulative km along a line; last entry is the total.
export function cumKm(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(coords[i - 1], coords[i]));
  return out;
}

// Great-circle arc for flights, so long legs curve like on a real flight map.
export function gcArc([lon1, lat1], [lon2, lat2], n = 64) {
  const r = Math.PI / 180;
  const v = (lo, la) => [Math.cos(la * r) * Math.cos(lo * r), Math.cos(la * r) * Math.sin(lo * r), Math.sin(la * r)];
  const A = v(lon1, lat1), B = v(lon2, lat2);
  const d = Math.acos(Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  if (d < 1e-6) return [[lon1, lat1], [lon2, lat2]];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = Math.sin((1 - t) * d) / Math.sin(d), b = Math.sin(t * d) / Math.sin(d);
    const x = a * A[0] + b * B[0], y = a * A[1] + b * B[1], z = a * A[2] + b * B[2];
    out.push([Math.atan2(y, x) / r, Math.atan2(z, Math.hypot(x, y)) / r]);
  }
  // Unwrap longitudes so the line never jumps across the antimeridian
  for (let i = 1; i < out.length; i++) {
    while (out[i][0] - out[i - 1][0] > 180) out[i][0] -= 360;
    while (out[i][0] - out[i - 1][0] < -180) out[i][0] += 360;
  }
  return out;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  return [...doc.querySelectorAll("trkpt, rtept")].map(p => [+p.getAttribute("lon"), +p.getAttribute("lat")]);
}

function geojsonLine(gj) {
  const g = gj.type === "FeatureCollection" ? gj.features[0]?.geometry : gj.type === "Feature" ? gj.geometry : gj;
  if (!g) return [];
  return g.type === "MultiLineString" ? g.coordinates.flat() : g.coordinates;
}

// Leg i connects stop i and stop i+1. Its geometry is, in order of preference:
// inline coords (editor GPX import), a track file (GPX/GeoJSON), or a straight line / flight arc.
export async function legCoords(trip, i) {
  const leg = trip.legs?.[i] || {}, a = trip.stops[i].lngLat, b = trip.stops[i + 1].lngLat;
  if (leg.coords?.length > 1) return leg.coords;
  if (leg.track) {
    try {
      const res = await fetch(leg.track);
      const coords = leg.track.endsWith(".gpx") ? parseGPX(await res.text()) : geojsonLine(await res.json());
      if (coords.length > 1) return coords;
    } catch (e) { console.warn("Track konnte nicht geladen werden:", leg.track, e); }
  }
  return (leg.mode || "car") === "plane" ? gcArc(a, b) : [a, b];
}

export async function resolveLegs(trip) {
  const n = Math.max(0, trip.stops.length - 1);
  return Promise.all(Array.from({ length: n }, async (_, i) => {
    const coords = await legCoords(trip, i), cum = cumKm(coords);
    return { mode: trip.legs?.[i]?.mode || "car", coords, cum, km: cum.at(-1) };
  }));
}

export const toEUR = (amount, cur, rates) => amount * (rates[cur] ?? 1);

export const tripDays = t => Math.round((new Date(t.end) - new Date(t.start)) / 864e5) + 1;

const dFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", year: "numeric" });
export const fmtRange = t => `${dFmt.format(new Date(t.start))} – ${dFmt.format(new Date(t.end))}`;
export const fmtTime = s => s ? new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(s)) : "";
export const fmtEUR = (n, dec = 0) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: dec, minimumFractionDigits: dec }).format(n);

const regionNames = new Intl.DisplayNames(["de"], { type: "region" });
export const countryName = code => { try { return regionNames.of(code); } catch { return code; } };
