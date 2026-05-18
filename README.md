# pigweed-be

Backend for pigweed — an anonymous, hyperlocal, animal-themed social
network. Bun + Hono + Prisma 7 + Better Auth + Supabase Postgres
(PostGIS) + Stripe. Deploy target: **Railway**.

See `CLAUDE.md` for the full product brief, data/identity/geo models,
moderation rules, and the shared API contract.

## Develop

```sh
cp .env.example .env   # fill in DB URL, auth secret, Stripe/OpenAI keys
bun install
bun run db:migrate-deploy   # first run only
bun run seed:all            # first run only
bun run dev                 # watch mode on :3000
```

## Common commands

```sh
bun test                 # tests
bun run typecheck        # tsc --noEmit
bun run db:studio        # Prisma Studio
bun run stripe:listen    # forward Stripe webhooks to localhost:3000
```
