import { agreeAt } from '../src/agreement'
import type { Answers } from '../src/schema'

export interface ReplayResult {
  decision: string
  servedBy: string
  ok: boolean
  error?: string
  free?: Answers
  jev: Answers
}

export interface DecisionSummary {
  decision: string
  calls: number
  errors: number
  questions: number
  agree: number
  agreement: number
  /** Calls answered by Jev itself (excluded from agreement: it would compare Jev to Jev). */
  jevServed: number
  servedBy: Record<string, number>
}

/** Per-decision agreement between the server's answers and the logged Jev answers, at harness default thresholds. */
export function summarize(results: ReplayResult[]): { perDecision: DecisionSummary[]; overall: { questions: number; agree: number; agreement: number; errors: number; calls: number; jevServed: number; jevShare: number } } {
  const by = new Map<string, DecisionSummary>()
  for (const r of results) {
    const s = by.get(r.decision) ?? { decision: r.decision, calls: 0, errors: 0, questions: 0, agree: 0, agreement: 0, jevServed: 0, servedBy: {} }
    s.calls++
    if (!r.ok || !r.free) {
      s.errors++
    } else {
      s.servedBy[r.servedBy] = (s.servedBy[r.servedBy] ?? 0) + 1
      if (r.servedBy === 'jev') s.jevServed++
      else for (const [id, jevAns] of Object.entries(r.jev)) {
        const f = r.free[id]
        if (!f) continue
        s.questions++
        if (agreeAt(r.decision, id, f, jevAns)) s.agree++
      }
    }
    by.set(r.decision, s)
  }
  const perDecision = [...by.values()].sort((a, b) => a.decision.localeCompare(b.decision))
  for (const s of perDecision) s.agreement = s.questions ? s.agree / s.questions : 0
  const questions = perDecision.reduce((a, s) => a + s.questions, 0)
  const agree = perDecision.reduce((a, s) => a + s.agree, 0)
  const calls = perDecision.reduce((a, s) => a + s.calls, 0)
  const jevServed = perDecision.reduce((a, s) => a + s.jevServed, 0)
  return {
    perDecision,
    overall: {
      jevServed,
      jevShare: calls ? jevServed / calls : 0,
      questions,
      agree,
      agreement: questions ? agree / questions : 0,
      errors: perDecision.reduce((a, s) => a + s.errors, 0),
      calls,
    },
  }
}

export function formatReport(sum: ReturnType<typeof summarize>, target = 0.95): string {
  const pct = (x: number) => (x * 100).toFixed(1) + '%'
  const lines = ['decision'.padEnd(20) + 'calls  errs  qs     agree   servedBy']
  for (const s of sum.perDecision) {
    const mix = Object.entries(s.servedBy).map(([k, v]) => `${k}:${v}`).join(' ')
    lines.push(s.decision.padEnd(20) + String(s.calls).padEnd(7) + String(s.errors).padEnd(6) + String(s.questions).padEnd(7) + pct(s.agreement).padEnd(8) + mix + (s.agreement < target && s.questions ? '  <-- below target' : ''))
  }
  const o = sum.overall
  lines.push('', `overall: ${o.agree}/${o.questions} questions agree = ${pct(o.agreement)} (target ${pct(target)}), ${o.errors} errors in ${o.calls} calls`, `jev-served (excluded from agreement): ${o.jevServed}/${o.calls} = ${pct(o.jevShare)}`)
  return lines.join('\n')
}
