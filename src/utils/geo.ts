// Geo helpers — just input validation. The distance work happens in
// Postgres via PostGIS's ST_DWithin on a generated geography column +
// GIST index. See prisma/migrations/.../*add_post_geo*/migration.sql
// for the setup. We never compute distance in Node anymore.

export const DEFAULT_RADIUS_KM = 100;

export type LatLng = { latitude: number; longitude: number };

export function isValidLatLng(p: { latitude: unknown; longitude: unknown }): p is LatLng {
  return (
    typeof p.latitude === "number" &&
    typeof p.longitude === "number" &&
    p.latitude >= -90 && p.latitude <= 90 &&
    p.longitude >= -180 && p.longitude <= 180 &&
    Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
  );
}

// ─── Reverse geocoding ─────────────────────────────────────────────
// Coordinate → COARSE place label (town/city), called ONCE at post
// creation and stored on the row (Post.locationName). Reads never geocode.
//
// Provider: OpenStreetMap Nominatim — free, no key. Its usage policy
// (≤1 req/s, identifying User-Agent, cache results) is trivially met at
// creation-time volume. zoom=10 keeps the result at locality level — we
// never surface a street address (poster privacy).
//
// FAIL-OPEN, like moderation: any error/timeout → null. A post without a
// place label is fine; we never block or fail creation on geocoding.
const GEOCODE_TIMEOUT_MS = 5000;

export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<string | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
    `&lat=${latitude}&lon=${longitude}&zoom=10&accept-language=en`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      // Nominatim REQUIRES an identifying User-Agent or it 403s.
      headers: { "User-Agent": "ourlittlefarm/1.0 (https://ourlittlefarm.club)" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { address?: Record<string, string> };
    const a = data.address ?? {};
    // Coarsest-useful, town/city level first. Never a street/house number.
    return a.city || a.town || a.village || a.suburb || a.county || a.state || null;
  } catch {
    return null; // denied / timeout / network / bad JSON → no label
  } finally {
    clearTimeout(timer);
  }
}
