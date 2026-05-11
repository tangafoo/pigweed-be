import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { auth } from './utils/auth'
import { coins } from './routes/coins'
import { stripeWebhook } from './routes/stripe-webhook'
import { posts } from './routes/posts'

const app = new Hono()

app.use(logger())

app.get('/', (c) => {
  return c.text('Hello Bitch ass!')
})

app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw))

app.route('/coins', coins)
app.route('/stripe/webhook', stripeWebhook)
app.route('/posts', posts)

export default {
  port: 3000,
  fetch: app.fetch,
}
