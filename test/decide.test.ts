import { describe, expect, it, vi } from 'vitest'
import { decide, traceOf } from '../src/decide'
import { DecisionError } from '../src/errors'
import { ROUTE_TABLE } from '../src/routes'
import { clefOut, fakeAi, jevFetch, jevOk, makeEnv, meta, noulAnswer, req } from './helpers'

const confident = { dangerous: { type: 'noul', noul: 0.05 } }
const ambiguous = { dangerous: { type: 'noul', noul: 0.5 } }
const run = (ai: any, fetch: any, r: any, m = meta(), env = {}) => decide(makeEnv({ AI: ai, ...env }), r, m, { fetch })

describe('static route table -> Clef model', () => {
  const modelFor = { flash: '@cf/cloudflare/clef-flash', clef: '@cf/cloudflare/clef' } as const
  for (const [decision, target] of Object.entries(ROUTE_TABLE)) {
    it(`${decision}`, async () => {
      const { ai, calls } = fakeAi(() => clefOut(confident, 200))
      const f = jevFetch()
      const { response } = await run(ai, f, req(), meta({ decision }))
      const tier = target === 'either' ? 'flash' : target
      expect(response.servedBy).toBe(tier)
      expect(response.routeReason).toBe(`static:${decision}`)
      expect(calls).toHaveLength(1)
      expect(calls[0].model).toBe(modelFor[tier])
      expect(calls[0].options).toEqual({ gateway: { id: 'default' } })
      expect(calls[0].input.model).toBe(tier === 'flash' ? 'clef-flash' : 'clef')
      expect(response.usage.input_tokens).toBe(200)
      expect(response.neurons).toBeGreaterThan(0)
      expect(f).not.toHaveBeenCalled()
    })
  }
})

describe('either escalation', () => {
  it('ambiguous flash answer escalates to clef', async () => {
    const { ai, calls } = fakeAi((_c, n) => (n === 1 ? clefOut(ambiguous, 100) : clefOut(confident, 100, 'clef')))
    const { response } = await run(ai, jevFetch(), req(), meta({ decision: 'semantic-lint' }))
    expect(calls.map((c) => c.model)).toEqual(['@cf/cloudflare/clef-flash', '@cf/cloudflare/clef'])
    expect(response.servedBy).toBe('clef')
    expect(response.routeReason).toBe('static:semantic-lint+escalated')
    expect(response.answers).toEqual(confident)
    expect(response.neurons).toBeCloseTo((100 * 3455 + 100 * 21818) / 1e6, 4)
  })
  it('confident flash answer does not escalate', async () => {
    const { ai, calls } = fakeAi(() => clefOut(confident))
    const { response } = await run(ai, jevFetch(), req(), meta({ decision: 'subagent-router' }))
    expect(calls).toHaveLength(1)
    expect(response.servedBy).toBe('flash')
  })
  it('no escalation with under 1500ms left', async () => {
    const { ai, calls } = fakeAi(() => clefOut(ambiguous))
    // Frozen clock: 1450ms leaves exactly MIN_CLEF_MS for flash, and too little to escalate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const { response } = await run(ai, jevFetch(), req(), meta({ decision: 'semantic-lint' }, 1450))
      expect(calls).toHaveLength(1)
      expect(response.servedBy).toBe('flash')
    } finally {
      vi.useRealTimers()
    }
  })
  it('failed escalation keeps the valid flash answer', async () => {
    const { ai } = fakeAi((_c, n) => { if (n === 1) return clefOut(ambiguous); throw new Error('boom') })
    const { response, trace } = await run(ai, jevFetch(), req(), meta({ decision: 'semantic-lint' }))
    expect(response.servedBy).toBe('flash')
    expect(response.routeReason).toContain('escalation-failed')
    expect(trace.fallbackReason).toBe('escalation-error')
  })
})

