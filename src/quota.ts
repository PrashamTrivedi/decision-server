/**
 * Budget signals. No counter: the AI Gateway spend limit (code 2041) and the Workers AI free quota (4006)
 * are the signals, and either one flips a per-isolate "skip Clef" flag.
 */
export type ErrorClass = 'spend-limit' | 'quota' | 'other'

export const SPEND_LIMIT_TTL_MS = 15 * 60_000

/** Exact body observed from AI Gateway (via pi's sessions). Used verbatim in tests. */
export const SPEND_LIMIT_BODY =
  `[{"code":2041,"message":"Spend limit exceeded: rule '46106275' (cost limit 0.2 per 86400s, sliding) for workers-ai @cf/zai-org/glm-5.2"}]`

function textOf(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  const e = err as any
  const parts: string[] = []
  for (const v of [e.message, e.body, e.response, e.error, e.cause?.message]) {
    if (typeof v === 'string') parts.push(v)
    else if (v && typeof v === 'object') {
      try { parts.push(JSON.stringify(v)) } catch { /* ignore */ }
    }
  }
  if (e.code != null) parts.push(`code:${e.code}`)
  if (e.status != null) parts.push(`status:${e.status}`)
  return parts.join(' ')
}

/**
 * How the binding surfaces these is not documented. Assumption: a thrown Error whose message contains the
 * gateway/Workers AI error text (e.g. `AiError: ... [{"code":2041,...}]`), possibly with a `.code`/`.status`.
 * So match on both the numeric code and the human text.
 */
export function classify(err: unknown): ErrorClass {
  const t = textOf(err)
  if (/(["']?code["']?\s*[:=]\s*2041\b)|\b2041\b|spend limit exceeded/i.test(t)) return 'spend-limit'
  if (/(["']?code["']?\s*[:=]\s*4006\b)|\b4006\b|daily free allocation|used up your daily free/i.test(t)) return 'quota'
  return 'other'
}

/** Next 00:00 UTC strictly after `now` (epoch ms). */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

export interface SkipState {
  active: boolean
  kind: 'spend-limit' | 'quota' | null
  until: number | null
}

let flag: { kind: 'spend-limit' | 'quota'; until: number } | null = null

/** Per-isolate flag. A longer-lived flag is never shortened by a later, shorter one. */
export function markSkip(kind: 'spend-limit' | 'quota', now: number): number {
  const until = kind === 'quota' ? nextUtcMidnight(now) : now + SPEND_LIMIT_TTL_MS
  if (!flag || flag.until <= now || until > flag.until) flag = { kind, until }
  return flag.until
}

export function skipState(now: number): SkipState {
  if (flag && flag.until > now) return { active: true, kind: flag.kind, until: flag.until }
  flag = null
  return { active: false, kind: null, until: null }
}

export function resetSkip(): void {
  flag = null
}
