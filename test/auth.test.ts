import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { auth, makeEnv } from './helpers'

const TEAM = 'team.test'
const AUD = 'aud-123'
const enc = new TextEncoder()
const b64 = (b: ArrayBuffer | Uint8Array | string) => {
  const u = typeof b === 'string' ? enc.encode(b) : new Uint8Array(b)
  return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const rsa = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' } as const

let pair: CryptoKeyPair
type Jwk = JsonWebKey & { kid?: string }
let jwk: Jwk
beforeAll(async () => {
  pair = (await crypto.subtle.generateKey(rsa, true, ['sign', 'verify'])) as CryptoKeyPair
  jwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' }
})

async function sign(over: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  const h = b64(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header }))
  const p = b64(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: 'me@example.com', iat: now, exp: now + 300, ...over }))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(`${h}.${p}`))
  return `${h}.${p}.${b64(sig)}`
}

function setup(envOver: Record<string, unknown> = {}, keys: () => Jwk[] = () => [jwk]) {
  const certs = vi.fn(async () => new Response(JSON.stringify({ keys: keys() }), { status: 200 }))
  const app = createApp({ access: { fetch: certs as any } })
  const env = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...envOver } as any)
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, env)
  return { app, env, certs, get }
}
const jwtH = (t: string) => ({ 'Cf-Access-Jwt-Assertion': t })

describe('decision key', () => {
  it('works on every route; no credentials is 401', async () => {
    const s = setup()
    for (const p of ['/', '/health', '/visualize', '/v1/budget', '/v1/stats', '/v1/timeline', '/v1/calls']) {
      expect((await s.get(p)).status, p).toBe(401)
      expect((await s.get(p, auth)).status, p).toBe(200)
    }
    expect((await s.get('/favicon.ico')).status).toBe(401)
    expect((await s.get('/favicon.ico', auth)).status).toBe(204)
  })
})

describe('Access JWT', () => {
  it('works on /, /health, /visualize, /v1/* via header and via cookie', async () => {
    const s = setup()
    const t = await sign()
    for (const p of ['/', '/health', '/visualize', '/v1/budget', '/v1/calls']) expect((await s.get(p, jwtH(t))).status, p).toBe(200)
    expect((await s.get('/v1/budget', { Cookie: `a=b; CF_Authorization=${t}` })).status).toBe(200)
    expect(s.certs).toHaveBeenCalledTimes(1) // keys cached
  })

  it('rejects wrong aud, wrong iss, expired, future nbf', async () => {
    const s = setup()
    const now = Math.floor(Date.now() / 1000)
    for (const over of [{ aud: ['other'] }, { iss: 'https://evil.test' }, { exp: now - 10 }, { nbf: now + 600 }]) {
      expect((await s.get('/v1/budget', jwtH(await sign(over)))).status, JSON.stringify(over)).toBe(401)
    }
    expect((await s.get('/v1/budget', jwtH(await sign({ aud: AUD })))).status).toBe(200) // string aud
    expect((await s.get('/v1/budget', jwtH(await sign({ nbf: now + 30 })))).status).toBe(200) // within skew
  })

  it('rejects tampered payload, alg none, alg HS256, bad shape', async () => {
    const s = setup()
    const [h, p, sig] = (await sign()).split('.')
    const evil = b64(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: 'x@y.z', exp: 9999999999 }))
    expect((await s.get('/v1/budget', jwtH(`${h}.${evil}.${sig}`))).status).toBe(401)
    const none = `${b64(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${p}.`
    expect((await s.get('/v1/budget', jwtH(none))).status).toBe(401)
    expect((await s.get('/v1/budget', jwtH(await sign({}, { alg: 'HS256' })))).status).toBe(401)
    expect((await s.get('/v1/budget', jwtH('garbage'))).status).toBe(401)
  })

  it('refetches exactly once for an unknown kid, then picks up the rotated key', async () => {
    let rotated = false
    const s = setup({}, () => (rotated ? [jwk, { ...jwk, kid: 'k2' }] : [jwk]))
    expect((await s.get('/v1/budget', jwtH(await sign()))).status).toBe(200)
    expect(s.certs).toHaveBeenCalledTimes(1)
    expect((await s.get('/v1/budget', jwtH(await sign({}, { kid: 'nope' })))).status).toBe(401)
    expect(s.certs).toHaveBeenCalledTimes(2) // one refetch
    rotated = true
    expect((await s.get('/v1/budget', jwtH(await sign({}, { kid: 'k2' })))).status).toBe(200)
    expect(s.certs).toHaveBeenCalledTimes(3)
  })

  it('placeholder or empty ACCESS_AUD disables the JWT path (key still works)', async () => {
    for (const aud of ['REPLACE_WITH_ACCESS_AUD', '']) {
      const s = setup({ ACCESS_AUD: aud })
      expect((await s.get('/v1/budget', jwtH(await sign({ aud: [aud] })))).status).toBe(401)
      expect(s.certs).not.toHaveBeenCalled()
      expect((await s.get('/v1/budget', auth)).status).toBe(200)
    }
  })

  it('401 when certs cannot be fetched', async () => {
    const app = createApp({ access: { fetch: (async () => new Response('no', { status: 500 })) as any } })
    const env = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as any)
    expect((await app.request('/v1/budget', { headers: jwtH(await sign()) }, env)).status).toBe(401)
  })
})

