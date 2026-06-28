import {
  layout,
  button,
  heading,
  paragraph,
  escapeHtml,
  colors,
} from "./layout";

// ─────────────────────────────────────────────────────────────
// EMAIL TEMPLATES — pure functions: data in, { subject, html, text } out.
// No sending here (that's utils/email.ts), no DB (that's the callers).
//
// COPY IS ENGLISH-ONLY for now. Every template takes the data it needs by
// value; localizing later means threading a Locale in and swapping the
// strings — the structure is ready. We DON'T localize today because the
// digest recipient's locale isn't stored on User (same known gap as the
// OTP email), and inventing 4-language copy would be worse than honest
// English. See CLAUDE.md "Real email send".
// ─────────────────────────────────────────────────────────────

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// ─── 0. OTP verification code (real-time, Better Auth) ─────────────
// Backs auth.ts's sendVerificationOTP. `type` is Better Auth's
// "email-verification" | "forget-password" | "sign-in".
export function otpEmail(input: { otp: string; type: string }): RenderedEmail {
  const purpose =
    input.type === "forget-password"
      ? "reset your password"
      : input.type === "sign-in"
        ? "sign in"
        : "verify your email";
  const subject = "Your ourlittlefarm verification code";

  const html = layout(
    heading("Your code") +
      paragraph(`Use this code to ${escapeHtml(purpose)}. It expires in 10 minutes.`) +
      `<p style="margin:18px 0 0;font-size:32px;font-weight:700;letter-spacing:0.18em;color:${colors.ACCENT};">${escapeHtml(input.otp)}</p>` +
      paragraph(`<span style="font-size:13px;color:${colors.MUTED};">Didn't request this? You can safely ignore this email.</span>`),
    { preview: `Your code is ${input.otp}` },
  );

  const text = `Your ourlittlefarm code to ${purpose}: ${input.otp}\nIt expires in 10 minutes. Didn't request it? Ignore this email.`;

  return { subject, html, text };
}

// ─── 1. Welcome (real-time, on signup) ─────────────────────────────
export function welcomeEmail(input: {
  username: string;
  animal: string;
  appUrl: string;
}): RenderedEmail {
  // heading()/button() escape their own input — pass RAW there. Only
  // paragraph() takes trusted HTML, so values going into it are escapeHtml'd.
  const animal = escapeHtml(input.animal.toLowerCase());
  const subject = "Welcome to ourlittlefarm 🥚";

  const html = layout(
    heading(`Welcome, ${input.username}!`) +
      paragraph(
        `You've hatched onto the farm as a <b>${animal}</b>. Your avatar is one of a kind — reroll it any time from settings until it feels like you.`,
      ) +
      paragraph(
        `ourlittlefarm is your hyperlocal feed: you'll see posts and reviews from animals near you, and they'll see yours. Post an update, leave a review, upvote a good egg.`,
      ) +
      `<p style="margin:22px 0 0;">${button("Open the farm", input.appUrl)}</p>`,
    { preview: "Your farm is ready — say hi to the neighbors." },
  );

  const text = `Welcome, ${input.username}!

You've hatched onto the farm as a ${animal}. ourlittlefarm is your hyperlocal feed — post updates, leave reviews, upvote good eggs.

Open the farm: ${input.appUrl}`;

  return { subject, html, text };
}

// ─── 2. Achievement unlocked (real-time, on grant) ─────────────────
export function achievementEmail(input: {
  username: string;
  achievementName: string;
  achievementDescription: string;
  rewardCoins: number;
  newCoinBalance: number;
  appUrl: string;
}): RenderedEmail {
  const subject = `Achievement unlocked: ${input.achievementName} 🏆`;

  const html = layout(
    // heading() escapes its own input — pass the raw name.
    heading(`You unlocked “${input.achievementName}”!`) +
      paragraph(escapeHtml(input.achievementDescription)) +
      paragraph(
        `That's <b>+${input.rewardCoins} coins</b> — your balance is now <b>${input.newCoinBalance}</b>.`,
      ) +
      `<p style="margin:22px 0 0;">${button("See your achievements", `${input.appUrl}/me`)}</p>`,
    { preview: `+${input.rewardCoins} coins added to your balance.` },
  );

  const text = `Achievement unlocked: ${input.achievementName}

${input.achievementDescription}

+${input.rewardCoins} coins — balance now ${input.newCoinBalance}.

${input.appUrl}/me`;

  return { subject, html, text };
}

