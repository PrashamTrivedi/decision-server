import { Hono } from 'hono'
import { bearerAuth } from './auth'
import { decide, type Deps } from './decide'
import { DecisionError } from './errors'
import type { Env } from './env'
import { parseMeta, requestSchema } from './schema'

export interface AppOptions {
  deps?: Deps
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>()

  app.get('/health', (c) => c.json({ ok: true, version: c.env.VERSION ?? 'dev' }))

  app.use('/v1/*', bearerAuth)

  app.post('/v1/systemone', async (c) => {
    const meta = parseMeta(c.req.raw.headers)
    let json: unknown
    try {
      json = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const parsed = requestSchema.safeParse(json)
    if (!parsed.success) return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400)
    try {
      const res = await decide(c.env, parsed.data, meta, opts.deps)
      return c.json(res)
    } catch (err) {
      if (err instanceof DecisionError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })

  app.onError((err, c) => c.json({ error: `internal error: ${err.message}` }, 500))
  return app
}
