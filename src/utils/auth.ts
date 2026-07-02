import { betterAuth } from "better-auth";
import { username, emailOTP, magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./db";
import { rollIdentity } from "./identity";
import { sendEmail } from "./email";
import { welcomeEmail, otpEmail, magicLinkEmail } from "../emails/templates";
import {
    allowedOrigins,
    passkeyRpId,
    passkeyRpName,
    passkeyOrigin,
    appUrl,
} from "./env";

const c = (color: string, msg: string) => `\x1b[${color}m${msg}\x1b[0m`;

export const auth = betterAuth({
    database: prismaAdapter(prisma, {
        provider: "postgresql",
    }),
    // CSRF allow-list for credentialed cross-origin auth calls from the
    // FE. Same source as the CORS origins so the two never drift apart.
    trustedOrigins: allowedOrigins(),
    advanced: {
        // Where to read the client IP for rate limiting. Railway (and most
        // proxies) forward it in `x-forwarded-for`; `x-real-ip` is a common
        // fallback. In dev there's no proxy, so index.ts fills x-forwarded-for
        // from Bun's socket IP before the request reaches the auth handler —
        // otherwise Better Auth can't find an IP and logs the "rate limiting
        // skipped" warning.
        ipAddress: {
            ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
        },
        ...(process.env.NODE_ENV === "production" ? {
            crossSubDomainCookies: {
                enabled: true,
                domain: ".ourlittlefarm.club",
            }
        } : {}),
    },
    emailAndPassword: {
        enabled: true,
        // Enforcement of email verification at sign-in is deliberately OFF
        // for now so existing test users (and you in dev) keep working. Flip
        // to true once the FE has a verify-your-email UX. The plugin below
        // gives you the OTP infrastructure either way.
        requireEmailVerification: false,
    },
    // Built-in rate limiting. Defaults are generous; the strict caps below
    // protect the auth surfaces specifically — brute-force on /sign-in is
    // the canonical attack to deter.
    rateLimit: {
        enabled: true,
        window: 60,
        max: 100,
        customRules: {
            "/sign-in/email": { window: 60, max: 5 },
            "/sign-in/username": { window: 60, max: 5 },
            "/sign-up/email": { window: 60, max: 5 },
            "/email-otp/send-verification-otp": { window: 60, max: 3 },
            "/sign-in/magic-link": { window: 60, max: 3 },
        },
    },
    plugins: [
        // The username plugin owns the `username` column from here on:
        //  - validates length & charset at signup
        //  - returns specific error codes (USERNAME_TAKEN, USERNAME_TOO_SHORT, …)
        //    instead of the generic FAILED_TO_CREATE_USER
        //  - adds POST /api/auth/sign-in/username (login by username)
        //  - adds GET  /api/auth/is-username-available?username=X
        //  - may require a `displayUsername` column on User — if migrate complains
        //    after adding this plugin, add it to schema.prisma and re-migrate.
        username({
            minUsernameLength: 3,
            maxUsernameLength: 30,
        }),
        // WebAuthn / passkeys via @better-auth/passkey. Backed by the `Passkey`
        // model in schema.prisma (shape locked by the plugin — don't add fields
        // it doesn't know about). Exposes /api/auth/passkey/* endpoints:
        //   - POST /passkey/add-passkey            (signed-in user adds a passkey)
        //   - POST /sign-in/passkey                (passwordless sign-in)
        //   - GET  /passkey/list-user-passkeys
        //   - POST /passkey/delete-passkey
        //   - POST /passkey/update-passkey
        // rpID/rpName/origin come from env (see utils/env.ts) — dev defaults
        // to localhost; prod uses PASSKEY_RP_ID=ourlittlefarm.club and the
        // matching PASSKEY_ORIGIN=https://ourlittlefarm.club.
        passkey({
            rpID: passkeyRpId(),
            rpName: passkeyRpName(),
            origin: passkeyOrigin(),
        }),
        // 6-digit OTP via email for email verification + password reset + sign-in.
        // The sendVerificationOTP callback is where the email actually goes out.
        // In dev we console.log so you can copy the code from the terminal.
        // For prod, replace the body with a call to Resend / Postmark / SendGrid.
        emailOTP({
            sendVerificationOTP: async ({ email, otp, type }) => {
                // Real send via the shared email layer (Resend). With no
                // RESEND_API_KEY (dev) sendEmail returns ok:false; we then
                // print the code to the terminal so you can still verify
                // locally — but we DON'T log it once mail is actually sending,
                // so the OTP never leaks into prod logs.
                // NOTE: locale isn't available here (this runs outside the
                // Hono request context), so the copy is the default locale.
                // See CLAUDE.md "Real email send" for the locale plumb-through.
                const { subject, html, text } = otpEmail({ otp, type });
                const res = await sendEmail({ to: email, subject, html, text });
                if (!res.ok) {
                    console.log(
                        c("33", `[email-otp]`),
                        `type=${type} email=${email} otp=${otp} (not emailed — dev fallback)`,
                    );
                }
            },
        }),
        // Passwordless one-click login. Backs POST /api/auth/sign-in/magic-link.
        // The CLI onboarding script (scripts/register-subscriber.ts) calls
        // auth.api.signInMagicLink to email an existing email-only customer a
        // login link — no password to remember. sendMagicLink fails open like
        // the OTP callback (sendEmail logs in dev). The link target is the FE
        // (appUrl), where Better Auth's client verifies the token.
        magicLink({
            sendMagicLink: async ({ email, url }) => {
                // Best-effort username for the greeting — single fail-open
                // lookup; fall back to the email local-part if absent.
                const user = await prisma.user
                    .findUnique({ where: { email }, select: { username: true, animal: true } })
                    .catch(() => null);
                const name = user?.username ?? email.split("@")[0];
                const { subject, html, text } = magicLinkEmail({
                    url,
                    username: name,
                    animal: user?.animal,
                });
                const res = await sendEmail({ to: email, subject, html, text });
                if (!res.ok) {
                    console.log(
                        c("33", `[magic-link]`),
                        `email=${email} url=${url} (not emailed — dev fallback)`,
                    );
                }
            },
        }),
    ],
    // Remaining additionalFields — username is now managed by the plugin
    // and is no longer declared here. animal + avatarSeed are still
    // server-injected by the before-create hook below.
    user: {
        additionalFields: {
            gender: { type: "string", required: true, input: true },
            // Optional contact number — settable at signup AND via updateUser
            // (settings). No verification yet.
            phoneNumber: { type: "string", required: false, input: true },
            animal: { type: "string", required: false, input: false },
            avatarSeed: { type: "number", required: false, input: false },
            avatarRerolls: { type: "number", required: false, input: false },
            isFoundingFlock: { type: "boolean", required: false, input: false },
            isFarmOwner: { type: "boolean", required: false, input: false },
            isAdmin: { type: "boolean", required: false, input: false },
            coinBalance: { type: "number", required: false, input: false },
            unlockCoins: { type: "number", required: false, input: false },
        },
    },
    // before-create hook: inject animal + avatarSeed into the new user
    // row before it's inserted. Runs once per signup, atomic with the
    // insert so a new user always lands with a complete identity.
    databaseHooks: {
        user: {
            create: {
                before: async (user) => {
                    const { animal, avatarSeed } = rollIdentity();
                    console.log(`[auth] signup ${user.username} — rolled ${animal} (seed ${avatarSeed})`);
                    // pigweed has no separate "display name" concept — the handle
                    // IS the identity. Force displayUsername to mirror username so
                    // they can never drift apart. Better Auth's plugin would
                    // otherwise stash the original-case input in displayUsername
                    // and the lowercased form in username; here both end up
                    // lowercased + identical. See memory: username-equals-display-username.
                    return {
                        data: {
                            ...user,
                            animal,
                            avatarSeed,
                            displayUsername: user.username,
                        },
                    };
                },
                // after-create: send the welcome email. Fire-and-forget —
                // sendEmail fails open (logs in dev / on error) and we never
                // await it, so a slow or down mail provider can't stall or
                // fail the signup. The `animal` is now present on the row
                // (injected by the before hook above).
                after: async (user) => {
                    const u = user as typeof user & {
                        username?: string;
                        animal?: string;
                    };
                    const { subject, html, text } = welcomeEmail({
                        username: u.username ?? u.name ?? "friend",
                        animal: u.animal ?? "animal",
                        appUrl: appUrl(),
                    });
                    void sendEmail({ to: user.email, subject, html, text });
                },
            },
        },
    },
    logger: {
        level: "debug",
        log: (level, message, ...args) => {
            console.log(c("36", `[better-auth:${level}]`), message, ...args);
        },
    },
});