// ─── 3. Magic-link login (real-time, Better Auth) ──────────────────
// Backs auth.ts's magicLink sendMagicLink. The CLI onboarding script
// (scripts/register-subscriber.ts) triggers this so an email-only customer
// can log in with one click — no password to remember.
export function magicLinkEmail(input: {
  url: string;
  username: string;
  /** The animal rolled for this user — included so the email also welcomes them. */
  animal?: string;
}): RenderedEmail {
  const subject = "Welcome to ourlittlefarm! Your sign-in link";
  const animal = input.animal ? escapeHtml(input.animal.toLowerCase()) : null;

  // When we know their animal, the email doubles as a friendly welcome: here's
  // your handle + the critter the farm review community rolled for you.
  const identityLine = animal
    ? paragraph(
        `The farm review community assigned you a handle: <b>${escapeHtml(input.username)}</b> — one of the <b>${animal}</b>s 🥚 on our farm. You can reroll later in settings.`,
      )
    : "";

  const html = layout(
    heading(`An account was created for you, ${input.username}`) +
      identityLine +
      paragraph(
        "Tap the button to sign in to ourlittlefarm. The link is single-use and expires shortly.",
      ) +
      `<p style="margin:22px 0 0;">${button("View latest happenings", input.url)}</p>` +
      paragraph(
        `<span style="font-size:13px;color:${colors.MUTED};">Didn't ask to sign in? You can safely ignore this email.</span>`,
      ),
    { preview: "Your single-use sign-in link for ourlittlefarm." },
  );

  const text = `An account was created for you on ourlittlefarm, ${input.username}:${
    animal ? `\n\nThe farm review community assigned you a handle: ${input.username} — one of the ${animal}s on our farm. You can reroll later in settings.` : ""
  }\n\n${input.url}\n\nThe link is single-use and expires shortly. Didn't ask to sign in? Ignore this email.`;

  return { subject, html, text };
}

// ─── 3b. Contact / "egg feedback" form → the boss's inbox ──────────
// Sent when a user submits the FE feedback form. Enriched with the
// signed-in user (if any) so replies have context.
export function feedbackEmail(input: {
  fromEmail: string;
  topic: string;
  message: string;
  username?: string;
  userId?: string;
}): RenderedEmail {
  const subject = `[ourlittlefarm] ${input.topic} — feedback from ${input.fromEmail}`;
  const meta = [
    `From: ${escapeHtml(input.fromEmail)}`,
    input.username ? `User: ${escapeHtml(input.username)}` : null,
    input.userId ? `ID: ${escapeHtml(input.userId)}` : null,
    `Topic: ${escapeHtml(input.topic)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const html = layout(
    heading("New feedback 🥚") +
      paragraph(`<span style="font-size:13px;color:${colors.MUTED};">${meta}</span>`) +
      paragraph(escapeHtml(input.message).replace(/\n/g, "<br>")),
    { preview: `Feedback (${input.topic}) from ${input.fromEmail}` },
  );

  const text = `New feedback\n${meta}\n\n${input.message}`;
  return { subject, html, text };
}

// ─── 4. Subscription started (real-time, on Stripe checkout) ────────
export function subscriptionStartedEmail(input: {
  username: string;
  priceLabel: string; // e.g. "RM50/week"
  eggsPerDelivery: number;
  appUrl: string;
}): RenderedEmail {
  const subject = "Your egg subscription is live 🥚";
  const price = escapeHtml(input.priceLabel);

  const html = layout(
    heading(`You're subscribed, ${input.username}!`) +
      paragraph(
        `A fresh tray of <b>${input.eggsPerDelivery} eggs</b> is on its way to you every week. We'll auto-charge <b>${price}</b> — nothing else to do.`,
      ) +
      `<p style="margin:22px 0 0;">${button("See your egg stats", `${input.appUrl}/subscriptions`)}</p>`,
    { preview: `${input.eggsPerDelivery} eggs a week, ${input.priceLabel}.` },
  );

  const text = `You're subscribed, ${input.username}!

A fresh tray of ${input.eggsPerDelivery} eggs is on its way every week. We'll auto-charge ${input.priceLabel}.

See your egg stats: ${input.appUrl}/subscriptions`;

  return { subject, html, text };
}

