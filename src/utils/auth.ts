import { betterAuth } from "better-auth";
import { username, emailOTP } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./db";
import { rollIdentity } from "./identity";
import {
    allowedOrigins,
    passkeyRpId,
    passkeyRpName,
    passkeyOrigin,
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
                console.log(
                    c("33", `[email-otp]`),
                    `type=${type} email=${email} otp=${otp}`,
                );
                // TODO(prod): replace with real email send. Example with Resend:
                //   await resend.emails.send({
                //     from: "no-reply@ourlittlefarm.club",
                //     to: email,
                //     subject: `ourlittlefarm verification code: ${otp}`,
                //     html: `Your code is <b>${otp}</b>. Expires in 10 min.`,
                //   });
            },
        }),
    ],
    // Remaining additionalFields — username is now managed by the plugin
    // and is no longer declared here. animal + avatarSeed are still
    // server-injected by the before-create hook below.
    user: {
        additionalFields: {
            gender: { type: "string", required: true, input: true },
            animal: { type: "string", required: false, input: false },
            avatarSeed: { type: "number", required: false, input: false },
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