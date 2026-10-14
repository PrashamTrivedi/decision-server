import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { auth, jevOk, makeEnv, noulAnswer, noulQ } from './helpers'
import { safeEqual } from '../src/auth'

const body = (extra: object = {}) => JSON.stringify({ model: 'jev-latest', state: { command: 'ls' }, questions: noulQ, ...extra })

describe('spec 01 passthrough (forced jev)', () => {
  it('/health needs the key', async () => {
    expect((await createApp().request('/health', {}, makeEnv())).status).toBe(401)
    const res = await createApp().request('/health', { headers: { Authorization: 'Bearer test-token' } }, makeEnv())
    expect(res.status).toBe(200)
    expect((await res.json() as any).ok).toBe(true)
  })

  it('/ is service info with no data (needs key), /favicon.ico is 204', async () => {
    const app = createApp()
    const h = { headers: { Authorization: 'Bearer test-token' } }
    expect((await app.request('/', {}, makeEnv())).status).toBe(401)
    const res = await app.request('/', h, makeEnv())
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.name).toBe('decision-server')
    expect(JSON.stringify(body)).not.toMatch(/secret|TYPESAFE_API_KEY=|DECISIONS_TOKEN=/i)
    expect((await app.request('/favicon.ico', h, makeEnv())).status).toBe(204)
  })

  it('401 for missing and wrong bearer on /v1/systemone', async () => {
    const app = createApp()
    expect((await app.request('/v1/systemone', { method: 'POST', body: body() }, makeEnv())).status).toBe(401)
    const bad = await app.request('/v1/systemone', { method: 'POST', body: body(), headers: { Authorization: 'Bearer nope' } }, makeEnv())
    expect(bad.status).toBe(401)
  })

  it('safeEqual', async () => {
    expect(await safeEqual('a', 'a')).toBe(true)
    expect(await safeEqual('a', 'b')).toBe(false)
  })

  it('proxies to Jev with jev-latest and tags response', async () => {
    const fetchMock = vi.fn(async () => jevOk(noulAnswer))
    const app = createApp({ deps: { fetch: fetchMock as any } })
    const res = await app.request('/v1/systemone', { method: 'POST', headers: auth, body: body({ model: 'jev' }) }, makeEnv())
    expect(res.status).toBe(200)
    const j: any = await res.json()
    expect(j.answers).toEqual(noulAnswer)
    expect(j.servedBy).toBe('jev')
    expect(j.routeReason).toBe('forced:jev')
    expect(j.neurons).toBe(0)
    expect(j.usage.input_tokens).toBe(10)
    expect(typeof j.ms).toBe('number')
    const [url, init] = fetchMock.mock.calls[0] as any
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(JSON.parse(init.body).model).toBe('jev-latest')
    expect(init.headers.Authorization).toBe('Bearer jev-key')
  })

  it('400 on schema problems and bad JSON', async () => {
    const app = createApp()
    const r1 = await app.request('/v1/systemone', { method: 'POST', headers: auth, body: JSON.stringify({ state: 1, questions: {} }) }, makeEnv())
    expect(r1.status).toBe(400)
    const r2 = await app.request('/v1/systemone', { method: 'POST', headers: auth, body: '{' }, makeEnv())
    expect(r2.status).toBe(400)
    const r3 = await app.request('/v1/systemone', { method: 'POST', headers: auth, body: JSON.stringify({ questions: noulQ }) }, makeEnv())
    expect(r3.status).toBe(400)
  })

  it('502 when Jev fails (HTTP error, bad answers)', async () => {
    const app = createApp({ deps: { fetch: (async () => new Response('boom', { status: 500 })) as any } })
    const res = await app.request('/v1/systemone', { method: 'POST', headers: auth, body: body() }, makeEnv())
    expect(res.status).toBe(502)
    const app2 = createApp({ deps: { fetch: (async () => jevOk({})) as any } })
    expect((await app2.request('/v1/systemone', { method: 'POST', headers: auth, body: body() }, makeEnv())).status).toBe(502)
  })

  it('504 when the deadline expires', async () => {
    const slow = (async (_u: string, init: any) =>
      new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))) as any
    const app = createApp({ deps: { fetch: slow } })
    const res = await app.request('/v1/systemone', { method: 'POST', headers: { ...auth, 'X-Deadline-Ms': '120' }, body: body() }, makeEnv())
    expect(res.status).toBe(504)
  })
})
