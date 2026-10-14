import { Hono } from 'hono'
import type { AccessDeps } from './access'
import { auth } from './auth'
import type { Deps } from './decide'
import { DecisionError } from './errors'
import type { Env } from './env'
import { budgetSnapshot, getCall, listCalls, parseSince, statsSnapshot, timelineSnapshot } from './log'
import { authorizationServerMetadata, authorizeForm, authorizeSubmit, protectedResourceMetadata, register, token } from './oauth'
import { visualizeHtml } from './visualize'
import { handleMcp } from './mcp'
import { parseMeta, requestSchema } from './schema'
import { runDecision, type Waiter } from './service'

export interface AppOptions {
  deps?: Deps
  /** Test seam: local JWKS instead of fetching Access certs. */
  access?: AccessDeps
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

  // One gate for everything except the OAuth endpoints below (see auth.ts). Browser traffic gets here via Access at the edge.
  app.use('*', auth(opts.access))

  app.get('/health', (c) => c.json({ ok: true, version: c.env.VERSION ?? 'dev' }))
  app.get('/', (c) =>
    c.json({
      name: 'decision-server',
      description: 'Jev-compatible decisions on free Workers AI Clef models, with Jev fallback.',
      version: c.env.VERSION ?? 'dev',
      source: 'https://github.com/PrashamTrivedi/decision-server',
      endpoints: ['POST /v1/systemone', 'GET /v1/budget', 'GET /v1/stats', 'GET /v1/calls', 'GET /v1/calls/:id', 'GET /v1/timeline', 'GET /visualize', 'POST /mcp', 'GET /health'],
      auth: 'Authorization: Bearer <decision key>, or Cloudflare Access login; /mcp also accepts OAuth tokens',
    }),
  )
  // Static shell: holds no data; relies on the Access cookie (same-origin) to call /v1/*.
  app.get('/visualize', (c) =>
    c.html(visualizeHtml, 200, { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'", 'Referrer-Policy': 'no-referrer' }),
  )
  app.get('/favicon.ico', (c) => c.body(null, 204))

  // MCP OAuth authorization server. Public metadata/registration/token; authorize requires an Access JWT.
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(new URL(c.req.url).origin)))
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(new URL(c.req.url).origin)))
  app.post('/oauth/register', register)
  app.get('/oauth/authorize', (c) => authorizeForm(c, opts.access))
  app.post('/oauth/authorize', (c) => authorizeSubmit(c, opts.access))
  app.post('/oauth/token', token)

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

  app.get('/v1/timeline', async (c) => {
    const d = Math.floor(Number(c.req.query('days')))
    const days = Number.isFinite(d) ? Math.min(Math.max(d, 1), 90) : 1
    return c.json(await timelineSnapshot(c.env.DB, days))
  })

  app.get('/v1/calls/:id', async (c) => {
    const call = await getCall(c.env.DB, c.req.param('id'))
    return call ? c.json(call) : c.json({ error: 'not found' }, 404)
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
        fallbackReason: q.fallbackReason || undefined,
        status: q.status || undefined,
        slim: q.slim === '1',
      }),
    )
  })

  app.onError((err, c) => {
    console.error('unhandled', err)
    return c.json({ error: 'internal' }, 500)
  })
  return app
}
