import type { Env } from './env'

const PLACEHOLDER = 'REPLACE_WITH_ACCESS_AUD'
const KEY_TTL_MS = 5 * 60_000
const SKEW_S = 60

/** Test seam: replaces the certs fetch. */
export interface AccessDeps {
  fetch?: typeof fetch
}

export interface AccessIdentity {
  email: string
}

interface KeyCache { at: number; keys: Map<string, CryptoKey> }
const cache = new Map<string, KeyCache>()
export const resetAccessCache = () => cache.clear()

/** Fail closed: with no real audience configured the Access path is off and only the decision key works. */
export function accessEnabled(env: Pick<Env, 'ACCESS_AUD' | 'ACCESS_TEAM_DOMAIN'>): boolean {
  const aud = env.ACCESS_AUD?.trim()
  return !!aud && aud !== PLACEHOLDER && !!env.ACCESS_TEAM_DOMAIN?.trim()
}

function cookie(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

function b64urlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0))
}
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)))

async function loadKeys(team: string, f: typeof fetch): Promise<KeyCache> {
  const res = await f(`https://${team}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`certs ${res.status}`)
  const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] }
  const map = new Map<string, CryptoKey>()
  for (const jwk of keys) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue
    map.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']))
  }
  const entry = { at: Date.now(), keys: map }
  cache.set(team, entry)
  return entry
}

/** Verifies the Cloudflare Access JWT (header, else CF_Authorization cookie), RS256 only. Null on any failure. */
export async function verifyAccess(env: Env, req: Request, deps?: AccessDeps): Promise<AccessIdentity | null> {
  if (!accessEnabled(env)) return null
  const token = req.headers.get('cf-access-jwt-assertion') || cookie(req.headers.get('cookie'), 'CF_Authorization')
  if (!token) return null
  const team = env.ACCESS_TEAM_DOMAIN.trim()
  const f = deps?.fetch ?? fetch
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const header = b64urlJson(parts[0])
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null

    let entry = cache.get(team)
    let fresh = false
    if (!entry || Date.now() - entry.at > KEY_TTL_MS) { entry = await loadKeys(team, f); fresh = true }
    let key = entry.keys.get(header.kid)
    if (!key && !fresh) { entry = await loadKeys(team, f); key = entry.keys.get(header.kid) } // rotation: refetch once
    if (!key) return null

    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    if (!ok) return null

    const p = b64urlJson(parts[1])
    const now = Math.floor(Date.now() / 1000)
    const aud: unknown[] = Array.isArray(p.aud) ? p.aud : [p.aud]
    if (p.iss !== `https://${team}` || !aud.includes(env.ACCESS_AUD.trim())) return null
    if (typeof p.exp !== 'number' || p.exp <= now) return null
    if (p.nbf !== undefined && (typeof p.nbf !== 'number' || p.nbf > now + SKEW_S)) return null
    const email = typeof p.email === 'string' && p.email ? p.email : typeof p.sub === 'string' ? p.sub : ''
    return email ? { email } : null
  } catch {
    return null
  }
}
