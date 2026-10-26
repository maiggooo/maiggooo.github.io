// Supabase connection shared by viewer and editor. The publishable key is meant to be
// public: row-level security (supabase/schema.sql) decides what each visitor may read or write.
export const sb = supabase.createClient(
  "https://aabwbmfszderdsrphtqg.supabase.co",
  "sb_publishable_9Mw20yOmRWkLPJ0DZlHAsw_1CufdM3T",
);

export const TRIP_SELECT = "*, owner:profiles(id, handle, name, bio), stops(*)";

// DB rows → the shape app.js and editor.js work with (same as the old trips.json).
export function fromRow(r) {
  return {
    dbId: r.id, id: r.slug, title: r.title, start: r.start_date || r.created_at.slice(0, 10), end: r.end_date || r.start_date || r.created_at.slice(0, 10),
    summary: r.summary, tags: r.tags, countries: r.countries, cover: r.cover || "",
    legs: r.legs, published: r.published, owner: r.owner,
    stops: (r.stops || []).sort((a, b) => a.position - b.position).map(s => ({
      dbId: s.id, name: s.name, lngLat: [s.lng, s.lat], cc: s.cc, time: s.visited_at?.slice(0, 16) || "",
      md: s.md, rating: s.rating ?? undefined, photos: s.photos, videos: s.videos, costs: s.costs,
    })),
  };
}

export function toRows(t, ownerId) {
  const trip = {
    id: t.dbId, owner: ownerId, slug: t.id, title: t.title, start_date: t.start || null, end_date: t.end || null,
    summary: t.summary || "", tags: t.tags || [], countries: t.countries || [], cover: t.cover || null,
    legs: (t.legs || []).map(({ mode, coords, track }) => ({ mode, ...(coords && { coords }), ...(track && { track }) })),
    published: !!t.published,
  };
  const stops = t.stops.map((s, i) => ({
    id: s.dbId, trip_id: t.dbId, position: i, name: s.name || "Stopp", lng: s.lngLat[0], lat: s.lngLat[1],
    cc: s.cc || null, visited_at: s.time || null, md: s.md || "", rating: s.rating || null,
    photos: s.photos || [], videos: s.videos || [], costs: s.costs || [],
  }));
  return { trip, stops };
}

export const profileLink = p => p?.handle ? `#u=${encodeURIComponent(p.handle)}` : "";
