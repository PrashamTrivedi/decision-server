import type { Answer, Answers } from './schema'

/**
 * Default jev-harness thresholds per decision (grep `ctx.threshold(` in jev-harness/decisions/*.ts).
 * Keyed by question id; `_` is the fallback for that decision. Comparison is "same side of the threshold".
 */
export const THRESHOLDS: Record<string, Record<string, number>> = {
  'shell-safety': { accidental_destruction: 0.7, exposes_secret: 0.7, rule_is_real: 0.6, _: 0.7 },
  'outbound-leak': { exfil: 0.7, _: 0.7 },
  'loop-detector': { looping: 0.75, _: 0.75 },
  'injection-screen': { injection: 0.85, _: 0.85 },
  'memory-hygiene': { duplicate: 0.8, conflict: 0.8, _: 0.8 },
  'read-budget': { needed: 0.2, _: 0.2 },
  'promise-continue': { promised_undone_work: 0.8, waits_on_user: 0.5, _: 0.8 },
  'semantic-lint': { _: 0.85 },
  'subagent-router': { confidence: 0.85, difficulty: 1.5, _: 0.85 },
  'failure-triage': { confidence: 0.5, _: 0.5 },
  'screenshot-gate': { confidence: 0.8, _: 0.8 },
}

export const FALLBACK_THRESHOLD = 0.5

export function thresholdFor(decision: string | undefined, qid: string): number {
  const t = decision ? THRESHOLDS[decision] : undefined
  return t?.[qid] ?? t?._ ?? FALLBACK_THRESHOLD
}

/** Do two answers lead to the same harness behaviour at the default thresholds? */
export function agreeAt(decision: string | undefined, qid: string, a: Answer, b: Answer): boolean {
  if (a.type !== b.type) return false
  const side = (x: number, t: number) => x >= t
  if (a.type === 'noul' && b.type === 'noul') {
    const t = thresholdFor(decision, qid)
    return side(a.noul, t) === side(b.noul, t)
  }
  if (a.type === 'choice' && b.type === 'choice') {
    if (a.choice !== b.choice) return false
    const t = thresholdFor(decision, 'confidence')
    return side(a.confidence, t) === side(b.confidence, t)
  }
  if (a.type === 'score' && b.type === 'score') {
    const t = decision && THRESHOLDS[decision]?.[qid] !== undefined ? THRESHOLDS[decision][qid] : undefined
    return t !== undefined ? side(a.score, t) === side(b.score, t) : Math.abs(a.score - b.score) <= 0.5
  }
  return false
}

export function compareAnswers(decision: string | undefined, free: Answers, jev: Answers) {
  return Object.keys(free)
    .filter((id) => jev[id])
    .map((id) => ({ questionId: id, free: free[id], jev: jev[id], agree: agreeAt(decision, id, free[id], jev[id]) }))
}
