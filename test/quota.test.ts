import { beforeEach, describe, expect, it } from 'vitest'
import { classify, markSkip, nextUtcMidnight, resetSkip, skipState, SPEND_LIMIT_BODY, SPEND_LIMIT_TTL_MS } from '../src/quota'
import { decide } from '../src/decide'
import { clefOut, fakeAi, jevFetch, makeEnv, meta, req } from './helpers'

beforeEach(() => resetSkip())

describe('classify', () => {
  it('exact observed 2041 body, however it is wrapped', () => {
    expect(classify(new Error(SPEND_LIMIT_BODY))).toBe('spend-limit')
    expect(classify(new Error(`AiError: 429 ${SPEND_LIMIT_BODY}`))).toBe('spend-limit')
    expect(classify(Object.assign(new Error('failed'), { body: SPEND_LIMIT_BODY }))).toBe('spend-limit')
    expect(classify(Object.assign(new Error('failed'), { code: 2041 }))).toBe('spend-limit')
    expect(classify(new Error('Spend limit exceeded: rule x'))).toBe('spend-limit')
    expect(classify(SPEND_LIMIT_BODY)).toBe('spend-limit')
  })
  it('4006 by code or text', () => {
    expect(classify(new Error('4006: you have used up your daily free allocation of 10,000 neurons'))).toBe('quota')
    expect(classify(Object.assign(new Error('x'), { code: 4006 }))).toBe('quota')
    expect(classify(new Error('AiError: ... "code":4006 ...'))).toBe('quota')
  })
  it('anything else is other', () => {
    expect(classify(new Error('model overloaded'))).toBe('other')
    expect(classify(new Error('timeout 14006ms'))).toBe('other')
    expect(classify(null)).toBe('other')
  })
})

describe('skip flag TTLs', () => {
  it('2041 -> 15 minutes', () => {
    const now = Date.UTC(2026, 9, 14, 10, 0, 0)
    markSkip('spend-limit', now)
    expect(skipState(now + SPEND_LIMIT_TTL_MS - 1)).toMatchObject({ active: true, kind: 'spend-limit', until: now + 15 * 60_000 })
    expect(skipState(now + SPEND_LIMIT_TTL_MS).active).toBe(false)
  })
  it('4006 -> next 00:00 UTC', () => {
    const now = Date.UTC(2026, 9, 14, 10, 0, 0)
    expect(nextUtcMidnight(now)).toBe(Date.UTC(2026, 9, 15))
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1))
    markSkip('quota', now)
    expect(skipState(Date.UTC(2026, 9, 14, 23, 59, 59)).active).toBe(true)
    expect(skipState(Date.UTC(2026, 9, 15)).active).toBe(false)
  })
  it('a short flag never shortens a long one', () => {
    const now = Date.UTC(2026, 9, 14, 10, 0, 0)
    markSkip('quota', now)
    markSkip('spend-limit', now + 1000)
    expect(skipState(now + 2000).kind).toBe('quota')
  })
})

describe('decide() budget handling', () => {
  const run = (ai: any, f: any, m = meta({ decision: 'shell-safety' })) => decide(makeEnv({ AI: ai }), req(), m, { fetch: f })

  it('2041 -> Jev, flag set 15 min, next call skips Clef without an AI attempt', async () => {
    const { ai, calls } = fakeAi(() => { throw new Error(SPEND_LIMIT_BODY) })
    const f = jevFetch()
    const a = await run(ai, f)
    expect(a.response.servedBy).toBe('jev')
    expect(a.trace.fallbackReason).toBe('spend-limit')
    expect(skipState(Date.now()).kind).toBe('spend-limit')
    const b = await run(ai, f)
    expect(calls).toHaveLength(1)
    expect(b.response.servedBy).toBe('jev')
    expect(b.response.routeReason).toBe('skip-clef')
  })
  it('4006 -> Jev, flag until 00:00 UTC', async () => {
    const { ai } = fakeAi(() => { throw Object.assign(new Error('4006: daily free allocation used up'), { code: 4006 }) })
    const a = await run(ai, jevFetch())
    expect(a.trace.fallbackReason).toBe('quota')
    expect(skipState(Date.now())).toMatchObject({ active: true, kind: 'quota', until: nextUtcMidnight(Date.now()) })
  })
  it('other error -> Jev, no flag', async () => {
    const { ai } = fakeAi(() => { throw new Error('overloaded') })
    const a = await run(ai, jevFetch())
    expect(a.trace.fallbackReason).toBe('error')
    expect(skipState(Date.now()).active).toBe(false)
  })
  it('flag expiry re-enables Clef', async () => {
    markSkip('spend-limit', Date.now() - SPEND_LIMIT_TTL_MS - 1)
    const { ai, calls } = fakeAi(() => clefOut({ dangerous: { type: 'noul', noul: 0.01 } }))
    const a = await run(ai, jevFetch())
    expect(calls).toHaveLength(1)
    expect(a.response.servedBy).toBe('flash')
  })
  it('spend limit during escalation sets the flag but keeps the flash answer', async () => {
    const { ai } = fakeAi((_c, n) => { if (n === 1) return clefOut({ dangerous: { type: 'noul', noul: 0.5 } }); throw new Error(SPEND_LIMIT_BODY) })
    const a = await run(ai, jevFetch(), meta({ decision: 'semantic-lint' }))
    expect(a.response.servedBy).toBe('flash')
    expect(skipState(Date.now()).kind).toBe('spend-limit')
  })
})
