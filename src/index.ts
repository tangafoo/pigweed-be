import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { auth } from './utils/auth'

const app = new Hono()

app.use(logger())

app.get('/', (c) => {
  return c.text('Hello Bitch ass!')
})

app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw))

export default {
  port: 3000,
  fetch: app.fetch,
}
