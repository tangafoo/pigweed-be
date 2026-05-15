/*
  Warnings:
  - Added the required column `latitude` to the `post` table without a default value. This is not possible if the table is not empty.
  - Added the required column `longitude` to the `post` table without a default value. This is not possible if the table is not empty.
*/
-- AlterTable
ALTER TABLE "post" ADD COLUMN     "latitude" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "longitude" DOUBLE PRECISION NOT NULL;

-- ─── PostGIS spatial setup ───────────────────────────────────
-- Enable PostGIS (Supabase has it pre-installed; this is idempotent).
CREATE EXTENSION IF NOT EXISTS postgis;

-- A generated geography column maintained by Postgres from latitude
-- and longitude. Prisma's schema doesn't know about it — that's
-- intentional, it exists solely for ST_DWithin radius queries via
-- $queryRaw in the application code.
ALTER TABLE "post"
ADD COLUMN "geo" geography(Point, 4326)
GENERATED ALWAYS AS (
  ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography
) STORED;

-- GIST index — makes ST_DWithin sub-millisecond regardless of post count.
CREATE INDEX "post_geo_gist_idx" ON "post" USING GIST ("geo");