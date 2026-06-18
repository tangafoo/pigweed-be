import { Hono } from "hono";
import { prisma } from "../utils/db";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";
import { makeId, ID_PREFIX } from "../utils/ids";
import {
  ACCEPTED_MIMES,
  MAX_INPUT_BYTES,
  detectMime,
  processImage,
} from "../utils/images";
import { isStorageConfigured, putObject } from "../utils/storage";

// ─────────────────────────────────────────────────────────────
// POST /media — authenticated image upload (proxy + transcode).
//
// Browser sends one file as multipart/form-data (field name "file"). We
// validate, normalize it (HEIC→WebP, shrink, strip EXIF — see images.ts),
// upload to R2, and return { url, kind, width, height }. The client then
// includes that object in POST /posts { media: [...] }, where the existing
// parseMedia pipeline (posts.ts) takes over unchanged. One file per call;
// the client loops for multiple and gets progressive feedback.
// ─────────────────────────────────────────────────────────────

export const media = new Hono<AuthVars>();

// Make an arbitrary string safe + readable as a single S3/R2 key segment:
// lowercase, only [a-z0-9_-], collapse the rest to "-", trim, length-cap.
// Returns "" if nothing usable survives (callers supply a fallback).
function keySegment(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

media.post("/", requireSignIn, async (c) => {
  // No R2 configured → fail loudly rather than half-working.
  if (!isStorageConfigured()) {
    return c.json({ error: "Media uploads are not configured." }, 503);
  }

  const userId = c.get("userId");

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "Expected a 'file' field (multipart/form-data)." }, 400);
  }

  // Size gate before we read the whole thing into memory and burn CPU.
  if (file.size > MAX_INPUT_BYTES) {
    return c.json(
      { error: `File too large (max ${Math.floor(MAX_INPUT_BYTES / (1024 * 1024))}MB).` },
      413,
    );
  }

  const input = Buffer.from(await file.arrayBuffer());

  // Trust the bytes, not the client's content-type. Sniff the magic bytes
  // and fall back to the declared type only if sniffing is inconclusive.
  const mime = detectMime(input) ?? file.type;
  if (!ACCEPTED_MIMES.has(mime)) {
    return c.json(
      { error: "Unsupported file type. Allowed: jpeg, png, webp, heic, heif." },
      415,
    );
  }

  let processed;
  try {
    processed = await processImage(input, mime);
  } catch (err) {
    console.error("[media] processing failed:", err);
    return c.json({ error: "Could not process image." }, 422);
  }

  // Build a human-readable key: media/<username>/<category>/<pm_…>.webp.
  // Username is the public pseudonym (unique, NOT email — we keep PII out of
  // storage paths). Category is an optional hint the client sends (it knows
  // it at submit time); absent/unknown ⇒ "uncategorized". The opaque pm_ id
  // is kept for collision-safety and unguessable URLs.
  const username = (
    await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
  )?.username;
  const userSegment = keySegment(username ?? "") || userId;
  const categoryRaw = typeof body["category"] === "string" ? body["category"] : "";
  const categorySegment = keySegment(categoryRaw) || "uncategorized";
  const key = `media/${userSegment}/${categorySegment}/${makeId(ID_PREFIX.POST_MEDIA)}.webp`;

  let url: string;
  try {
    url = await putObject(key, processed.buffer, "image/webp");
  } catch (err) {
    console.error("[media] upload failed:", err);
    return c.json({ error: "Upload failed." }, 502);
  }

  console.log(`[media] uploaded ${key} (${processed.width}x${processed.height}) for ${userId}`);

  return c.json({
    url,
    kind: processed.kind,
    width: processed.width,
    height: processed.height,
  });
});
