// Hand-rolled i18n for pigweed-be. Why not i18next / formatjs?
//
//   - The BE has very few user-facing strings: OTP email subject/body,
//     content-moderation rejection reasons, a handful of error messages.
//     i18next is order-of-magnitude more surface than this needs.
//   - Compile-time type safety. `t("auth.does_not_exist")` is a type error,
//     not a runtime fallback. Every locale must implement every key (TS
//     enforces `Dict` shape).
//   - Zero runtime dependencies. Parsing Accept-Language is ~10 lines.
//
// When this file exceeds ~200 keys or we need ICU pluralization, swap to a
// real library. Until then, this is the cheapest correct thing.
//
// Wire shape: every request runs through `i18nMiddleware`
// (see `src/middleware/i18n.ts`), which parses Accept-Language and stashes
// the resolved locale on the Hono context. Handlers do
// `const locale = c.get("locale"); c.json({ message: t(locale, "error.generic") })`.

// `Locale` is mirrored in pigweed-be/contract/src/index.ts so the FE
// imports the same enum from `@meteorclass/pigweed-contract`. Hand-synced,
// same pattern as Animal/Gender (Prisma enum on BE side, Zod enum in the
// contract). If you add a locale here, add it there too and rebuild the
// contract (`cd contract && bun run build`).
export type Locale = "en" | "ko" | "zh" | "ja";

// `zh` is Traditional Chinese (zh-TW) — kept in lockstep with the FE's zh.json.
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "ko", "zh", "ja"] as const;
export const DEFAULT_LOCALE: Locale = "en";

// ─── Dictionary ────────────────────────────────────────────────────
// Keep keys dotted-namespaced (`auth.*`, `moderation.*`, `error.*`) so
// callsites read like English even when colocated with code. Every
// locale must have every key — TypeScript enforces this via the
// `Record<Locale, Dict>` shape below.

type Dict = {
    "auth.otp_email_subject": string;
    "moderation.rejected_default": string;
    "error.generic": string;
};

// Brand note: user-facing strings say "ourlittlefarm", not "pigweed".
// "pigweed" is the internal codename (repo + package names); the public
// brand is ourlittlefarm. See memory: brand-pigweed-internal-ourlittlefarm-public.
const dictionaries: Record<Locale, Dict> = {
    en: {
        "auth.otp_email_subject": "Your ourlittlefarm verification code",
        "moderation.rejected_default": "This content can't be posted.",
        "error.generic": "Something went wrong. Please try again.",
    },
    ko: {
        "auth.otp_email_subject": "ourlittlefarm 인증 코드",
        "moderation.rejected_default": "이 콘텐츠는 게시할 수 없습니다.",
        "error.generic": "문제가 발생했습니다. 다시 시도해 주세요.",
    },
    // Traditional Chinese (zh-TW).
    zh: {
        "auth.otp_email_subject": "您的 ourlittlefarm 驗證碼",
        "moderation.rejected_default": "此內容無法發佈。",
        "error.generic": "發生錯誤，請再試一次。",
    },
    ja: {
        "auth.otp_email_subject": "ourlittlefarm の確認コード",
        "moderation.rejected_default": "このコンテンツは投稿できません。",
        "error.generic": "エラーが発生しました。もう一度お試しください。",
    },
};

// ─── Lookup ────────────────────────────────────────────────────────
// Falls back to English when a translation is missing — better than
// rendering the key string verbatim while ko is still being filled in.

export function t<K extends keyof Dict>(locale: Locale, key: K): Dict[K] {
    return dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key];
}

// ─── Accept-Language parsing ───────────────────────────────────────
// Example header values we need to handle:
//   "ko"                  -> ko
//   "ko,en;q=0.8"         -> ko (highest quality)
//   "en-US,en;q=0.9"      -> en (US strips to base)
//   "fr,de;q=0.7"         -> en (DEFAULT_LOCALE, nothing matched)
//   undefined / ""        -> en
//
// Quality (`q`) defaults to 1. Ties break by header order (= original
// preference). We strip region tags (`en-US` -> `en`) because pigweed
// has no region-specific copy.

export function parseAcceptLanguage(header: string | undefined | null): Locale {
    if (!header) return DEFAULT_LOCALE;

    const candidates = header
        .split(",")
        .map((part, index) => {
            const [tagRaw, ...params] = part.trim().split(";");
            const tag = tagRaw?.split("-")[0]?.toLowerCase() ?? "";
            const qParam = params.find((p) => p.trim().startsWith("q="));
            const q = qParam ? Number(qParam.split("=")[1]) : 1;
            // `index` is the secondary sort key: header order wins on ties.
            return { tag, q: Number.isFinite(q) ? q : 0, index };
        })
        .filter((c): c is { tag: Locale; q: number; index: number } =>
            (SUPPORTED_LOCALES as readonly string[]).includes(c.tag),
        )
        .sort((a, b) => b.q - a.q || a.index - b.index);

    return candidates[0]?.tag ?? DEFAULT_LOCALE;
}