// ─── 5. Payment failed (real-time, on Stripe invoice.payment_failed) ─
export function paymentFailedEmail(input: {
  username: string;
  appUrl: string;
}): RenderedEmail {
  const subject = "We couldn't charge your egg subscription";

  const html = layout(
    heading(`A quick payment hiccup, ${input.username}`) +
      paragraph(
        "We tried to charge this week's egg delivery but the payment didn't go through. Update your card to keep the eggs coming — Stripe will retry automatically.",
      ) +
      `<p style="margin:22px 0 0;">${button("Update payment", `${input.appUrl}/subscriptions`)}</p>`,
    { preview: "Update your card to keep your egg subscription active." },
  );

  const text = `A quick payment hiccup, ${input.username}.

We tried to charge this week's egg delivery but it didn't go through. Update your card to keep the eggs coming:
${input.appUrl}/subscriptions`;

  return { subject, html, text };
}

// NOTE: subscriptionStartedEmail + paymentFailedEmail above are wired into the
// (dormant) Stripe webhook and only fire under phase-2 auto-billing. No
// subscriber-facing email is sent today — manual subscribers are managed from
// the admin panel, not nagged by mail.

// ─── 6. Daily digest (batched, nightly cron) ───────────────────────
// The job hands us EVERY pending event (not a pre-trimmed list) so we can
// compact per target. Two voices, by design:
//   • The SUBJECT (and the CTA) is the recipient-centric headline of the
//     single most relevant event — "Your review “Gorgeous Eggs” received a
//     comment!" — so the inbox preview reads like a real notification, not
//     clickbait.
//   • The BODY leads with WHO + WHAT for comments/replies — "frantic_pandan
//     commented: “…”" — since the headline already said the rest. Upvote
//     lines stay recipient-centric (there's no text to quote). Aggregated
//     lines (many events on one target) collapse to a count.
// `targetType`/`name`/`snippet`/`actor` come from the job.
export interface DigestItem {
  /** post (no rating) vs review (rated post) vs comment — drives the noun. */
  targetType: "post" | "review" | "comment";
  /** Post/review title; ignored for comments (which have no title). */
  targetName: string;
  /** Link to the post page — clicking a line lands on the right place. */
  href: string;
  /** The comment/reply text (truncated) — shown on comment-related lines. */
  snippet?: string;
  /** Username of whoever acted — leads the comment/reply body line. */
  actor?: string;
  /** Compaction key: postId for post-targeted events, commentId for comment. */
  groupKey: string;
}

export interface DigestData {
  username: string;
  commentsOnPosts: DigestItem[];
  replies: DigestItem[];
  upvotes: DigestItem[];
  commentUpvotes: DigestItem[];
  appUrl: string;
  unsubscribeUrl: string;
}

