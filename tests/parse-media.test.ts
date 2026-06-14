import { describe, it, expect } from "bun:test";
import { parseMedia } from "../src/routes/posts";

// Sanity tests for the parseMedia validator. Pure function, no DB, no auth —
// the simplest layer of testing to start with. Integration tests for the
// HTTP endpoints come next session (separate test DB required).

describe("parseMedia", () => {
  it("returns empty array for null/undefined input", () => {
    expect(parseMedia(null)).toEqual([]);
    expect(parseMedia(undefined)).toEqual([]);
  });

  it("rejects non-array input", () => {
    expect(parseMedia("not an array")).toEqual({ error: "media must be an array" });
    expect(parseMedia(42)).toEqual({ error: "media must be an array" });
    expect(parseMedia({})).toEqual({ error: "media must be an array" });
  });

  it("rejects more than 10 items", () => {
    const tooMany = Array(11).fill({ url: "https://example.com/a.jpg", kind: "image" });
    expect(parseMedia(tooMany)).toEqual({ error: "media cannot exceed 10 items" });
  });

  it("rejects invalid URLs", () => {
    const result = parseMedia([{ url: "not-a-url", kind: "image" }]);
    expect(result).toEqual({ error: "media[0].url must be a valid URL" });
  });

  it("rejects unknown kinds", () => {
    const result = parseMedia([{ url: "https://example.com/a.jpg", kind: "audio" }]);
    expect(Array.isArray(result)).toBe(false);
    if (!Array.isArray(result)) {
      expect(result.error).toContain("kind must be one of");
    }
  });

  it("rejects negative order", () => {
    const result = parseMedia([{ url: "https://example.com/a.jpg", kind: "image", order: -1 }]);
    expect(result).toEqual({ error: "media[0].order must be a non-negative integer" });
  });

  it("accepts valid input and applies defaults", () => {
    const result = parseMedia([{ url: "https://example.com/a.jpg", kind: "image" }]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        url: "https://example.com/a.jpg",
        kind: "image",
        order: 0,
      });
      expect(result[0].width).toBeUndefined();
      expect(result[0].height).toBeUndefined();
    }
  });

  it("uses array index as default order", () => {
    const result = parseMedia([
      { url: "https://example.com/a.jpg", kind: "image" },
      { url: "https://example.com/b.jpg", kind: "image" },
    ]);
    if (Array.isArray(result)) {
      expect(result[0].order).toBe(0);
      expect(result[1].order).toBe(1);
    }
  });

  it("preserves explicit order, width, height when valid", () => {
    const result = parseMedia([
      { url: "https://example.com/a.jpg", kind: "image", order: 5, width: 600, height: 400 },
    ]);
    if (Array.isArray(result)) {
      expect(result[0].order).toBe(5);
      expect(result[0].width).toBe(600);
      expect(result[0].height).toBe(400);
    }
  });

  it("accepts gif and video as valid kinds", () => {
    const result = parseMedia([
      { url: "https://example.com/a.gif", kind: "gif" },
      { url: "https://example.com/b.mp4", kind: "video" },
    ]);
    expect(Array.isArray(result)).toBe(true);
  });

  describe("allowedBaseUrl enforcement", () => {
    const BASE = "https://media.ourlittlefarm.club";

    it("accepts URLs hosted on the allowed origin", () => {
      const result = parseMedia(
        [{ url: `${BASE}/media/u1/pm_abc.webp`, kind: "image" }],
        BASE,
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it("rejects URLs on a different origin", () => {
      const result = parseMedia(
        [{ url: "https://example.com/a.jpg", kind: "image" }],
        BASE,
      );
      expect(result).toEqual({
        error: "media[0].url must be hosted on the app's media domain",
      });
    });

    it("rejects look-alike domains (origin compare, not prefix)", () => {
      const result = parseMedia(
        [{ url: "https://media.ourlittlefarm.club.evil.com/a.jpg", kind: "image" }],
        BASE,
      );
      expect(Array.isArray(result)).toBe(false);
    });

    it("stays permissive when no base is provided", () => {
      const result = parseMedia([{ url: "https://example.com/a.jpg", kind: "image" }]);
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
