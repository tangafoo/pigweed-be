import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { allowedOrigins } from './utils/env'
import { auth } from './utils/auth'
import { i18nMiddleware } from './middleware/i18n'
import { coins } from './routes/coins'
import { stripeWebhook } from './routes/stripe-webhook'
import { posts } from './routes/posts'
import { comments } from './routes/comments'
import { votes } from './routes/votes'
import { users } from './routes/users'
import { awards } from './routes/awards'
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

app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw))

app.route('/coins', coins)
app.route('/stripe/webhook', stripeWebhook)
app.route('/posts', posts)
app.route('/', comments)
app.route('/', votes)
app.route('/users', users)
app.route('/', awards)

export default {
  port: 3000,
  fetch: app.fetch,
}
