import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./db";

const c = (color: string, msg: string) => `\x1b[${color}m${msg}\x1b[0m`;

export const auth = betterAuth({
    database: prismaAdapter(prisma, {
        provider: "postgresql",
    }),
    emailAndPassword: {
        enabled: true,
    },
    logger: {
        level: "debug",
        log: (level, message, ...args) => {
            console.log(c("36", `[better-auth:${level}]`), message, ...args);
        },
    },
});