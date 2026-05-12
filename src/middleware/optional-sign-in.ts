import { createMiddleware } from "hono/factory";
import { auth } from "../utils/auth";

// Peek-at-session middleware for public read routes that want to *know who's
// looking* without rejecting anonymous viewers. If the request has a valid
// session, attaches `viewerId` to the context; otherwise leaves it unset.
//
// Use this when the response shape changes for signed-in viewers but the
// route itself is public — e.g. GET /posts/:id needs `myVote` for the
// current viewer, but anyone can read the post.
//
// We use a different key (`viewerId`) from requireSignIn's `userId` on
// purpose: the two middlewares offer different guarantees, so they should
// not share a Variables slot — that would force every requireSignIn caller
// to handle the possibly-undefined case.
//
// For routes that MUST be signed in (writes, profile pages), use
// requireSignIn instead — it rejects with 401.

export type ViewerVars = {
  Variables: { viewerId?: string };
};

export const optionalSignIn = createMiddleware<ViewerVars>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (session) c.set("viewerId", session.user.id);
  await next();
});
