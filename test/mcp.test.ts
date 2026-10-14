import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { makeCtx } from './d1fake'
import { auth, clefOut, fakeAi, jevFetch, makeEnv, noulQ } from './helpers'

const hdrs = { ...auth, Accept: 'application/json, text/event-stream' }

async function rpc(app: any, env: any, ctx: any, method: string, params: any = {}, headers: any = hdrs) {
  const res = await app.request('http://decisions.test/mcp', { method: 'POST', headers: { ...headers, Host: 'decisions.test' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, env, ctx)
  const raw = await res.text()
  const data = raw.startsWith('event:') || raw.includes('\ndata:') || raw.startsWith('data:') ? raw.split('\n').filter((l: string) => l.startsWith('data:')).map((l: string) => l.slice(5).trim()).pop()! : raw
  return { status: res.status, json: res.status === 200 ? JSON.parse(data) : null }
}

describe('/mcp', () => {
  const { ai } = fakeAi(() => clefOut({ dangerous: { type: 'noul', noul: 0.05 } }, 120))
  const env = makeEnv({ AI: ai })
  const app = createApp({ deps: { fetch: jevFetch() as any } })

  it('401 with missing or wrong bearer (before the handler)', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect((await app.request('/mcp', { method: 'POST', body }, env)).status).toBe(401)
    expect((await app.request('/mcp', { method: 'POST', body, headers: { Authorization: 'Bearer x' } }, env)).status).toBe(401)
    expect((await app.request('/mcp', { method: 'GET' }, env)).status).toBe(401)
  })

  it('lists exactly the 4 tools', async () => {
    const r = await rpc(app, env, makeCtx(), 'tools/list')
    expect(r.json.result.tools.map((t: any) => t.name).sort()).toEqual(['budget', 'decide', 'recent_calls', 'stats'])
  })

  it('decide returns answers, servedBy, routeReason; others work', async () => {
    const ctx = makeCtx()
    const call = (name: string, args: any) => rpc(app, env, ctx, 'tools/call', { name, arguments: args })
    const d = await call('decide', { questions_json: JSON.stringify(noulQ), state: '{"command":"ls"}', decision: 'shell-safety' })
    const out = JSON.parse(d.json.result.content[0].text)
    expect(out.servedBy).toBe('flash')
    expect(out.routeReason).toBe('static:shell-safety')
    expect(out.answers.dangerous.noul).toBe(0.05)
    await ctx.flush()
    const b = await call('budget', {})
    expect(JSON.parse(b.json.result.content[0].text).serverNeurons).toBeGreaterThan(0)
    const s = await call('stats', { days: 1 })
    expect(s.json.result.content[0].text).toContain('1 calls')
    const rc = await call('recent_calls', { decision: 'shell-safety', limit: 5 })
    const rows = JSON.parse(rc.json.result.content[0].text)
    expect(rows).toHaveLength(1)
    expect(rows[0].servedBy).toBe('flash')
  })

  it('decide rejects bad questions_json as a tool error', async () => {
    const r = await rpc(app, env, makeCtx(), 'tools/call', { name: 'decide', arguments: { questions_json: '{', state: 'x' } })
    expect(r.json.result.isError).toBe(true)
  })

  it('recent_calls truncates payloads to 200 chars', async () => {
    const ctx = makeCtx()
    const big = 'x'.repeat(1000)
    await rpc(app, env, ctx, 'tools/call', { name: 'decide', arguments: { questions_json: JSON.stringify(noulQ), state: big, decision: 'shell-safety' } })
    await ctx.flush()
    const rc = await rpc(app, env, ctx, 'tools/call', { name: 'recent_calls', arguments: { decision: 'shell-safety' } })
    const rows = JSON.parse(rc.json.result.content[0].text)
    expect(Math.max(...rows.map((r: any) => r.state.length))).toBeLessThanOrEqual(201)
  })
})