export function digestEmail(data: DigestData): RenderedEmail {
  const all = [
    ...data.commentsOnPosts,
    ...data.replies,
    ...data.upvotes,
    ...data.commentUpvotes,
  ];
  const total = all.length;

  // The LEAD event (highest-priority kind first) drives the subject, the
  // preheader, and — when it's the only one — the CTA. Direct interaction
  // (comments/replies) outranks upvotes. total is always ≥1 (the job never
  // builds an empty digest), so a lead always exists.
  const lead: { kind: DigestKind; item: DigestItem } = data.commentsOnPosts[0]
    ? { kind: "comment", item: data.commentsOnPosts[0] }
    : data.replies[0]
      ? { kind: "reply", item: data.replies[0] }
      : data.upvotes[0]
        ? { kind: "upvote", item: data.upvotes[0] }
        : { kind: "commentUpvote", item: data.commentUpvotes[0]! };

  // Subject = the lead event's real headline, never "You have N notifications"
  // (reads as spam). Any other events get a quiet "(+N more)".
  const headline = digestHeadline(lead.kind, lead.item);
  const subject = total === 1 ? headline : `${headline} (+${total - 1} more)`;

  const sections = [
    renderSection("💬 New comments on your posts", data.commentsOnPosts, commentLineHtml),
    renderSection("↩️ Replies to you", data.replies, replyLineHtml),
    renderSection("⬆️ Upvotes on your posts", data.upvotes, upvoteLineHtml),
    renderSection("⬆️ Upvotes on your comments", data.commentUpvotes, upvoteLineHtml),
  ]
    .filter(Boolean)
    .join("");

  // CTA: a single-event digest links straight to that exact post/review/
  // comment ("View review"); a multi-item digest has no single "right place"
  // so it's the generic farm link.
  const cta =
    total === 1
      ? button(`View ${lead.item.targetType}`, lead.item.href)
      : button("Open the farm", data.appUrl);

  const html = layout(
    heading(`Hey ${data.username} — here's what happened today`) +
      sections +
      `<p style="margin:22px 0 0;">${cta}</p>`,
    {
      // Preheader (inbox preview line): the lead event's comment text when it
      // has one, else a gentle count.
      preview:
        lead.item.snippet ??
        `${total} new ${total === 1 ? "thing" : "things"} happened on your farm.`,
      unsubscribeUrl: data.unsubscribeUrl,
    },
  );

  const text = [
    `Hey ${data.username} — here's what happened on ourlittlefarm today:`,
    "",
    ...textSection("New comments on your posts", data.commentsOnPosts, commentLineText),
    ...textSection("Replies to you", data.replies, replyLineText),
    ...textSection("Upvotes on your posts", data.upvotes, upvoteLineText),
    ...textSection("Upvotes on your comments", data.commentUpvotes, upvoteLineText),
    "",
    `Open the farm: ${data.appUrl}`,
    `Turn off these daily emails: ${data.unsubscribeUrl}`,
  ].join("\n");

  return { subject, html, text };
}

// Which section an event belongs to — drives subject phrasing.
type DigestKind = "comment" | "reply" | "upvote" | "commentUpvote";

// Recipient-centric one-liner — the email SUBJECT (plain text). "Your review
// “Gorgeous Eggs” received a comment!" reads like a real notification.
function digestHeadline(kind: DigestKind, item: DigestItem): string {
  const subj =
    item.targetType === "comment"
      ? "Your comment"
      : `Your ${item.targetType} “${item.targetName}”`;
  switch (kind) {
    case "comment":
      return `${subj} received a comment!`;
    case "reply":
      return "Your comment received a reply!";
    case "upvote":
      return `${subj} got an upvote!`;
    case "commentUpvote":
      return "Your comment got an upvote!";
  }
}

// ─── Section compaction ────────────────────────────────────────────
// Cap post/comment lines per section so a busy day can't produce a wall of
// text; overflow collapses into "…and N more".
const MAX_GROUPS_PER_SECTION = 8;

interface TargetGroup {
  type: "post" | "review" | "comment";
  name: string;
  href: string;
  snippet?: string;
  actor?: string;
  count: number;
}

// Collapse raw events into groups keyed by groupKey (postId or commentId),
// busiest first. One event → render in full; many → a count.
function groupItems(items: DigestItem[]): { groups: TargetGroup[]; more: number } {
  const byKey = new Map<string, TargetGroup>();
  for (const it of items) {
    const g = byKey.get(it.groupKey);
    if (g) g.count++;
    else
      byKey.set(it.groupKey, {
        type: it.targetType,
        name: it.targetName,
        href: it.href,
        snippet: it.snippet,
        actor: it.actor,
        count: 1,
      });
  }
  const sorted = [...byKey.values()].sort((a, b) => b.count - a.count);
  return {
    groups: sorted.slice(0, MAX_GROUPS_PER_SECTION),
    more: Math.max(0, sorted.length - MAX_GROUPS_PER_SECTION),
  };
}