// ---- OAuth ----
const verifier = 'v'.repeat(64)
const challenge = async (v: string) => b64(await crypto.subtle.digest('SHA-256', enc.encode(v)))
const REDIRECT = 'http://localhost:8123/callback'
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() })

async function registerClient(s: ReturnType<typeof setup>) {
  const r = await s.app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test <b>Client</b>', redirect_uris: [REDIRECT] }) }, s.env)
  expect(r.status).toBe(201)
  return ((await r.json()) as any).client_id as string
}
async function authorize(s: ReturnType<typeof setup>, clientId: string, over: Record<string, string> = {}, jwt?: string) {
  const body = { client_id: clientId, redirect_uri: REDIRECT, code_challenge: await challenge(verifier), code_challenge_method: 'S256', state: 'st', decision: 'approve', ...over }
  return s.app.request('/oauth/authorize', { ...form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', ...jwtH(jwt ?? (await sign())) } }, s.env)
}
async function getCode(s: ReturnType<typeof setup>, clientId: string) {
  const r = await authorize(s, clientId)
  expect(r.status).toBe(302)
  const loc = new URL(r.headers.get('location')!)
  expect(loc.origin + loc.pathname).toBe(REDIRECT)
  expect(loc.searchParams.get('state')).toBe('st')
  return loc.searchParams.get('code')!
}
const tokenReq = (s: ReturnType<typeof setup>, o: Record<string, string>) => s.app.request('/oauth/token', form(o), s.env)
const mcp = (s: ReturnType<typeof setup>, bearer?: string) =>
  s.app.request('http://decisions.test/mcp', { method: 'POST', headers: { Host: 'decisions.test', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, s.env)

describe('OAuth', () => {
  it('metadata is public and /mcp 401 advertises it', async () => {
    const s = setup()
    const pr: any = await (await s.get('/.well-known/oauth-protected-resource')).json()
    expect(pr.resource).toBe('http://localhost/mcp')
    const as: any = await (await s.get('/.well-known/oauth-authorization-server')).json()
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
    const r = await mcp(s)
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toBe('Bearer resource_metadata="http://decisions.test/.well-known/oauth-protected-resource"')
  })

  it('authorize requires an Access JWT (key is not enough)', async () => {
    const s = setup()
    const id = await registerClient(s)
    const q = `/oauth/authorize?client_id=${id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge_method=S256&code_challenge=${await challenge(verifier)}`
    expect((await s.get(q)).status).toBe(401)
    expect((await s.get(q, auth)).status).toBe(401)
    const r = await s.get(q, jwtH(await sign()))
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('Test &lt;b&gt;Client&lt;/b&gt;')
    expect(html).toContain('me@example.com')
    expect(html).toContain(REDIRECT)
    expect((await s.app.request('/oauth/authorize', form({ client_id: id }), s.env)).status).toBe(401)
  })

  it('authorize rejects unregistered redirect_uri and missing PKCE', async () => {
    const s = setup()
    const id = await registerClient(s)
    expect((await authorize(s, id, { redirect_uri: 'http://localhost:8123/other' })).status).toBe(400)
    expect((await authorize(s, id, { code_challenge: '' })).status).toBe(400)
    expect((await authorize(s, 'client_nope')).status).toBe(400)
  })

  it('full flow: register -> authorize -> token -> /mcp; token is MCP-only', async () => {
    const s = setup()
    const id = await registerClient(s)
    const code = await getCode(s, id)
    const r = await tokenReq(s, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: id, redirect_uri: REDIRECT })
    expect(r.status).toBe(200)
    const t: any = await r.json()
    expect(t.token_type).toBe('Bearer')
    expect(t.expires_in).toBe(3600)
    expect((await mcp(s, t.access_token)).status).toBe(200)
    expect((await s.get('/v1/budget', { Authorization: `Bearer ${t.access_token}` })).status).toBe(401)
    expect((await s.get('/health', { Authorization: `Bearer ${t.access_token}` })).status).toBe(401)
    expect((await mcp(s, 'unknown-token')).status).toBe(401)
    // stored hashed
    const rows = (s.env.DB as any).raw.prepare('SELECT token_hash FROM oauth_tokens').all()
    expect(rows.every((x: any) => x.token_hash !== t.access_token && x.token_hash !== t.refresh_token)).toBe(true)
  })

  it('wrong verifier, reused code, mismatched redirect_uri, expired code -> 400', async () => {
    const s = setup()
    const id = await registerClient(s)
    const base = { grant_type: 'authorization_code', code_verifier: verifier, client_id: id, redirect_uri: REDIRECT }
    expect((await tokenReq(s, { ...base, code: await getCode(s, id), code_verifier: 'w'.repeat(64) })).status).toBe(400)
    const code = await getCode(s, id)
    expect((await tokenReq(s, { ...base, code })).status).toBe(200)
    expect((await tokenReq(s, { ...base, code })).status).toBe(400)
    expect((await tokenReq(s, { ...base, code: await getCode(s, id), redirect_uri: 'http://localhost:8123/x' })).status).toBe(400)
    const old = await getCode(s, id)
    ;(s.env.DB as any).raw.prepare('UPDATE oauth_codes SET expires_at = 1').run()
    expect((await tokenReq(s, { ...base, code: old })).status).toBe(400)
    expect((await tokenReq(s, { grant_type: 'password' })).status).toBe(400)
  })

  it('expired access token rejected; refresh rotates and invalidates the old refresh token', async () => {
    const s = setup()
    const id = await registerClient(s)
    const code = await getCode(s, id)
    const t1: any = await (await tokenReq(s, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: id, redirect_uri: REDIRECT })).json()
    const r2 = await tokenReq(s, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: id })
    expect(r2.status).toBe(200)
    const t2: any = await r2.json()
    expect(t2.refresh_token).not.toBe(t1.refresh_token)
    expect((await tokenReq(s, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: id })).status).toBe(400)
    expect((await mcp(s, t2.access_token)).status).toBe(200)
    expect((await tokenReq(s, { grant_type: 'refresh_token', refresh_token: t2.access_token })).status).toBe(400) // access token is not a refresh token
    ;(s.env.DB as any).raw.prepare('UPDATE oauth_tokens SET expires_at = 1').run()
    expect((await mcp(s, t2.access_token)).status).toBe(401)
    expect((await tokenReq(s, { grant_type: 'refresh_token', refresh_token: t2.refresh_token })).status).toBe(400)
  })

  it('register validates redirect_uris; cron purge drops expired rows', async () => {
    const s = setup()
    for (const uris of [[], ['javascript:alert(1)'], ['http://evil.test/cb'], 'x']) {
      const r = await s.app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: uris }) }, s.env)
      expect(r.status).toBe(400)
    }
    const { scheduledPurge } = await import('../src/sync')
    const db = (s.env.DB as any).raw
    db.prepare("INSERT INTO oauth_codes VALUES ('h','c','r','ch','e',1)").run()
    db.prepare("INSERT INTO oauth_tokens VALUES ('t','access','c','e',1)").run()
    await scheduledPurge(s.env)
    expect(db.prepare('SELECT count(*) n FROM oauth_codes').get().n).toBe(0)
    expect(db.prepare('SELECT count(*) n FROM oauth_tokens').get().n).toBe(0)
  })
})