describe('unknown decision -> flash router', () => {
  const routerOut = (choice: string) => ({ tier: { type: 'choice', choice, probabilities: {}, confidence: 0.9 } })
  it('router picks clef, then clef answers', async () => {
    const { ai, calls } = fakeAi((c) => (c.input.questions.tier ? clefOut(routerOut('clef'), 150) : clefOut(confident, 100, 'clef')))
    const { response, trace } = await run(ai, jevFetch(), req(), meta({ decision: 'brand-new' }))
    expect(calls.map((c) => c.model)).toEqual(['@cf/cloudflare/clef-flash', '@cf/cloudflare/clef'])
    expect(response.servedBy).toBe('clef')
    expect(response.routeReason).toBe('router:clef')
    expect(trace.routerPick).toBe('clef')
    expect(response.neurons).toBeGreaterThan(0)
  })
  it('missing decision header also goes through the router (flash)', async () => {
    const { ai } = fakeAi((c) => (c.input.questions.tier ? clefOut(routerOut('flash')) : clefOut(confident)))
    const { response } = await run(ai, jevFetch(), req(), meta())
    expect(response.servedBy).toBe('flash')
  })
  it('router picks jev -> Jev serves, no fallback reason', async () => {
    const { ai } = fakeAi(() => clefOut(routerOut('jev')))
    const f = jevFetch()
    const { response, trace } = await run(ai, f, req(), meta({ decision: 'brand-new' }))
    expect(response.servedBy).toBe('jev')
    expect(trace.routerPick).toBe('jev')
    expect(trace.fallbackReason).toBeUndefined()
    expect(f).toHaveBeenCalledOnce()
  })
  it('router failure -> Jev', async () => {
    const { ai } = fakeAi(() => { throw new Error('nope') })
    const { response, trace } = await run(ai, jevFetch(), req(), meta({ decision: 'brand-new' }))
    expect(response.servedBy).toBe('jev')
    expect(trace.fallbackReason).toBe('router-error')
  })
  it('router returns garbage tier -> Jev', async () => {
    const { ai } = fakeAi(() => clefOut(routerOut('banana')))
    const { trace } = await run(ai, jevFetch(), req(), meta({ decision: 'brand-new' }))
    expect(trace.fallbackReason).toBe('router-incomplete')
  })
})

describe('forced models and media', () => {
  for (const [model, id] of [['flash', '@cf/cloudflare/clef-flash'], ['clef', '@cf/cloudflare/clef'], ['omni', '@cf/cloudflare/clef-omni']] as const) {
    it(`forced ${model}`, async () => {
      const { ai, calls } = fakeAi(() => clefOut(confident))
      const { response } = await run(ai, jevFetch(), req({ model }), meta({ decision: 'read-budget' }))
      expect(calls[0].model).toBe(id)
      expect(response.servedBy).toBe(model)
      expect(response.routeReason).toBe(`forced:${model}`)
    })
  }
  it('forced jev sends jev-latest to Jev and no AI call', async () => {
    const { ai, calls } = fakeAi(() => clefOut(confident))
    const f = jevFetch()
    const { response } = await run(ai, f, req({ model: 'jev' }), meta({ decision: 'shell-safety' }))
    expect(calls).toHaveLength(0)
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).model).toBe('jev-latest')
    expect(response.servedBy).toBe('jev')
  })
  it('image/audio/video in state -> omni with media arrays outside state', async () => {
    const { ai, calls } = fakeAi(() => clefOut(confident))
    const r = req({ state: { shot: 'data:image/png;base64,AAAA', clip: 'data:audio/wav;base64,BBBB', v: 'data:video/mp4;base64,CCCC' } })
    const { response } = await run(ai, jevFetch(), r, meta({ decision: 'shell-safety' }))
    expect(response.servedBy).toBe('omni')
    expect(calls[0].model).toBe('@cf/cloudflare/clef-omni')
    expect(calls[0].input.images).toEqual(['data:image/png;base64,AAAA'])
    expect(calls[0].input.audio).toHaveLength(1)
    expect(calls[0].input.videos).toHaveLength(1)
    expect(JSON.stringify(calls[0].input.state)).not.toContain('AAAA')
  })
  it('omni failure falls back to Jev with the original state', async () => {
    const { ai } = fakeAi(() => { throw new Error('x') })
    const f = jevFetch()
    const r = req({ state: { shot: 'data:image/png;base64,AAAA' } })
    const { response } = await run(ai, f, r, meta())
    expect(response.servedBy).toBe('jev')
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).state.shot).toBe('data:image/png;base64,AAAA')
  })
})

