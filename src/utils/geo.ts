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
