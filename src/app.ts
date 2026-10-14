import { Hono } from 'hono'
import { bearerAuth } from './auth'
import type { Deps } from './decide'
import { DecisionError } from './errors'
import type { Env } from './env'
import { budgetSnapshot, listCalls, parseSince, statsSnapshot } from './log'
import { handleMcp } from './mcp'
import { parseMeta, requestSchema } from './schema'
import { runDecision, type Waiter } from './service'

export interface AppOptions {
  deps?: Deps
}

/** Hono throws when there is no ExecutionContext (unit tests); fall back to fire-and-forget. */
export function waiterFor(c: { executionCtx: { waitUntil(p: Promise<any>): void } }): Waiter {
  try {
    const ctx = c.executionCtx
    if (ctx && typeof ctx.waitUntil === "function") return ctx
  } catch { /* no execution context */ }
  return { waitUntil: () => {} }
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>()

  app.get('/health', (c) => c.json({ ok: true, version: c.env.VERSION ?? 'dev' }))
  // Public service info only; every data route stays behind bearer auth.
  app.get('/', (c) =>
    c.json({
      name: 'decision-server',
      description: 'Jev-compatible decisions on free Workers AI Clef models, with Jev fallback.',
      version: c.env.VERSION ?? 'dev',
      source: 'https://github.com/PrashamTrivedi/decision-server',
      endpoints: ['POST /v1/systemone', 'GET /v1/budget', 'GET /v1/stats', 'GET /v1/calls', 'POST /mcp', 'GET /health'],
      auth: 'Authorization: Bearer <token> (all except / and /health)',
    }),
  )
  app.get('/favicon.ico', (c) => c.body(null, 204))

  app.use('/v1/*', bearerAuth)
  app.use('/mcp', bearerAuth)
  app.use('/mcp/*', bearerAuth)
  app.all('/mcp', (c) => handleMcp(c.env, c.req.raw, waiterFor(c), opts.deps))
  app.all('/mcp/*', (c) => handleMcp(c.env, c.req.raw, waiterFor(c), opts.deps))

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
      const out = await runDecision(c.env, waiterFor(c), parsed.data, meta, opts.deps)
      return c.json(out.response)
    } catch (err) {
      if (err instanceof DecisionError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })

  app.get('/v1/budget', async (c) => c.json(await budgetSnapshot(c.env.DB)))

  app.get('/v1/stats', async (c) => {
    const d = Math.floor(Number(c.req.query('days')))
    const days = Number.isFinite(d) ? Math.min(Math.max(d, 1), 90) : 1
    return c.json(await statsSnapshot(c.env.DB, days))
  })

  app.get('/v1/calls', async (c) => {
    const q = c.req.query()
    return c.json(
      await listCalls(c.env.DB, {
        decision: q.decision || undefined,
        servedBy: q.servedBy || undefined,
        since: parseSince(q.since),
        before: parseSince(q.before),
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    )
  })

  app.onError((err, c) => {
    console.error('unhandled', err)
    return c.json({ error: 'internal' }, 500)
  })
  return app
}