describe('fallback branches', () => {
  it('clef error -> Jev', async () => {
    const { ai } = fakeAi(() => { throw new Error('model exploded') })
    const { response, trace } = await run(ai, jevFetch(), req(), meta({ decision: 'shell-safety' }))
    expect(response.servedBy).toBe('jev')
    expect(trace.fallbackReason).toBe('error')
  })
  it('clef missing answer id -> Jev', async () => {
    const { ai } = fakeAi(() => clefOut({}))
    const { trace } = await run(ai, jevFetch(), req(), meta({ decision: 'shell-safety' }))
    expect(trace.fallbackReason).toBe('incomplete')
  })
  it('clef answer of the wrong type -> Jev', async () => {
    const { ai } = fakeAi(() => clefOut({ dangerous: { type: 'choice', choice: 'a', probabilities: {}, confidence: 1 } }))
    const { trace } = await run(ai, jevFetch(), req(), meta({ decision: 'shell-safety' }))
    expect(trace.fallbackReason).toBe('incomplete')
  })
  it('clef timeout (deadline - 1200ms) -> Jev with the time that remains', async () => {
    const { ai } = fakeAi(() => new Promise(() => {}))
    const f = jevFetch()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const t0 = Date.now()
      const pending = run(ai, f, req(), meta({ decision: 'shell-safety' }, 1900))
      await vi.advanceTimersByTimeAsync(700)
      const { response, trace } = await pending
      expect(trace.fallbackReason).toBe('timeout')
      expect(response.servedBy).toBe('jev')
      expect(Date.now() - t0).toBe(700)
      expect(f).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('no time for clef at all -> Jev directly', async () => {
    const { ai, calls } = fakeAi(() => clefOut(confident))
    const { trace } = await run(ai, jevFetch(), req(), meta({ decision: 'shell-safety' }, 1000))
    expect(calls).toHaveLength(0)
    expect(trace.fallbackReason).toBe('no-time')
  })
  it('timeout below MIN_CLEF_MS (but > 0) skips Clef', async () => {
    const { ai, calls } = fakeAi(() => clefOut(confident))
    const { trace } = await run(ai, jevFetch(), req(), meta({ decision: 'shell-safety' }, 1300))
    expect(calls).toHaveLength(0)
    expect(trace.fallbackReason).toBe('no-time')
  })
  it('Clef timeout adds an estimated neuron cost', async () => {
    vi.useFakeTimers()
    try {
      const { ai } = fakeAi(() => new Promise(() => {}))
      const r = req()
      const pending = run(ai, jevFetch(), r, meta({ decision: 'shell-safety' }, 2000))
      await vi.advanceTimersByTimeAsync(2000)
      const { trace } = await pending
      const tokens = Math.ceil(JSON.stringify({ state: r.state, questions: r.questions }).length / 4)
      expect(trace.neurons).toBeCloseTo((tokens * 3455) / 1e6, 8)
    } finally {
      vi.useRealTimers()
    }
  })
  it('Clef and Jev both fail -> 502, never answers', async () => {
    const { ai } = fakeAi(() => { throw new Error('x') })
    const f = (async () => new Response('down', { status: 503 })) as any
    const err = await run(ai, f, req(), meta({ decision: 'shell-safety' })).catch((e) => e)
    expect(err).toBeInstanceOf(DecisionError)
    expect(err.status).toBe(502)
    expect(traceOf(err)?.fallbackReason).toBe('error')
  })
  it('Jev deadline -> 504', async () => {
    const { ai } = fakeAi(() => { throw new Error('x') })
    const slow = ((_u: string, init: any) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))) as any
    const err = await run(ai, slow, req(), meta({ decision: 'shell-safety' }, 1500)).catch((e) => e)
    expect(err.status).toBe(504)
  })
  it('Jev 429 once then success', async () => {
    let n = 0
    const f = (async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0.01' } }) : jevOk(noulAnswer))) as any
    const { response } = await run(fakeAi(() => { throw new Error('x') }).ai, f, req(), meta({ decision: 'shell-safety' }))
    expect(response.servedBy).toBe('jev')
    expect(n).toBe(2)
  })
})

import { answersComplete } from '../src/schema'
describe('answersComplete strictness', () => {
  const qs: any = {
    c: { type: 'choice', instructions: 'x', criteria: { a: 'A', other: 'O' } },
    n: { type: 'noul', instructions: 'x' },
    s: { type: 'score', instructions: 'x', criteria: ['l0', 'l1'] },
  }
  const good = () => ({ c: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: {} }, n: { type: 'noul', noul: 0.5 }, s: { type: 'score', score: 1, confidence: 0.5, probabilities: { '0': 0.5, '1': 0.5 } } })
  it('accepts valid', () => expect(answersComplete(qs, good())).toBe(true))
  it('rejects bad choice / ranges / probability keys', () => {
    for (const mut of [
      (a: any) => (a.c.choice = 'zzz'),
      (a: any) => (a.c.confidence = 1.5),
      (a: any) => (a.n.noul = NaN),
      (a: any) => (a.n.noul = -0.1),
      (a: any) => (a.s.confidence = 2),
      (a: any) => (a.s.probabilities = { '5': 1 }),
    ]) {
      const a = good()
      mut(a)
      expect(answersComplete(qs, a)).toBe(false)
    }
  })
})
