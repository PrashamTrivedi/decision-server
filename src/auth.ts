import type { MiddlewareHandler } from 'hono'
import { verifyAccess, type AccessDeps } from './access'
import type { Env } from './env'
import { verifyOAuthToken } from './oauth'

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/** Constant-time string comparison (compares fixed-length digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

export async function isAuthorized(header: string | null | undefined, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const m = /^Bearer (.+)$/i.exec(header ?? '')
  if (!m) return false
  return safeEqual(m[1], token)
}

/** OAuth + metadata endpoints authenticate themselves (public, or Access-gated in the handler). */
export const isOauthPath = (p: string) => p.startsWith('/oauth/') || p.startsWith('/.well-known/')
const isMcpPath = (p: string) => p === '/mcp' || p.startsWith('/mcp/')

/**
 * One gate for every route: (a) decision key, (b) Cloudflare Access JWT, (c) on /mcp only, an OAuth access token
 * issued by this server. Fails closed.
 */
export function auth(access?: AccessDeps): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (isOauthPath(path)) return next()
    const header = c.req.header('authorization')
    if (await isAuthorized(header, c.env.DECISIONS_TOKEN)) return next()
    if (await verifyAccess(c.env, c.req.raw, access)) return next()
    if (isMcpPath(path)) {
      const m = /^Bearer (.+)$/i.exec(header ?? '')
      if (m && (await verifyOAuthToken(c.env, m[1]))) return next()
      const base = new URL(c.req.url).origin
      return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` })
    }
    return c.json({ error: 'unauthorized' }, 401)
  }
}
