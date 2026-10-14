import { skipState } from './quota'
import type { Trace } from './decide'
import type { DecisionMeta, DecisionRequest, Answers } from './schema'
import { compareAnswers } from './agreement'

export interface CallRow {
  id: string
  ts: number
  decision: string | null
  mode: string | null
  agent: string | null
  session: string | null
  router_pick: string | null
  served_by: string | null
  route_reason: string | null
  model: string | null
  input_tokens: number
  neurons: number
  latency_ms: number
  fallback_reason: string | null
  status: 'ok' | 'error'
  error: string | null
  state_json: string | null
  questions_json: string | null
  answers_json: string | null
  replay: number
}

export function buildRow(args: {
  id: string
  now: number
  meta: DecisionMeta
  req: DecisionRequest
  trace: Trace
  answers: Answers | null
  error?: string
}): CallRow {
  const { id, now, meta, req, trace, answers, error } = args
  return {
    id,
    ts: meta.startedAt,
    decision: meta.decision ?? null,
    mode: meta.mode ?? null,
    agent: meta.agent ?? null,
    session: meta.session ?? null,
    router_pick: trace.routerPick ?? null,
    served_by: trace.servedBy ?? null,
    route_reason: trace.routeReason || null,
    model: trace.model ?? null,
    input_tokens: trace.inputTokens,
    neurons: trace.neurons,
    latency_ms: now - meta.startedAt,
    fallback_reason: trace.fallbackReason ?? null,
    status: error ? 'error' : 'ok',
    error: error ?? null,
    state_json: JSON.stringify(req.state ?? null),
    questions_json: JSON.stringify(req.questions),
    answers_json: answers ? JSON.stringify(answers) : null,
    replay: meta.replay ? 1 : 0,
  }
}

const COLS = [
  'id', 'ts', 'decision', 'mode', 'agent', 'session', 'router_pick', 'served_by', 'route_reason', 'model',
  'input_tokens', 'neurons', 'latency_ms', 'fallback_reason', 'status', 'error', 'state_json', 'questions_json',
  'answers_json', 'replay',
] as const

export async function insertCall(db: D1Database, row: CallRow): Promise<void> {
  await db
    .prepare(`INSERT INTO calls (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`)
    .bind(...COLS.map((c) => row[c]))
    .run()
}

export async function insertShadowPairs(db: D1Database, callId: string, decision: string | undefined, free: Answers, jev: Answers): Promise<number> {
  const pairs = compareAnswers(decision, free, jev)
  if (!pairs.length) return 0
  const stmt = db.prepare(
    'INSERT INTO shadow_pairs (call_id, decision, question_id, free_answer_json, jev_answer_json, agree_at_default) VALUES (?,?,?,?,?,?)',
  )
  await db.batch(pairs.map((p) => stmt.bind(callId, decision ?? null, p.questionId, JSON.stringify(p.free), JSON.stringify(p.jev), p.agree ? 1 : 0)))
  return pairs.length
}

const DAY = 86_400_000

export function utcDayStart(now: number): number {
  return Math.floor(now / DAY) * DAY
}

