import type { Context } from 'hono'
import { verifyAccess, type AccessDeps } from './access'
import type { Env } from './env'

type C = Context<{ Bindings: Env }>

const CODE_TTL_MS = 10 * 60_000
const ACCESS_TTL_S = 3600
const REFRESH_TTL_MS = 30 * 86_400_000
const CLIENT_TTL_MS = 90 * 86_400_000
const SCOPE = 'mcp:full'

const baseUrl = (req: Request) => new URL(req.url).origin
const rand = (bytes: number) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function sha256Hex(s: string) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')
}
const pkceChallenge = async (verifier: string) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
const opaque = () => b64url(crypto.getRandomValues(new Uint8Array(32)).buffer)

export function protectedResourceMetadata(base: string) {
  return { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: [SCOPE] }
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  }
}

/** True for an unexpired opaque access token issued by this server (looked up by hash). */
export async function verifyOAuthToken(env: Env, token: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM oauth_tokens WHERE token_hash = ? AND kind = 'access' AND expires_at > ?")
    .bind(await sha256Hex(token), Date.now()).first()
  return !!row
}

function redirectOk(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false
  let u: URL
  try { u = new URL(raw) } catch { return false }
  if (u.hash) return false
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  return !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'ftp:', 'ws:', 'wss:'].includes(u.protocol) // custom app schemes
}

export async function register(c: C) {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid_client_metadata' }, 400) }
  const uris = body?.redirect_uris
  if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every(redirectOk)) {
    return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be 1-5 valid https, loopback http or app-scheme URLs' }, 400)
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
    return c.json({ error: 'invalid_client_metadata', error_description: 'only public clients (token_endpoint_auth_method none)' }, 400)
  }
  const name = (typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : 'MCP Client').slice(0, 100)
  const clientId = `client_${rand(16)}`
  await c.env.DB.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?,?,?,?)')
    .bind(clientId, name, JSON.stringify(uris), Date.now()).run()
  return c.json({ client_id: clientId, client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, 201)
}

