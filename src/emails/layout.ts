// Shared HTML shell for every ourlittlefarm email. Hand-rolled, inline
// styles only — email clients (Gmail/Outlook) strip <style> blocks and
// ignore most modern CSS, so everything that must render lives inline on
// the element. Keep the palette and structure here; templates.ts supplies
// the body. Brand: the public name is "ourlittlefarm" (never "pigweed").

import { emailLogoUrl } from "../utils/env";

// Punk-farm palette, muted for email (loud colors trip spam heuristics).
const INK = "#1c1a17";
const PAPER = "#faf7f0";
const CARD = "#ffffff";
const MUTED = "#6b6258";
const ACCENT = "#3a7d44"; // farm green
const BORDER = "#e7e0d4";

export interface LayoutOptions {
  // Footer unsubscribe link. Omit for transactional mail (welcome, OTP)
  // that has no opt-out — only the digest passes one.
  unsubscribeUrl?: string;
  // "preheader" — the grey preview line shown in the inbox list next to
  // the subject. Hidden in the body itself.
  preview?: string;
}

export function layout(bodyHtml: string, opts: LayoutOptions = {}): string {
  const preheader = opts.preview
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preview)}</div>`
    : "";

  const unsubscribe = opts.unsubscribeUrl
    ? `<p style="margin:12px 0 0;">
         You're getting this because activity happened on your ourlittlefarm account.
         <a href="${opts.unsubscribeUrl}" style="color:${MUTED};text-decoration:underline;">Turn off these daily emails</a>.
       </p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
  </head>
  <body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    ${preheader}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td style="padding:0 8px 16px;">
                <img src="${emailLogoUrl()}" alt="ourlittlefarm" height="28" style="display:block;height:28px;width:auto;max-width:200px;border:0;outline:none;text-decoration:none;" />
              </td>
            </tr>
            <tr>
              <td style="background:${CARD};border:1px solid ${BORDER};border-radius:14px;padding:28px 24px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 8px 0;color:${MUTED};font-size:12px;line-height:1.5;">
                <p style="margin:0;">ourlittlefarm — your local farm, in your pocket.</p>
                ${unsubscribe}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Primary call-to-action button. Bulletproof-ish: a styled <a> works in
// every modern client; VML for old Outlook is overkill for this app.
export function button(label: string, href: string): string {
  return `<a href="${href}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px;">${escapeHtml(label)}</a>`;
}

// Section/heading helpers so templates read declaratively.
export function heading(text: string): string {
  return `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${INK};">${escapeHtml(text)}</h1>`;
}

export function paragraph(html: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${INK};">${html}</p>`;
}

export const colors = { INK, PAPER, CARD, MUTED, ACCENT, BORDER };

// Escape user-supplied text (usernames, post titles, comment snippets)
// before it lands in HTML. Templates call this on every dynamic string —
// never interpolate raw user input into the markup.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
