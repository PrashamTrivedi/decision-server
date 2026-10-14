import { describe, expect, it } from 'vitest'
import { route, needsEscalation, parseRouterAnswer, buildRouterRequest, parseBand } from '../src/router'
import { ROUTE_TABLE } from '../src/routes'
import { emptyMedia, extractMedia } from '../src/media'
import { noulQ } from './helpers'

const base = { media: emptyMedia(), skipClef: false }

describe('route table', () => {
  const expected: Record<string, string> = {
    'shell-safety': 'flash', 'outbound-leak': 'flash', 'loop-detector': 'flash', 'compact-advisor': 'flash',
    'promise-continue': 'flash', 'failure-triage': 'flash',
    'read-budget': 'clef', 'mcp-trim': 'clef', 'memory-hygiene': 'clef', 'injection-screen': 'clef', 'mcp:ask_jev_file': 'clef', 'mcp:ask_jev_files': 'clef', 'mcp:ask_jev': 'clef', 'mcp:pick_first_file': 'flash', 'mcp:command-gate': 'flash', 'screenshot-gate': 'flash', 'deploy-preflight': 'flash+escalate',
    'semantic-lint': 'flash+escalate', 'subagent-router': 'flash+escalate',
  }
  it('covers every row', () => {
    expect(Object.keys(ROUTE_TABLE).sort()).toEqual(Object.keys(expected).sort())
  })
  for (const [decision, want] of Object.entries(expected)) {
    it(`${decision} -> ${want}`, () => {
      const r: any = route({ ...base, decision })
      expect(r.kind).toBe('tier')
      expect(r.tier).toBe(want.split('+')[0])
      expect(!!r.escalate).toBe(want.includes('escalate'))
      expect(r.reason).toBe(`static:${decision}`)
    })
  }
})

describe('router order', () => {
  it('forced model wins over everything', () => {
    const { media } = extractMedia({ a: 'data:image/png;base64,AAAA' })
    for (const [m, tier] of [['flash', 'flash'], ['clef', 'clef'], ['omni', 'omni'], ['jev', 'jev']] as const) {
      expect(route({ model: m, decision: 'read-budget', media, skipClef: true })).toMatchObject({ kind: 'tier', tier, reason: `forced:${tier}` })
    }
  })
  it('media -> omni, before skip flag and table', () => {
    const { media } = extractMedia({ shot: 'data:image/png;base64,AAAA' })
    expect(route({ decision: 'shell-safety', media, skipClef: true })).toMatchObject({ tier: 'omni', reason: 'media' })
  })
  it('too much media -> jev', () => {
    const { media } = extractMedia(Array.from({ length: 5 }, () => 'data:image/png;base64,AAAA'))
    expect(route({ decision: 'x', media, skipClef: false })).toMatchObject({ tier: 'jev', reason: 'media-over-limit' })
  })
  it('skip flag -> jev before table', () => {
    expect(route({ ...base, decision: 'shell-safety', skipClef: true })).toMatchObject({ tier: 'jev', reason: 'skip-clef' })
  })
  it('unknown / missing decision -> router', () => {
    expect(route({ ...base, decision: 'whatever' })).toMatchObject({ kind: 'router' })
    expect(route({ ...base })).toMatchObject({ kind: 'router' })
    expect(route({ ...base, decision: 'constructor' })).toMatchObject({ kind: 'router' })
  })
  it('jev-latest and auto mean route', () => {
    expect(route({ ...base, model: 'jev-latest', decision: 'mcp-trim' })).toMatchObject({ tier: 'clef' })
    expect(route({ ...base, model: 'auto', decision: 'mcp-trim' })).toMatchObject({ tier: 'clef' })
  })
})

describe('escalation', () => {
  it('noul in band / low confidence escalate; confident answers do not', () => {
    expect(needsEscalation({ a: { type: 'noul', noul: 0.5 } })).toBe(true)
    expect(needsEscalation({ a: { type: 'noul', noul: 0.05 } })).toBe(false)
    expect(needsEscalation({ a: { type: 'noul', noul: 0.95 } })).toBe(false)
    expect(needsEscalation({ a: { type: 'choice', choice: 'x', probabilities: {}, confidence: 0.5 } })).toBe(true)
    expect(needsEscalation({ a: { type: 'score', score: 1, probabilities: {}, confidence: 0.9 } })).toBe(false)
    expect(needsEscalation({ a: { type: 'noul', noul: 0.5 } }, { minConfidence: 0.6, bandLow: 0.6, bandHigh: 0.7, minRemainingMs: 0 })).toBe(false)
  })
  it('parseBand', () => {
    expect(parseBand('0.2,0.9')).toEqual({ bandLow: 0.2, bandHigh: 0.9 })
    expect(parseBand('junk')).toBeNull()
  })
})

describe('router question', () => {
  it('builds a single choice question and parses the answer', () => {
    const r = buildRouterRequest('foo', 'hello', noulQ as any)
    expect(Object.keys(r.questions)).toEqual(['tier'])
    expect(r.state).toMatchObject({ decision: 'foo', stateChars: 5, questionKinds: ['noul'] })
    expect(parseRouterAnswer({ tier: { type: 'choice', choice: 'clef', probabilities: {}, confidence: 1 } })).toBe('clef')
    expect(parseRouterAnswer({ tier: { type: 'choice', choice: 'omni', probabilities: {}, confidence: 1 } })).toBeNull()
    expect(parseRouterAnswer({})).toBeNull()
  })
})

describe('media extraction', () => {
  it('extracts data URLs and base64 objects, ignores remote URLs', () => {
    const { state, media } = extractMedia({
      a: 'data:image/png;base64,AAAA', b: ['data:audio/wav;base64,BBBB'], c: { content_type: 'video/mp4', base64: 'CCCC' },
      d: 'https://x/y.png',
    })
    expect(media.images).toHaveLength(1)
    expect(media.audio).toHaveLength(1)
    expect(media.videos).toHaveLength(1)
    expect(JSON.stringify(state)).not.toContain('AAAA')
    expect((state as any).d).toBe('https://x/y.png')
  })
})
