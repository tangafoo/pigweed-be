import { createMiddleware } from "hono/factory";
import { auth } from "../utils/auth";
import { prisma } from "../utils/db";

// Gate for the admin panel. Resolves the session, then requires the user's
// `isAdmin` flag (set via CLI/Studio for the boss). 401 if signed out, 403 if
// signed in but not an admin. Attaches `userId` like requireSignIn.
//
// Usage: admin.get("/users", requireAdmin, async (c) => { ... });

export type AdminVars = {
  Variables: { userId: string };
};

export const requireAdmin = createMiddleware<AdminVars>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isAdmin: true },
  });
  if (!user?.isAdmin) return c.json({ error: "forbidden" }, 403);

  c.set("userId", session.user.id);
  await next();
});
