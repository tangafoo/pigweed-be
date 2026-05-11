import { createMiddleware } from "hono/factory";
import { auth } from "../utils/auth";

// Gate for routes that need a signed-in user. Reads the session cookie,
// validates with Better Auth, and either rejects with 401 or attaches
// `userId` to the request context.
//
// Usage: posts.post("/", requireSignIn, async (c) => {
//          const userId = c.get("userId");
//          ...
//        });

export type AuthVars = {
  Variables: { userId: string };
};

export const requireSignIn = createMiddleware<AuthVars>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", session.user.id);
  await next();
});
