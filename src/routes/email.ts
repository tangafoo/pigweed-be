import { Hono } from "hono";
import { prisma } from "../utils/db";
import { verifyUnsubscribeToken } from "../utils/email-token";

// One-click digest opt-out. The link lives in every digest footer
// (utils/email-token.ts builds it) and carries (u=userId, t=HMAC). No
// session required — the signed token IS the auth, so a logged-out user
// reading email on their phone can still unsubscribe. Only flips the
// digest flag; transactional mail (welcome/OTP) is unaffected.
export const email = new Hono();

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
   <meta name="viewport" content="width=device-width,initial-scale=1"/>
   <title>${title}</title></head>
   <body style="margin:0;background:#faf7f0;color:#1c1a17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
     <div style="max-width:420px;margin:64px auto;padding:0 20px;text-align:center;">
       <div style="font-size:20px;font-weight:700;color:#3a7d44;margin-bottom:24px;">🥚 ourlittlefarm</div>
       ${body}
     </div>
   </body></html>`;

email.get("/unsubscribe", async (c) => {
  const userId = c.req.query("u");
  const token = c.req.query("t");

  if (!userId || !token || !verifyUnsubscribeToken(userId, token)) {
    return c.html(
      page(
        "Invalid link",
        `<p style="font-size:15px;line-height:1.6;">This unsubscribe link is invalid or expired. You can change email settings from your account instead.</p>`,
      ),
      400,
    );
  }

  // Idempotent — flipping an already-false flag is fine. updateMany so a
  // since-deleted user doesn't 500 (count 0, still "success" to the reader).
  await prisma.user.updateMany({
    where: { id: userId },
    data: { emailDigest: false },
  });

  console.log(`[email] unsubscribed ${userId} from digest`);

  return c.html(
    page(
      "Unsubscribed",
      `<p style="font-size:15px;line-height:1.6;">Done — you'll no longer get daily activity emails from ourlittlefarm.</p>
       <p style="font-size:13px;color:#6b6258;line-height:1.6;">Changed your mind? Turn them back on from your account settings.</p>`,
    ),
  );
});
