import { prisma } from "./db";
import { NotificationType } from "../generated/prisma/client";

// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS — write helpers for the durable digest feed.
//
// These are deliberately NOT on the event bus. The bus is in-process and
// lossy (and fans out per-instance); a digest record must survive until
// the nightly job runs, so it goes straight to Postgres.
//
// FIRE-AND-FORGET: callers (comments.ts, votes.ts) invoke recordNotification
// without awaiting, then swallow errors. A failed notification insert must
// never fail the comment/vote it describes — the user's action already
// succeeded. Self-actions (commenting on your own post, upvoting yourself)
// are dropped here so callers don't each re-implement the check.
// ─────────────────────────────────────────────────────────────

export interface RecordNotificationInput {
  recipientId: string; // who gets the digest line
  actorId: string; // who did the thing
  type: NotificationType;
  postId?: string;
  commentId?: string;
}

export function recordNotification(input: RecordNotificationInput): void {
  // No "you did a thing to your own stuff" notifications.
  if (input.recipientId === input.actorId) return;

  prisma.notification
    .create({
      data: {
        userId: input.recipientId,
        actorId: input.actorId,
        type: input.type,
        postId: input.postId ?? null,
        commentId: input.commentId ?? null,
      },
    })
    .catch((err) => {
      console.error(
        `[notifications] failed to record ${input.type} for ${input.recipientId}:`,
        err,
      );
    });
}
