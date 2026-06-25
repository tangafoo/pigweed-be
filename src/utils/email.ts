import { resendApiKey, emailFrom } from "./env";

// ─────────────────────────────────────────────────────────────
// EMAIL TRANSPORT — one send() over Resend's REST API.
//
// We hit https://api.resend.com/emails with fetch directly instead of
// pulling in the `resend` SDK: it's a single POST, and the BE's house
// style is "hand-roll the small thing, no dep" (see utils/i18n.ts).
//
// FAIL-OPEN, like moderation: with no RESEND_API_KEY (dev, or a
// misconfigured prod) we DON'T throw — we console.log the message and
// return ok:false. Email is a side effect of posting/commenting/signing
// up; it must never tank the request that triggered it. Every caller
// fires this without awaiting the result for that reason.
// ─────────────────────────────────────────────────────────────

const c = (color: string, msg: string) => `\x1b[${color}m${msg}\x1b[0m`;

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  // Plaintext fallback. Optional but recommended — spam filters score
  // multipart higher, and some clients prefer text.
  text?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
}: SendEmailInput): Promise<SendEmailResult> {
  const key = resendApiKey();

  // No key → log and bail. In dev this is the whole "email system": you
  // read the subject/recipient off the terminal, same as the OTP code.
  if (!key) {
    console.log(
      c("33", "[email:dry-run]"),
      `to=${to} subject=${JSON.stringify(subject)} (no RESEND_API_KEY — not sent)`,
    );
    return { ok: false, error: "no_api_key" };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom(),
        to,
        subject,
        html,
        ...(text ? { text } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        c("31", "[email:error]"),
        `to=${to} status=${res.status} ${detail}`,
      );
      return { ok: false, error: `http_${res.status}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    console.log(c("32", "[email:sent]"), `to=${to} id=${data.id ?? "?"} subject=${JSON.stringify(subject)}`);
    return { ok: true, id: data.id };
  } catch (err) {
    // Network blip / DNS / timeout. Fail open — log, don't throw.
    console.error(c("31", "[email:error]"), `to=${to}`, err);
    return { ok: false, error: "network" };
  }
}
