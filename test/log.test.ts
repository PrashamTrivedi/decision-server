import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { agreeAt } from '../src/agreement'
import { purge } from '../src/log'
import { markSkip, resetSkip, SPEND_LIMIT_BODY } from '../src/quota'
import { scheduledPurge } from '../src/sync'
import { makeCtx, makeD1 } from './d1fake'
import { auth, clefOut, fakeAi, jevFetch, makeEnv, noulQ } from './helpers'

beforeEach(() => resetSkip())

const body = JSON.stringify({ model: 'auto', state: { command: 'ls' }, questions: noulQ })
const post = (app: ReturnType<typeof createApp>, env: any, ctx: any, headers: Record<string, string> = {}) =>
  app.request('/v1/systemone', { method: 'POST', headers: { ...auth, ...headers }, body }, env, ctx)
const get = (app: ReturnType<typeof createApp>, env: any, path: string) => app.request(path, { headers: auth }, env)

function setup(opts: { shadow?: 'on' | 'off'; ai?: (c: any, n: number) => unknown; jev?: any } = {}) {
  const db = makeD1()
  const { ai, calls } = fakeAi(opts.ai ?? (() => clefOut({ dangerous: { type: 'noul', noul: 0.9 } }, 300)))
  const fetchMock = opts.jev ?? jevFetch({ dangerous: { type: 'noul', noul: 0.2 } })
  const env = makeEnv({ AI: ai, DB: db, SHADOW: opts.shadow ?? 'off' })
  const app = createApp({ deps: { fetch: fetchMock as any } })
  return { db, env, app, ctx: makeCtx(), calls, fetchMock }
}

describe('call log', () => {
  it('writes one row per call with full payloads, route, model, tokens, neurons, latency', async () => {
    const s = setup()
    const res = await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety', 'X-Mode': 'shadow', 'X-Agent': 'claude-code', 'X-Session': 'abc' })
    expect(res.status).toBe(200)
    await s.ctx.flush()
    const rows = s.db.raw.prepare('SELECT * FROM calls').all() as any[]
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r).toMatchObject({ decision: 'shell-safety', mode: 'shadow', agent: 'claude-code', session: 'abc', served_by: 'flash', status: 'ok', input_tokens: 300, replay: 0, route_reason: 'static:shell-safety' })
    expect(r.neurons).toBeCloseTo((300 * 3455) / 1e6, 5)
    expect(JSON.parse(r.state_json)).toEqual({ command: 'ls' })
    expect(JSON.parse(r.questions_json)).toEqual(noulQ)
    expect(JSON.parse(r.answers_json).dangerous.noul).toBe(0.9)
  })

  it('logs fallback reason, and error rows for total failure (502)', async () => {
    const s = setup({ ai: () => { throw new Error(SPEND_LIMIT_BODY) }, jev: (async () => new Response('x', { status: 500 })) as any })
    const res = await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    expect(res.status).toBe(502)
    await s.ctx.flush()
    const r = s.db.raw.prepare('SELECT * FROM calls').get() as any
    expect(r).toMatchObject({ status: 'error', fallback_reason: 'spend-limit', answers_json: null })
    expect(r.error).toContain('jev HTTP 500')
  })

  it('marks replay calls', async () => {
    const s = setup()
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety', 'X-Replay': '1' })
    await s.ctx.flush()
    expect((s.db.raw.prepare('SELECT replay FROM calls').get() as any).replay).toBe(1)
  })
})

describe('live shadow', () => {
  it('SHADOW=on: free-served call also goes to Jev and pairs are stored', async () => {
    const s = setup({ shadow: 'on' })
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    await s.ctx.flush()
    expect(s.fetchMock).toHaveBeenCalledOnce()
    const p = s.db.raw.prepare('SELECT * FROM shadow_pairs').all() as any[]
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ decision: 'shell-safety', question_id: 'dangerous', agree_at_default: 0 })
    expect(JSON.parse(p[0].free_answer_json).noul).toBe(0.9)
    expect(JSON.parse(p[0].jev_answer_json).noul).toBe(0.2)
  })
  it('skipped when X-Replay is set', async () => {
    const s = setup({ shadow: 'on' })
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety', 'X-Replay': '1' })
    await s.ctx.flush()
    expect(s.fetchMock).not.toHaveBeenCalled()
    expect(s.db.raw.prepare('SELECT COUNT(*) c FROM shadow_pairs').get()).toEqual({ c: 0 })
  })
  it('skipped when SHADOW=off, and when Jev served the call', async () => {
    const off = setup({ shadow: 'off' })
    await post(off.app, off.env, off.ctx, { 'X-Decision': 'shell-safety' })
    await off.ctx.flush()
    expect(off.fetchMock).not.toHaveBeenCalled()
    const jevServed = setup({ shadow: 'on', ai: () => { throw new Error('x') } })
    await post(jevServed.app, jevServed.env, jevServed.ctx, { 'X-Decision': 'shell-safety' })
    await jevServed.ctx.flush()
    expect(jevServed.fetchMock).toHaveBeenCalledOnce() // the fallback itself, no extra shadow call
  })
  it('shadow Jev failure is swallowed', async () => {
    const s = setup({ shadow: 'on', jev: (async () => new Response('x', { status: 500 })) as any })
    const res = await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    expect(res.status).toBe(200)
    await s.ctx.flush()
    expect(s.db.raw.prepare('SELECT COUNT(*) c FROM shadow_pairs').get()).toEqual({ c: 0 })
  })
})

