import { Hono } from "hono";
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

  // media/<userId>/<pm_…>.webp — namespaced per user, opaque id.
  const key = `media/${userId}/${makeId(ID_PREFIX.POST_MEDIA)}.webp`;

  let url: string;
  try {
    url = await putObject(key, processed.buffer, "image/webp");
  } catch (err) {
    console.error("[media] upload failed:", err);
    return c.json({ error: "Upload failed." }, 502);
  }

  return c.json({
    url,
    kind: processed.kind,
    width: processed.width,
    height: processed.height,
  });
});
