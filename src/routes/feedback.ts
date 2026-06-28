import { Hono } from "hono";
import { optionalSignIn, type ViewerVars } from "../middleware/optional-sign-in";
import { prisma } from "../utils/db";
import { sendEmail } from "../utils/email";
import { feedbackEmail } from "../emails/templates";
import { feedbackTo } from "../utils/env";

// ─────────────────────────────────────────────────────────────
// Contact / "egg feedback" form. Public (optionalSignIn) so a
// logged-out visitor can still reach us; when a session is present
// we enrich the email with the user's handle + id for context. The
// FE links here from the settings card's locked-email tooltip
// (?topic=EMAIL_CHANGE) and from a general feedback page.
// Mail goes to FEEDBACK_TO; sendEmail fails open (logs in dev).
// ─────────────────────────────────────────────────────────────
export const feedback = new Hono<ViewerVars>();

const TOPICS = ["GENERAL", "EMAIL_CHANGE", "BUG", "IDEA"] as const;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

feedback.post("/", optionalSignIn, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    email?: string;
    topic?: string;
    message?: string;
  } | null;

  const email = (body?.email ?? "").trim();
  const message = (body?.message ?? "").trim();
  const topic = TOPICS.includes(body?.topic as (typeof TOPICS)[number])
    ? (body!.topic as string)
    : "GENERAL";

  if (!EMAIL_RE.test(email)) return c.json({ error: "A valid email is required." }, 400);
  if (message.length < 1 || message.length > 4000) {
    return c.json({ error: "Message must be 1–4000 characters." }, 400);
  }

  // Attach the signed-in user (if any) for reply context.
  const viewerId = c.get("viewerId");
  let username: string | undefined;
  if (viewerId) {
    const u = await prisma.user.findUnique({
      where: { id: viewerId },
      select: { username: true },
    });
    username = u?.username;
  }

  const mail = feedbackEmail({ fromEmail: email, topic, message, username, userId: viewerId });
  await sendEmail({ to: feedbackTo(), subject: mail.subject, html: mail.html, text: mail.text });
  console.log(`[feedback] ${topic} from ${email}${username ? ` (${username})` : ""}`);

  return c.json({ ok: true });
});
