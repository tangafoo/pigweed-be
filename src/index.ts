import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { allowedOrigins } from './utils/env'
import { auth } from './utils/auth'
import { i18nMiddleware } from './middleware/i18n'
import { coins } from './routes/coins'
import { subscriptions } from './routes/subscriptions'
import { admin } from './routes/admin'
import { stripeWebhook } from './routes/stripe-webhook'
import { posts } from './routes/posts'
import { comments } from './routes/comments'
import { votes } from './routes/votes'
import { users } from './routes/users'
import { awards } from './routes/awards'
import { media } from './routes/media'
import { email } from './routes/email'
import { achievements } from './routes/achievements'
import { registerAchievementListeners } from './utils/achievements'

// Wire the achievement engine to the event bus at startup. After this
// runs, action handlers can emit domain events and the engine reacts.
registerAchievementListeners()

const app = new Hono()

app.use(logger())

// Browser auth is cookie-based, so the FE sends credentialed cross-origin
// requests. That requires an explicit (non-"*") allowed origin + the
// credentials flag. Origins are env-driven (see allowedOrigins) — prod is
// a CORS_ORIGIN change, nothing here moves. Handles OPTIONS preflight too.
app.use(
  '*',
  cors({
    origin: allowedOrigins(),
    credentials: true,
  }),
)

// Locale resolution runs on every request. Parses Accept-Language and
// stashes the result on c.get("locale"). Handlers that surface user-
// facing strings call t(locale, key) from utils/i18n.
app.use('*', i18nMiddleware)

app.get('/', (c) => {
  return c.text('Hello Bitch ass!')
})

// The egg — same favicon as the FE, so the API root shows the brand mark in a
// browser tab. Served from static/favicon.png (committed, ships in the image).
// Browsers also auto-request /favicon.ico, so answer both with the one asset.
const favicon = Bun.file(new URL('../static/favicon.png', import.meta.url).pathname)
app.get('/favicon.png', () => new Response(favicon, { headers: { 'content-type': 'image/png' } }))
app.get('/favicon.ico', () => new Response(favicon, { headers: { 'content-type': 'image/png' } }))

app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw))

app.route('/coins', coins)
app.route('/subscriptions', subscriptions)
app.route('/admin', admin)
app.route('/stripe/webhook', stripeWebhook)
app.route('/posts', posts)
app.route('/', comments)
app.route('/', votes)
app.route('/users', users)
app.route('/', awards)
app.route('/media', media)
app.route('/email', email)
app.route('/achievements', achievements)

const port = Number(process.env.PORT) || 3000

// Positive "I'm alive" banner. Without it, a healthy boot and a crashed boot
// look equally silent in the deploy logs (the tagged [posts]/[sse]/… loggers
// are per-request and never fire if the process dies at import time).
console.log(
  `[boot] pigweed-be listening on :${port} — env=${process.env.NODE_ENV ?? 'development'}`,
)

export default {
  // Railway (and most PaaS) inject the port to bind on via $PORT. Fall back
  // to 3000 for local dev where it's unset.
  port,
  fetch: app.fetch,
  // SSE (`GET /users/me/events`) holds a long-lived connection kept warm by a
  // 25s heartbeat. Bun's default socket idleTimeout is 10s, which would cut
  // the stream before each heartbeat (ERR_INCOMPLETE_CHUNKED_ENCODING → the
  // browser EventSource reconnects in a loop). Raise it above the heartbeat;
  // 255s is Bun's max.
  idleTimeout: 120,
}
