import { describe, expect, it } from 'vitest'
import { formatReport, summarize } from '../scripts/replay-lib'

const n = (v: number) => ({ type: 'noul', noul: v }) as const

describe('replay summary', () => {
  it('per-decision agreement at default thresholds, errors counted separately', () => {
    const sum = summarize([
      { decision: 'injection-screen', servedBy: 'clef', ok: true, free: { injection: n(0.9) }, jev: { injection: n(0.95) } },
      { decision: 'injection-screen', servedBy: 'clef', ok: true, free: { injection: n(0.1) }, jev: { injection: n(0.95) } },
      { decision: 'injection-screen', servedBy: 'none', ok: false, jev: { injection: n(0.1) } },
      { decision: 'shell-safety', servedBy: 'flash', ok: true, free: { accidental_destruction: n(0.1), exposes_secret: n(0.1) }, jev: { accidental_destruction: n(0.2), exposes_secret: n(0.1) } },
    ])
    const inj = sum.perDecision.find((d) => d.decision === 'injection-screen')!
    expect(inj).toMatchObject({ calls: 3, errors: 1, questions: 2, agree: 1, agreement: 0.5 })
    expect(sum.overall).toMatchObject({ questions: 4, agree: 3, errors: 1, calls: 4 })
    expect(formatReport(sum)).toContain('below target')
  })
})
