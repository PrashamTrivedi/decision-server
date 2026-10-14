import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { z } from 'zod'
import type { Deps } from './decide'
import { DecisionError } from './errors'
import type { Env } from './env'
import { budgetSnapshot, listCalls, statsSnapshot } from './log'
import { DEFAULT_DEADLINE_MS, parseMeta, questionsSchema } from './schema'
import { runDecision, type Waiter } from './service'

/** Question syntax, same as jev-tools' PREAMBLE. */
export const PREAMBLE =
  'Typed judgment questions answered in well under a second for a tiny fraction of a cent. Use it to learn something about content INSTEAD of reading it into your context; only the answers come back. ' +
  'Not for exact lookups, counting, or anything grep answers. ' +
  'Ask every question you may need in ONE call (they share state). Give every choice an `other` option. Describe score levels as concrete situations, not adjectives. ' +
  'questions_json is a STRING holding a JSON object keyed by question id; types: ' +
  '{"type":"noul","instructions":"..."} (yes/no probability), {"type":"choice","instructions":"...","criteria":{"option":"description"}}, {"type":"score","instructions":"...","criteria":["level 0 situation","level 1 situation", "..."]} (2-10 ordered levels).'

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) })
const trunc = (s: string | null, n = 200) => (s && s.length > n ? s.slice(0, n) + '…' : s)

export function createDecisionMcpServer(env: Env, waiter: Waiter, deps: Deps = {}): McpServer {
  const server = new McpServer({ name: 'decision-server-mcp', version: '0.1.0', title: 'Decision Server' })

  server.registerTool(
    'decide',
    {
      title: 'Decide',
      description:
        'Answer typed decision questions about some state. Served by free Cloudflare Clef models when possible, falling back to Jev. Returns answers plus servedBy and routeReason. ' +
        PREAMBLE +
        ' Example questions_json: {"has_auth":{"type":"noul","instructions":"Does this file check user authentication?"},"kind":{"type":"choice","instructions":"What is this file mainly?","criteria":{"route":"HTTP handler","util":"helpers","other":"None of the above fits"}}}',
      inputSchema: z.object({
        questions_json: z.string().describe('JSON object string of questions keyed by id.'),
        state: z.string().describe('Free-form context (parsed as JSON if valid).'),
        decision: z.string().optional().describe('Known decision type (e.g. shell-safety) for static routing; omit for ad-hoc questions.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ questions_json, state, decision }) => {
      let parsedQ: unknown
      try {
        parsedQ = JSON.parse(questions_json)
      } catch {
        return text('questions_json is not valid JSON', true)
      }
      const q = questionsSchema.safeParse(parsedQ)
      if (!q.success) return text(`invalid questions: ${q.error.issues.map((i) => i.message).join('; ')}`, true)
      let st: unknown = state
      try { st = JSON.parse(state) } catch { /* keep string */ }
      const headers = new Headers({ 'x-deadline-ms': String(DEFAULT_DEADLINE_MS) })
      if (decision) headers.set('x-decision', decision)
      headers.set('x-agent', 'mcp')
      try {
        const out = await runDecision(env, waiter, { model: 'auto', state: st as {} | null, questions: q.data }, parseMeta(headers), deps)
        const { answers, servedBy, routeReason } = out.response
        return text(JSON.stringify({ answers, servedBy, routeReason }, null, 2))
      } catch (err) {
        if (err instanceof DecisionError) return text(`decision failed (${err.status}): ${err.message}`, true)
        throw err
      }
    },
  )

  server.registerTool(
    'budget',
    {
      title: 'Budget',
      description: "Today's free-tier usage by this server: neurons, spend-limit/quota error counts, skip-Clef flag and reset time.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => text(JSON.stringify(await budgetSnapshot(env.DB), null, 2)),
  )

  server.registerTool(
    'stats',
    {
      title: 'Stats',
      description: 'Compact summary of recent traffic: model mix, fallbacks, p50/p90 latency per tier, free-served percentage, shadow disagreement per decision.',
      inputSchema: z.object({ days: z.number().int().min(1).max(90).optional().describe('Window in days (default 1).') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ days }) => {
      const s = await statsSnapshot(env.DB, days ?? 1)
      const lines = [
        `last ${s.days}d: ${s.total} calls (${s.errors} errors), ${s.freePercent}% free-served, ${s.neurons} neurons`,
        'mix: ' + (Object.entries(s.mix).map(([t, m]) => `${t} ${m.count} (${Math.round(m.share * 100)}%)`).join(', ') || 'none'),
        'fallbacks: ' + (Object.entries(s.fallbacks).map(([r, n]) => `${r}=${n}`).join(', ') || 'none'),
        'latency ms p50/p90: ' + (Object.entries(s.latency).map(([t, l]) => `${t} ${l.p50}/${l.p90}`).join(', ') || 'n/a'),
        'shadow disagreement: ' + (Object.entries(s.shadow).map(([d, v]) => `${d} ${(v.disagreementRate * 100).toFixed(1)}% of ${v.pairs}`).join(', ') || 'none'),
      ]
      return text(lines.join('\n'))
    },
  )

  server.registerTool(
    'recent_calls',
    {
      title: 'Recent calls',
      description: 'Recent call metadata (payloads truncated to 200 chars; full payloads are in GET /v1/calls).',
      inputSchema: z.object({
        decision: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional().describe('Max 20 (default 10).'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ decision, limit }) => {
      const r = await listCalls(env.DB, { decision, limit: Math.min(limit ?? 10, 20) })
      const rows = r.calls.map((c) => ({
        ts: new Date(c.ts).toISOString(),
        decision: c.decision,
        servedBy: c.served_by,
        routeReason: c.route_reason,
        fallbackReason: c.fallback_reason,
        status: c.status,
        latencyMs: c.latency_ms,
        neurons: c.neurons,
        state: trunc(JSON.stringify(c.state)),
        questions: trunc(JSON.stringify(c.questions)),
        answers: trunc(JSON.stringify(c.answers)),
      }))
      return text(JSON.stringify(rows, null, 2))
    },
  )

  return server
}

/** Stateless handler (like memory-server). Bearer auth is enforced by Hono before this runs. */
export function handleMcp(env: Env, request: Request, ctx: Waiter, deps?: Deps): Promise<Response> {
  const handler = createMcpHandler(() => createDecisionMcpServer(env, ctx, deps), {
    route: '/mcp',
    corsOptions: false,
    allowedOriginHostnames: '*',
  })
  return handler(request, env, { waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p), passThroughOnException: () => {} } as unknown as ExecutionContext)
}
