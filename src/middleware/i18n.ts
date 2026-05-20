import { createMiddleware } from "hono/factory";
import { parseAcceptLanguage, type Locale } from "../utils/i18n";

// Resolves the request locale from the `Accept-Language` header and stashes
// it on the Hono context. Registered once at app boot (see src/index.ts),
// so every handler can do `c.get("locale")` without re-parsing.
//
// Why not also accept a `?lang=` query param? Browsers already send
// Accept-Language; explicit override is something a logged-in user picks
// via a settings page (FE owns that, persists it in a cookie). We can add
// cookie precedence here later without breaking existing handlers.
//
// Usage: import { I18nVars } from "../middleware/i18n";
//        const r = new Hono<I18nVars>();
//        r.get("/x", (c) => c.json({ msg: t(c.get("locale"), "error.generic") }));

export type I18nVars = {
  Variables: { locale: Locale };
};

export const i18nMiddleware = createMiddleware<I18nVars>(async (c, next) => {
  const locale = parseAcceptLanguage(c.req.header("accept-language"));
  c.set("locale", locale);
  await next();
});
