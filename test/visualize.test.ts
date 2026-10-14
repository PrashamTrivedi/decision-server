import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { makeD1 } from './d1fake'
import { auth, makeEnv } from './helpers'

function seed() {
  const db = makeD1()
  const now = Date.now()
  const ins = db.raw.prepare(
    `INSERT INTO calls (id, ts, decision, served_by, route_reason, fallback_reason, latency_ms, status, neurons, state_json, questions_json, answers_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  ins.run('a', now - 3000, 'shell-safety', 'flash', 'static', null, 100, 'ok', 2, '{"command":"SECRET-STATE"}', '{"q":1}', '{"a":1}')
  ins.run('b', now - 2000, 'shell-safety', 'jev', 'static+emergency-paid', 'spend-limit', 900, 'ok', 0, '{}', '{}', '{}')
  ins.run('c', now - 1000, 'read-budget', null, 'static', 'spend-limit+jev-502', 50, 'error', 0, '{}', '{}', null)
  db.raw.prepare("INSERT INTO shadow_pairs (call_id, decision, question_id, free_answer_json, jev_answer_json, agree_at_default) VALUES ('a','shell-safety','q','{}','{}',0)").run()
  return { db, env: makeEnv({ DB: db }), app: createApp() }
}

describe('GET /visualize', () => {
  it('is public HTML with the shell and no data', async () => {
    const s = seed()
    const r = await s.app.request('/visualize', {}, s.env)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    const t = await r.text()
    expect(t).toContain('<title>Decision Server Visualizer</title>')
    expect(t).toContain('/v1/calls')
    expect(t).not.toContain('SECRET-STATE')
    expect(t).not.toContain('test-token')
    expect(t).not.toContain('/*STYLE*/')
    expect(t).not.toContain('/*SCRIPT*/')
    expect(t).not.toMatch(/\.innerHTML\s*=/)
    expect(r.headers.get('content-security-policy')).toContain("connect-src 'self'")
  })
})

describe('visualizer endpoints', () => {
  it('401 without token', async () => {
    const s = seed()
    for (const p of ['/v1/timeline', '/v1/calls/a', '/v1/calls?slim=1&status=error']) {
      expect((await s.app.request(p, {}, s.env)).status).toBe(401)
    }
  })

  it('/v1/timeline buckets served_by counts, ok calls only', async () => {
    const s = seed()
    const j: any = await (await s.app.request('/v1/timeline?days=1', { headers: auth }, s.env)).json()
    expect(j.bucketMs).toBe(3_600_000)
    const tot: Record<string, number> = {}
    for (const b of j.buckets) for (const [k, n] of Object.entries(b.counts)) tot[k] = (tot[k] ?? 0) + (n as number)
    expect(tot).toEqual({ flash: 1, jev: 1 })
  })

  it('/v1/stats includes routeReasons and fallbacks with composite reasons', async () => {
    const s = seed()
    const j: any = await (await s.app.request('/v1/stats?days=1', { headers: auth }, s.env)).json()
    expect(j.fallbacks).toEqual({ 'spend-limit': 1, 'spend-limit+jev-502': 1 })
    expect(j.routeReasons['static+emergency-paid']).toBe(1)
    expect(j.shadow['shell-safety'].disagree).toBe(1)
  })

  it('/v1/calls filters by fallbackReason and status; slim omits payloads', async () => {
    const s = seed()
    const f: any = await (await s.app.request('/v1/calls?fallbackReason=spend-limit%2Bjev-502&slim=1', { headers: auth }, s.env)).json()
    expect(f.calls.map((c: any) => c.id)).toEqual(['c'])
    expect(f.calls[0].state).toBeUndefined()
    const e: any = await (await s.app.request('/v1/calls?status=error', { headers: auth }, s.env)).json()
    expect(e.calls).toHaveLength(1)
    const ok: any = await (await s.app.request('/v1/calls?status=ok', { headers: auth }, s.env)).json()
    expect(ok.calls).toHaveLength(2)
    expect(ok.calls[0].state).toBeDefined()
  })

  it('/v1/calls/:id returns the full payload or 404', async () => {
    const s = seed()
    const j: any = await (await s.app.request('/v1/calls/a', { headers: auth }, s.env)).json()
    expect(j.state).toEqual({ command: 'SECRET-STATE' })
    expect(j.answers).toEqual({ a: 1 })
    expect((await s.app.request('/v1/calls/nope', { headers: auth }, s.env)).status).toBe(404)
  })
})
