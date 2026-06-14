// heic-convert ships no type declarations. Minimal ambient module so the
// HEIC→JPEG decode in src/utils/images.ts typechecks. The library is pure
// JS (libheif compiled to wasm), so it decodes HEIC identically on macOS
// dev and Linux (Railway) — which is exactly why we route HEIC through it
// instead of Bun.Image (whose HEIC path needs an OS codec and rejects on
// Linux's "bun" backend).
declare module "heic-convert" {
  interface ConvertOptions {
    /** The HEIC/HEIF file bytes. */
    buffer: ArrayBufferLike | Uint8Array | Buffer;
    /** Output container. */
    format: "JPEG" | "PNG";
    /** JPEG quality 0–1 (ignored for PNG). */
    quality?: number;
  }
  export default function convert(options: ConvertOptions): Promise<ArrayBuffer>;
}
