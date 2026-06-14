import convert from "heic-convert";

// ─────────────────────────────────────────────────────────────
// IMAGE PROCESSING
//
// Every uploaded image is normalized to a sane WebP before it ever
// reaches storage: huge iPhone photos get shrunk, HEIC gets transcoded to
// a web-displayable format, and EXIF metadata (incl. GPS) is dropped.
// Stripping GPS is a privacy WIN here — pigweed never persists user
// location, and an iPhone photo's embedded coordinates would leak exactly
// that. Bun.Image's re-encode drops metadata by default; we never opt back
// in.
//
// Pipeline:
//   HEIC/HEIF → heic-convert (wasm libheif, OS-independent) → JPEG bytes
//   then ALL formats → Bun.Image: auto-orient, resize-to-fit, encode WebP
//
// Why heic-convert for the HEIC leg: Bun.Image can decode HEIC only via an
// OS codec (macOS/Windows). On Linux it runs the "bun" backend and rejects
// HEIC with ERR_IMAGE_FORMAT_UNSUPPORTED. Decoding HEIC in JS first makes
// behavior identical on the mac dev box and the Linux deploy.
// ─────────────────────────────────────────────────────────────

const MAX_DIMENSION = 2048; // longest side, px
const WEBP_QUALITY = 80;
export const MAX_INPUT_BYTES = 25 * 1024 * 1024; // 25 MB raw upload cap

const HEIC_MIMES = new Set(["image/heic", "image/heif"]);
// Content-types we accept for upload. Video / animated GIF are out of
// scope for MVP (heavy server-side processing) — the media `kind` enum
// supports them for a later pass.
export const ACCEPTED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export type ProcessedImage = {
  buffer: Buffer;
  width: number;
  height: number;
  kind: "image";
};

// Sniff the real format from magic bytes. Client-supplied content-types
// are unreliable (curl sends octet-stream; browsers occasionally mislabel
// HEIC), so we trust the bytes, not the header. Returns one of our
// ACCEPTED_MIMES strings, or null if it isn't an image we handle.
export function detectMime(buf: Uint8Array): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  // WebP: "RIFF"...."WEBP"
  const ascii = (i: number, s: string) =>
    [...s].every((ch, k) => buf[i + k] === ch.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  // HEIC/HEIF: ISO-BMFF "ftyp" box at offset 4, then a HEIF brand.
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (["heic", "heix", "heif", "hevc", "mif1", "msf1"].includes(brand)) {
      return brand === "mif1" || brand === "heif" ? "image/heif" : "image/heic";
    }
  }
  return null;
}

// Transcode (if HEIC) + auto-orient + resize + re-encode to WebP. Throws
// if the bytes can't be decoded — the caller maps that to a 422.
export async function processImage(input: Buffer, mime: string): Promise<ProcessedImage> {
  let decoded: Buffer | Uint8Array = input;

  if (HEIC_MIMES.has(mime)) {
    // heic-convert returns an ArrayBuffer; wrap for Bun.Image.
    const jpeg = await convert({ buffer: input, format: "JPEG", quality: 0.92 });
    decoded = Buffer.from(jpeg);
  }

  // autoOrient defaults true → EXIF Orientation applied before resize, and
  // the WebP re-encode emits no metadata (GPS gone). withoutEnlargement
  // means small images pass through at native size; fit:"inside" caps the
  // LONGEST side at MAX_DIMENSION while preserving aspect ratio.
  const img = new Bun.Image(decoded)
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY });

  const buffer = await img.buffer();
  // width/height read the OUTPUT dimensions once a terminal has resolved.
  return { buffer, width: img.width, height: img.height, kind: "image" };
}