describe('agreement at default thresholds', () => {
  const n = (v: number) => ({ type: 'noul', noul: v }) as const
  it('same side of threshold agrees', () => {
    expect(agreeAt('injection-screen', 'injection', n(0.9), n(0.86))).toBe(true)
    expect(agreeAt('injection-screen', 'injection', n(0.9), n(0.5))).toBe(false)
    expect(agreeAt('read-budget', 'needed', n(0.1), n(0.15))).toBe(true)
    expect(agreeAt('unknown', 'q', n(0.4), n(0.6))).toBe(false)
  })
  it('choice and score', () => {
    const c = (choice: string, confidence: number) => ({ type: 'choice', choice, probabilities: {}, confidence }) as const
    expect(agreeAt('failure-triage', 'kind', c('a', 0.9), c('a', 0.6))).toBe(true)
    expect(agreeAt('failure-triage', 'kind', c('a', 0.9), c('b', 0.9))).toBe(false)
    const sc = (score: number) => ({ type: 'score', score, probabilities: {}, confidence: 1 }) as const
    expect(agreeAt('subagent-router', 'difficulty', sc(1), sc(1.4))).toBe(true)
    expect(agreeAt('subagent-router', 'difficulty', sc(1), sc(2))).toBe(false)
  })
})

describe('REST: budget, stats, calls', () => {
  it('401 without/with wrong bearer on every protected route', async () => {
    const s = setup()
    for (const path of ['/v1/budget', '/v1/stats', '/v1/calls']) {
      expect((await s.app.request(path, {}, s.env)).status).toBe(401)
      expect((await s.app.request(path, { headers: { Authorization: 'Bearer wrong' } }, s.env)).status).toBe(401)
    }
    expect((await s.app.request('/v1/systemone', { method: 'POST', body }, s.env)).status).toBe(401)
  })

  it('/v1/budget reports neurons, limit counts and flag', async () => {
    const s = setup({ ai: (_c, n) => { if (n === 1) return clefOut({ dangerous: { type: 'noul', noul: 0.9 } }, 1000); throw new Error(SPEND_LIMIT_BODY) } })
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    await s.ctx.flush()
    const j: any = await (await get(s.app, s.env, '/v1/budget')).json()
    expect(j.serverNeurons).toBeCloseTo(3.46, 1)
    expect(j.spendLimitErrors).toBe(1)
    expect(j.quotaErrors).toBe(0)
    expect(j.lastLimitAt).not.toBeNull()
    expect(j.skipClef).toBe('spend-limit')
    expect(j.freeTier).toBe(10000)
    expect(j.day).toBe(new Date().toISOString().slice(0, 10))
  })

  it('/v1/stats aggregates mix, fallbacks, latency, free %, shadow; excludes replay', async () => {
    const s = setup({ shadow: 'on' })
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety', 'X-Replay': '1' })
    markSkip('quota', Date.now())
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' }) // skip-clef -> jev
    await s.ctx.flush()
    const j: any = await (await get(s.app, s.env, '/v1/stats?days=1')).json()
    expect(j.total).toBe(3)
    expect(j.mix.flash.count).toBe(2)
    expect(j.mix.jev.count).toBe(1)
    expect(j.freePercent).toBeCloseTo(66.7, 1)
    expect(j.latency.flash.p50).toBeGreaterThanOrEqual(0)
    expect(j.shadow['shell-safety']).toMatchObject({ pairs: 2, disagree: 2, disagreementRate: 1 })
  })

  it('/v1/calls filters, pages and returns full payloads', async () => {
    const s = setup()
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'read-budget' })
    await s.ctx.flush()
    const all: any = await (await get(s.app, s.env, '/v1/calls')).json()
    expect(all.calls).toHaveLength(2)
    expect(all.calls[0].state).toEqual({ command: 'ls' })
    const f: any = await (await get(s.app, s.env, '/v1/calls?decision=read-budget&servedBy=clef')).json()
    expect(f.calls).toHaveLength(1)
    const lim: any = await (await get(s.app, s.env, '/v1/calls?limit=1')).json()
    expect(lim.calls).toHaveLength(1)
    expect(lim.next).not.toBeNull()
    const none: any = await (await get(s.app, s.env, '/v1/calls?since=' + (Date.now() + 100000))).json()
    expect(none.calls).toHaveLength(0)
  })
})