// ── line builders ──────────────────────────────────────────────────
// "an upvote" vs "<b>5</b> upvotes".
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : `<b>${n}</b> ${many}`;
}
function pluralText(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

// Clickable subject ("Your review “X”" / "Your comment"), linked to the target.
function alink(href: string, inner: string): string {
  return `<a href="${href}" style="color:${colors.ACCENT};font-weight:600;text-decoration:none;">${inner}</a>`;
}
function subjectInner(g: TargetGroup): string {
  return g.type === "comment"
    ? g.snippet
      ? `Your comment “${escapeHtml(g.snippet)}”`
      : "Your comment"
    : `Your ${g.type} “${escapeHtml(g.name)}”`;
}
function subjectText(g: TargetGroup): string {
  return g.type === "comment"
    ? g.snippet
      ? `Your comment “${g.snippet}”`
      : "Your comment"
    : `Your ${g.type} “${g.name}”`;
}

function upvoteLineHtml(g: TargetGroup): string {
  return `${alink(g.href, subjectInner(g))} got ${plural(g.count, "an upvote", "upvotes")}!`;
}
function upvoteLineText(g: TargetGroup): string {
  return `${subjectText(g)} got ${pluralText(g.count, "an upvote", "upvotes")}!`;
}

// A muted quote span for the comment text.
function quote(snippet: string): string {
  return ` <span style="color:${colors.MUTED};">“${escapeHtml(snippet)}”</span>`;
}
const who = (g: TargetGroup) => alink(g.href, escapeHtml(g.actor ?? "Someone"));

// Single comment → "<actor> commented: “…”" (the headline lives in the
// subject). Many → recipient-centric count, since there's no single actor.
function commentLineHtml(g: TargetGroup): string {
  if (g.count === 1) return `${who(g)} commented${g.snippet ? `:${quote(g.snippet)}` : "."}`;
  return `${alink(g.href, subjectInner(g))} received <b>${g.count}</b> comments`;
}
function commentLineText(g: TargetGroup): string {
  if (g.count === 1)
    return `${g.actor ?? "Someone"} commented${g.snippet ? `: “${g.snippet}”` : "."}`;
  return `${subjectText(g)} received ${g.count} comments`;
}

// Replies mirror comments. The snippet is the REPLY's text.
function replyLineHtml(g: TargetGroup): string {
  if (g.count === 1) return `${who(g)} replied${g.snippet ? `:${quote(g.snippet)}` : "."}`;
  return `${alink(g.href, "Your comment")} received <b>${g.count}</b> replies`;
}
function replyLineText(g: TargetGroup): string {
  if (g.count === 1)
    return `${g.actor ?? "Someone"} replied${g.snippet ? `: “${g.snippet}”` : "."}`;
  return `Your comment received ${g.count} replies`;
}

// One titled block of <li>s, or "" when empty. `line` builds each group's
// HTML and does its own escaping.
function renderSection(
  title: string,
  items: DigestItem[],
  line: (g: TargetGroup) => string,
): string {
  if (items.length === 0) return "";
  const { groups, more } = groupItems(items);
  const lis = groups.map(
    (g) => `<li style="margin:0 0 10px;font-size:15px;line-height:1.5;">${line(g)}</li>`,
  );
  if (more > 0) {
    lis.push(
      `<li style="margin:0 0 10px;font-size:15px;line-height:1.5;color:${colors.MUTED};">…and ${more} more</li>`,
    );
  }
  return `<div style="margin:0 0 18px;">
    <p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:${colors.MUTED};">${escapeHtml(title)}</p>
    <ul style="margin:0;padding:0 0 0 18px;color:${colors.INK};">${lis.join("")}</ul>
  </div>`;
}

function textSection(
  title: string,
  items: DigestItem[],
  line: (g: TargetGroup) => string,
): string[] {
  if (items.length === 0) return [];
  const { groups, more } = groupItems(items);
  const lines = groups.map((g) => `- ${line(g)}`);
  if (more > 0) lines.push(`- …and ${more} more`);
  return [`${title}:`, ...lines, ""];
}