export async function budgetSnapshot(db: D1Database, now = Date.now()) {
  const start = utcDayStart(now)
  const today = await db
    .prepare(
      `SELECT COALESCE(SUM(neurons),0) AS neurons,
              COALESCE(SUM(fallback_reason LIKE '%spend-limit'),0) AS spend,
              COALESCE(SUM(fallback_reason LIKE '%quota'),0) AS quota
         FROM calls WHERE ts >= ?`,
    )
    .bind(start)
    .first<{ neurons: number; spend: number; quota: number }>()
  const last = await db
    .prepare(`SELECT MAX(ts) AS ts FROM calls WHERE (fallback_reason LIKE '%spend-limit' OR fallback_reason LIKE '%quota')`)
    .first<{ ts: number | null }>()
  const skip = skipState(now)
  return {
    day: new Date(start).toISOString().slice(0, 10),
    serverNeurons: Math.round((today?.neurons ?? 0) * 100) / 100,
    freeTier: 10000,
    spendLimitErrors: today?.spend ?? 0,
    quotaErrors: today?.quota ?? 0,
    lastLimitAt: last?.ts ? new Date(last.ts).toISOString() : null,
    skipClef: skip.active ? skip.kind : null,
    skipClefUntil: skip.until ? new Date(skip.until).toISOString() : null,
    resetsAt: new Date(start + DAY).toISOString(),
  }
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export async function statsSnapshot(db: D1Database, days: number, now = Date.now()) {
  const since = now - days * DAY
  const rows = (
    await db
      .prepare(`SELECT served_by, fallback_reason, latency_ms, status, neurons FROM calls WHERE ts >= ? AND replay = 0`)
      .bind(since)
      .all<{ served_by: string | null; fallback_reason: string | null; latency_ms: number; status: string; neurons: number }>()
  ).results
  const ok = rows.filter((r) => r.status === 'ok')
  const mix: Record<string, { count: number; share: number }> = {}
  const lat: Record<string, number[]> = {}
  const fallbacks: Record<string, number> = {}
  for (const r of ok) {
    const t = r.served_by ?? 'unknown'
    ;(mix[t] ??= { count: 0, share: 0 }).count++
    ;(lat[t] ??= []).push(r.latency_ms)
  }
  for (const r of rows) if (r.fallback_reason) fallbacks[r.fallback_reason] = (fallbacks[r.fallback_reason] ?? 0) + 1
  for (const m of Object.values(mix)) m.share = ok.length ? Math.round((m.count / ok.length) * 1000) / 1000 : 0
  const latency = Object.fromEntries(
    Object.entries(lat).map(([t, v]) => {
      const s = [...v].sort((a, b) => a - b)
      return [t, { p50: pct(s, 50), p90: pct(s, 90) }]
    }),
  )
  const free = ok.filter((r) => r.served_by && r.served_by !== 'jev').length
  const shadowRows = (
    await db
      .prepare(
        `SELECT decision, COUNT(*) AS pairs, SUM(CASE WHEN agree_at_default=0 THEN 1 ELSE 0 END) AS disagree
           FROM shadow_pairs WHERE call_id IN (SELECT id FROM calls WHERE ts >= ? AND replay = 0) GROUP BY decision`,
      )
      .bind(since)
      .all<{ decision: string | null; pairs: number; disagree: number }>()
  ).results
  const shadow = Object.fromEntries(
    shadowRows.map((r) => [r.decision ?? 'unknown', { pairs: r.pairs, disagree: r.disagree, disagreementRate: r.pairs ? Math.round((r.disagree / r.pairs) * 1000) / 1000 : 0 }]),
  )
  return {
    days,
    total: rows.length,
    errors: rows.length - ok.length,
    neurons: Math.round(rows.reduce((a, r) => a + r.neurons, 0) * 100) / 100,
    mix,
    fallbacks,
    latency,
    freePercent: ok.length ? Math.round((free / ok.length) * 1000) / 10 : 0,
    shadow,
  }
}

export interface CallFilters {
  decision?: string
  servedBy?: string
  since?: number
  before?: number
  limit?: number
}

export async function listCalls(db: D1Database, f: CallFilters) {
  const where: string[] = []
  const args: unknown[] = []
  if (f.decision) { where.push('decision = ?'); args.push(f.decision) }
  if (f.servedBy) { where.push('served_by = ?'); args.push(f.servedBy) }
  if (f.since) { where.push('ts >= ?'); args.push(f.since) }
  if (f.before) { where.push('ts < ?'); args.push(f.before) }
  const n = Math.floor(Number(f.limit))
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 50
  const rows = (
    await db
      .prepare(`SELECT * FROM calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`)
      .bind(...args, limit)
      .all<CallRow>()
  ).results
  const calls = rows.map((r) => ({
    ...r,
    replay: !!r.replay,
    state: r.state_json ? JSON.parse(r.state_json) : null,
    questions: r.questions_json ? JSON.parse(r.questions_json) : null,
    answers: r.answers_json ? JSON.parse(r.answers_json) : null,
    state_json: undefined,
    questions_json: undefined,
    answers_json: undefined,
  }))
  return { calls, next: rows.length === limit ? rows[rows.length - 1].ts : null }
}

export function parseSince(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return Number(raw)
  const t = Date.parse(raw)
  return Number.isNaN(t) ? undefined : t
}

export async function purge(db: D1Database, now: number, retentionDays: number): Promise<{ calls: number; pairs: number }> {
  const cutoff = now - retentionDays * DAY
  const pairs = await db.prepare('DELETE FROM shadow_pairs WHERE call_id IN (SELECT id FROM calls WHERE ts < ?)').bind(cutoff).run()
  const calls = await db.prepare('DELETE FROM calls WHERE ts < ?').bind(cutoff).run()
  return { calls: calls.meta?.changes ?? 0, pairs: pairs.meta?.changes ?? 0 }
}
