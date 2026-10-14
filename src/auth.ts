import type { MiddlewareHandler } from 'hono'
import type { Env } from './env'

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

export const bearerAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!(await isAuthorized(c.req.header('authorization'), c.env.DECISIONS_TOKEN))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}
