// AI moderation gate. Every post/comment body runs through OpenAI's
// Moderation API (omni-moderation-latest — free, no token cost) before
// it's inserted. Hard-rejects content that trips a BLOCKED category.
//
// pigweed's content philosophy: moderate HATE, not SPICE. A grumpy goose
// calling another goose a fucker is authentic punk-farm energy and stays.
// Slurs, threats, self-harm, CSAM, graphic violence do not. The split
// below encodes that — edit it to retune the culture.
//
// Fail-open by design: if the key is missing, the API errors, or the
// network blips, we ALLOW the content and log it. A third-party outage
// must never stop pigweed from working. Moderation is best-effort.

// OpenAI returns 13 categories. These are the ones we reject on. The
// rest (plain `harassment`, non-minor `sexual`, non-graphic `violence`,
// profanity) are allowed — that's the spice.
const BLOCKED_CATEGORIES = [
  "hate",
  "hate/threatening",
  "harassment/threatening",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual/minors",
  "violence/graphic",
  "illicit/violent",
] as const;

// Human-readable reasons for the FE to surface to the user. Multiple
// technical categories collapse to one friendly phrase.
const CATEGORY_LABELS: Record<string, string> = {
  "hate": "hateful speech",
  "hate/threatening": "hateful threats",
  "harassment/threatening": "threatening harassment",
  "self-harm": "self-harm content",
  "self-harm/intent": "self-harm content",
  "self-harm/instructions": "self-harm content",
  "sexual/minors": "sexual content involving minors",
  "violence/graphic": "graphic violence",
  "illicit/violent": "violent illicit content",
};

type OpenAIModerationResponse = {
  results?: Array<{ categories?: Record<string, boolean> }>;
};

// `moderated` distinguishes WHY content is allowed:
//   moderated: true  → OpenAI actually judged it and it was clean
//   moderated: false → fail-open: OpenAI was unreachable, content was
//                       NOT judged. The "shiny" / UNMODERATED case.
export type ModerationResult =
  | { allowed: true; moderated: boolean }
  | { allowed: false; categories: string[]; reason: string };

export async function moderate(text: string): Promise<ModerationResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  // Fail-open #1: no key configured. Moderation effectively disabled.
  if (!apiKey) {
    console.warn("[moderation] OPENAI_API_KEY not set — allowing (fail-open)");
    return { allowed: true, moderated: false };
  }

  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
    });

    // Fail-open #2: API returned non-200 (rate limit, 5xx, bad key).
    // Log OpenAI's actual error body — a bare status code hides whether
    // it's a quota problem (set up billing), a bad key (401-ish), or a
    // genuine rate limit (back off).
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[moderation] API ${res.status} — allowing (fail-open). OpenAI said: ${detail}`);
      return { allowed: true, moderated: false };
    }

    const data = (await res.json()) as OpenAIModerationResponse;
    const result = data?.results?.[0];
    // Malformed response — treat as unreachable (fail-open, not judged).
    if (!result?.categories) return { allowed: true, moderated: false };

    const cats = result.categories;
    const tripped = BLOCKED_CATEGORIES.filter((cat) => cats[cat] === true);

    // OpenAI judged it and it's clean → genuinely moderated.
    if (tripped.length === 0) return { allowed: true, moderated: true };

    // Dedupe friendly labels (self-harm/* all collapse to one phrase).
    const reasons = [...new Set(tripped.map((c) => CATEGORY_LABELS[c] ?? c))];
    return {
      allowed: false,
      categories: tripped,
      reason: reasons.join(", "),
    };
  } catch (err) {
    // Fail-open #3: network error, timeout, DNS, etc.
    console.error("[moderation] request failed — allowing (fail-open):", err);
    return { allowed: true, moderated: false };
  }
}