async function getClient(env: Env, id: unknown): Promise<{ name: string; uris: string[] } | null> {
  if (typeof id !== 'string' || !id) return null
  const r = await env.DB.prepare('SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id = ?').bind(id).first<{ client_name: string; redirect_uris: string }>()
  return r ? { name: r.client_name, uris: JSON.parse(r.redirect_uris) } : null
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}
const page = (title: string, inner: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 16px}code{word-break:break-all}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style></head><body>${inner}</body></html>`
const errorPage = (c: C, msg: string, status: 400 | 401 | 403) => c.html(page('Authorization error', `<h1>Authorization error</h1><p>${esc(msg)}</p>`), status, PAGE_HEADERS)

interface AuthParams { client_id: string; redirect_uri: string; code_challenge: string; state: string }

/** Validates the authorize request against the registered client. Returns params + client name, or an error message. */
async function checkAuthorize(env: Env, p: Record<string, unknown>): Promise<{ ok: true; p: AuthParams; name: string } | { ok: false; msg: string }> {
  const client = await getClient(env, p.client_id)
  if (!client) return { ok: false, msg: 'Unknown client_id.' }
  // Exact match: an unregistered redirect_uri must never receive a code, so no redirect-based error reporting.
  if (typeof p.redirect_uri !== 'string' || !client.uris.includes(p.redirect_uri)) return { ok: false, msg: 'redirect_uri does not match the registered one.' }
  if (p.response_type !== undefined && p.response_type !== 'code') return { ok: false, msg: 'Only response_type=code is supported.' }
  if (p.code_challenge_method !== 'S256' || typeof p.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) {
    return { ok: false, msg: 'PKCE with code_challenge_method=S256 is required.' }
  }
  return { ok: true, name: client.name, p: { client_id: p.client_id as string, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, state: typeof p.state === 'string' ? p.state : '' } }
}

export async function authorizeForm(c: C, access?: AccessDeps) {
  const id = await verifyAccess(c.env, c.req.raw, access)
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  const r = await checkAuthorize(c.env, { ...c.req.query() })
  if (!r.ok) return errorPage(c, r.msg, 400)
  const hidden = (['client_id', 'redirect_uri', 'code_challenge', 'state'] as const).map((k) => `<input type="hidden" name="${k}" value="${esc(r.p[k])}">`).join('') + '<input type="hidden" name="code_challenge_method" value="S256">'
  return c.html(
    page('Authorize MCP client', `<h1>Authorize access</h1><p><strong>${esc(r.name)}</strong> wants to use the decision server MCP tools as <strong>${esc(id.email)}</strong>.</p><p>It will be redirected to:<br><code>${esc(r.p.redirect_uri)}</code></p><form method="post" action="/oauth/authorize">${hidden}<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form>`),
    200,
    PAGE_HEADERS,
  )
}

export async function authorizeSubmit(c: C, access?: AccessDeps) {
  const id = await verifyAccess(c.env, c.req.raw, access)
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  const origin = c.req.header('origin')
  if (origin && origin !== baseUrl(c.req.raw)) return errorPage(c, 'Cross-origin request refused.', 403)
  const body = (await c.req.parseBody()) as Record<string, unknown>
  const r = await checkAuthorize(c.env, body)
  if (!r.ok) return errorPage(c, r.msg, 400)
  const u = new URL(r.p.redirect_uri)
  if (body.decision !== 'approve') {
    u.searchParams.set('error', 'access_denied')
  } else {
    const code = rand(32)
    await c.env.DB.prepare('INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, email, expires_at) VALUES (?,?,?,?,?,?)')
      .bind(await sha256Hex(code), r.p.client_id, r.p.redirect_uri, r.p.code_challenge, id.email, Date.now() + CODE_TTL_MS).run()
    u.searchParams.set('code', code)
  }
  if (r.p.state) u.searchParams.set('state', r.p.state)
  return c.redirect(u.toString(), 302)
}

const grantErr = (c: C, error: string, description?: string) =>
  c.json({ error, ...(description ? { error_description: description } : {}) }, 400, { 'Cache-Control': 'no-store' })

async function issue(c: C, clientId: string, email: string) {
  const now = Date.now()
  const access = opaque(), refresh = opaque()
  const ins = c.env.DB.prepare('INSERT INTO oauth_tokens (token_hash, kind, client_id, email, expires_at) VALUES (?,?,?,?,?)')
  await ins.bind(await sha256Hex(access), 'access', clientId, email, now + ACCESS_TTL_S * 1000).run()
  await ins.bind(await sha256Hex(refresh), 'refresh', clientId, email, now + REFRESH_TTL_MS).run()
  return c.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE }, 200, { 'Cache-Control': 'no-store' })
}

export async function token(c: C) {
  let p: Record<string, unknown>
  try {
    p = (c.req.header('content-type') ?? '').includes('application/json') ? await c.req.json() : ((await c.req.parseBody()) as Record<string, unknown>)
  } catch {
    return grantErr(c, 'invalid_request')
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const clientId = str(p.client_id)
  const now = Date.now()

  if (p.grant_type === 'authorization_code') {
    const code = str(p.code), verifier = str(p.code_verifier)
    if (!code || !verifier || !clientId) return grantErr(c, 'invalid_request', 'code, code_verifier and client_id are required')
    const hash = await sha256Hex(code)
    const row = await c.env.DB.prepare('SELECT client_id, redirect_uri, code_challenge, email, expires_at FROM oauth_codes WHERE code_hash = ?').bind(hash)
      .first<{ client_id: string; redirect_uri: string; code_challenge: string; email: string; expires_at: number }>()
    if (!row) return grantErr(c, 'invalid_grant', 'invalid or expired code')
    // Single use: whoever deletes the row owns the code, even when the attempt then fails.
    const del = await c.env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').bind(hash).run()
    if (del.meta?.changes !== 1 || row.expires_at < now) return grantErr(c, 'invalid_grant', 'invalid or expired code')
    if (row.client_id !== clientId) return grantErr(c, 'invalid_grant', 'client mismatch')
    if (str(p.redirect_uri) !== row.redirect_uri) return grantErr(c, 'invalid_grant', 'redirect_uri mismatch')
    if ((await pkceChallenge(verifier)) !== row.code_challenge) return grantErr(c, 'invalid_grant', 'PKCE verification failed')
    return issue(c, row.client_id, row.email)
  }

  if (p.grant_type === 'refresh_token') {
    const rt = str(p.refresh_token)
    if (!rt) return grantErr(c, 'invalid_request', 'refresh_token is required')
    const hash = await sha256Hex(rt)
    const row = await c.env.DB.prepare('SELECT client_id, email, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = \'refresh\'').bind(hash)
      .first<{ client_id: string; email: string; expires_at: number }>()
    if (!row) return grantErr(c, 'invalid_grant', 'invalid or expired refresh token')
    const del = await c.env.DB.prepare('DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = \'refresh\'').bind(hash).run()
    if (del.meta?.changes !== 1 || row.expires_at < now) return grantErr(c, 'invalid_grant', 'invalid or expired refresh token')
    if (clientId && clientId !== row.client_id) return grantErr(c, 'invalid_grant', 'client mismatch')
    return issue(c, row.client_id, row.email)
  }

  return grantErr(c, 'unsupported_grant_type')
}

/** Cron: drop expired codes/tokens and clients past their TTL. */
export async function purgeOauth(db: D1Database, now: number) {
  await db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now).run()
  await db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').bind(now).run()
  await db.prepare('DELETE FROM oauth_clients WHERE created_at < ?').bind(now - CLIENT_TTL_MS).run()
}