describe('retention purge', () => {
  it('deletes calls and their shadow pairs older than RETENTION_DAYS', async () => {
    const s = setup({ shadow: 'on' })
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    await s.ctx.flush()
    const old = Date.now() - 31 * 86_400_000
    s.db.raw.prepare("UPDATE calls SET ts = ?").run(old)
    await post(s.app, s.env, s.ctx, { 'X-Decision': 'shell-safety' })
    await s.ctx.flush()
    expect(s.db.raw.prepare('SELECT COUNT(*) c FROM calls').get()).toEqual({ c: 2 })
    const r = await scheduledPurge(s.env)
    expect(r).toEqual({ calls: 1, pairs: 1 })
    expect(s.db.raw.prepare('SELECT COUNT(*) c FROM calls').get()).toEqual({ c: 1 })
    expect(s.db.raw.prepare('SELECT COUNT(*) c FROM shadow_pairs').get()).toEqual({ c: 1 })
    expect(await purge(s.env.DB, Date.now(), 30)).toEqual({ calls: 0, pairs: 0 })
  })
})

describe('review pass 1 fixes', () => {
  const mediaBody = JSON.stringify({ model: 'auto', state: { command: 'ls' }, questions: noulQ, images: ['data:image/png;base64,AAAA'], extra: 1 })

  it('Jev fallback forwards the original body (state, media, extra fields), model forced', async () => {
    const s = setup({ ai: () => { throw new Error('x') } })
    await s.app.request('/v1/systemone', { method: 'POST', headers: { ...auth, 'X-Decision': 'shell-safety' }, body: mediaBody }, s.env, s.ctx as any)
    const sent = JSON.parse((s.fetchMock.mock.calls[0] as any)[1].body)
    expect(sent).toMatchObject({ model: 'jev-latest', state: { command: 'ls' }, images: ['data:image/png;base64,AAAA'], extra: 1 })
  })

  it('never shadows a call with media', async () => {
    const s = setup({ shadow: 'on', ai: () => clefOut({ dangerous: { type: 'noul', noul: 0.9 } }, 300, 'clef-omni') })
    const res = await s.app.request('/v1/systemone', { method: 'POST', headers: auth, body: mediaBody }, s.env, s.ctx as any)
    expect(res.status).toBe(200)
    await s.ctx.flush()
    expect(s.fetchMock).not.toHaveBeenCalled()
  })

  it('non-DecisionError is logged and returns generic 500', async () => {
    const s = setup()
    s.env.AI = { run: async () => { throw new Error('secret boom') } } as any
    const app = createApp({ deps: { fetch: (() => { throw new TypeError('secret boom') }) as any } })
    const res = await app.request('/v1/systemone', { method: 'POST', headers: { ...auth, 'X-Decision': 'shell-safety' }, body }, s.env, s.ctx as any)
    expect(res.status).toBe(502)
    await s.ctx.flush()
    expect(s.db.raw.prepare('SELECT COUNT(*) c FROM calls').get()).toEqual({ c: 1 })
  })

  it('onError hides the message', async () => {
    const s = setup()
    s.env.DB = { prepare: () => { throw new Error('secret db') } } as any
    const res = await s.app.request('/v1/budget', { headers: auth }, s.env)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
  })

  it('budget counters match prefixed reasons', async () => {
    const s = setup()
    const ins = s.db.raw.prepare('INSERT INTO calls (id, ts, status, fallback_reason, neurons, latency_ms, replay) VALUES (?,?,?,?,?,?,?)')
    const ts = Date.now()
    ins.run('a', ts, 'ok', 'router-spend-limit', 0, 1, 0)
    ins.run('b', ts, 'ok', 'escalation-quota', 0, 1, 0)
    const b: any = await (await get(s.app, s.env, '/v1/budget')).json()
    expect(b).toMatchObject({ spendLimitErrors: 1, quotaErrors: 1 })
  })

  it('limit/days garbage falls back to defaults', async () => {
    const s = setup()
    expect((await get(s.app, s.env, '/v1/calls?limit=abc')).status).toBe(200)
    expect(((await (await get(s.app, s.env, '/v1/stats?days=abc')).json()) as any).days).toBe(1)
    expect(((await (await get(s.app, s.env, '/v1/stats?days=2.7')).json()) as any).days).toBe(2)
  })
})
