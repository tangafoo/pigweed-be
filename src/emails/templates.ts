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

// ─── 3. Daily digest (batched, nightly cron) ───────────────────────
// The job hands us EVERY pending event (not a pre-trimmed list) so we can
// compact per target: a thing with one event reads in full ("Your review
// “X” got an upvote!"); a thing with many shows a count ("…got 5 upvotes!").
// Wording is recipient-centric (no actor names) and type-aware — a post
// with a rating reads as a "review", a bare post as a "post", and comment
// activity as a "comment". `targetType`/`name`/`snippet` come from the job.
export interface DigestItem {
  /** post (no rating) vs review (rated post) vs comment — drives the noun. */
  targetType: "post" | "review" | "comment";
  /** Post/review title; ignored for comments (which have no title). */
  targetName: string;
  /** Link to the post page — clicking a line lands on the right place. */
  href: string;
  /** The comment/reply text (truncated) — shown on comment-related lines. */
  snippet?: string;
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

  const subject =
    total === 1
      ? "You have 1 new notification on ourlittlefarm"
      : `You have ${total} new notifications on ourlittlefarm`;

  const sections = [
    renderSection("💬 New comments on your posts", data.commentsOnPosts, commentLineHtml),
    renderSection("↩️ Replies to you", data.replies, replyLineHtml),
    renderSection("⬆️ Upvotes on your posts", data.upvotes, upvoteLineHtml),
    renderSection("⬆️ Upvotes on your comments", data.commentUpvotes, upvoteLineHtml),
  ]
    .filter(Boolean)
    .join("");

  // CTA: when the whole digest is a single event, the button goes straight
  // to that exact post/review/comment ("View review"). Otherwise it's the
  // generic farm link (a multi-item digest has no single "right place").
  const cta =
    total === 1
      ? button(`View ${all[0]!.targetType}`, all[0]!.href)
      : button("Open the farm", data.appUrl);

  const html = layout(
    heading(`Hey ${data.username} — here's what happened today`) +
      sections +
      `<p style="margin:22px 0 0;">${cta}</p>`,
    {
      preview: `${total} new ${total === 1 ? "thing" : "things"} happened on your farm.`,
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

// ─── Section compaction ────────────────────────────────────────────
// Cap post/comment lines per section so a busy day can't produce a wall of
// text; overflow collapses into "…and N more".
const MAX_GROUPS_PER_SECTION = 8;

interface TargetGroup {
  type: "post" | "review" | "comment";
  name: string;
  href: string;
  snippet?: string;
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

function commentLineHtml(g: TargetGroup): string {
  const base = `${alink(g.href, subjectInner(g))} received ${plural(g.count, "a comment", "comments")}!`;
  return g.count === 1 && g.snippet
    ? `${base} <span style="color:${colors.MUTED};">“${escapeHtml(g.snippet)}”</span>`
    : base;
}
function commentLineText(g: TargetGroup): string {
  const base = `${subjectText(g)} received ${pluralText(g.count, "a comment", "comments")}!`;
  return g.count === 1 && g.snippet ? `${base} “${g.snippet}”` : base;
}

// Replies: the subject is always "Your comment"; the snippet is the REPLY's
// text (not the parent), so it's appended as the quote rather than used in
// the subject.
function replyLineHtml(g: TargetGroup): string {
  const base = `${alink(g.href, "Your comment")} received ${plural(g.count, "a reply", "replies")}!`;
  return g.count === 1 && g.snippet
    ? `${base} <span style="color:${colors.MUTED};">“${escapeHtml(g.snippet)}”</span>`
    : base;
}
function replyLineText(g: TargetGroup): string {
  const base = `Your comment received ${pluralText(g.count, "a reply", "replies")}!`;
  return g.count === 1 && g.snippet ? `${base} “${g.snippet}”` : base;
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
