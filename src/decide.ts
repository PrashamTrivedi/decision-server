import type { Env } from './env'
import { DecisionError } from './errors'
import { extractMedia, type Media } from './media'
import { callClef, ClefError, type ClefTier } from './providers/clef'
import { callJev } from './providers/jev'
import {
  buildRouterRequest,
  DEFAULT_ESCALATION,
  needsEscalation,
  parseBand,
  parseRouterAnswer,
  route,
  type EscalationConfig,
  type Tier,
} from './router'
import type { Answers, DecisionMeta, DecisionRequest, Questions } from './schema'

export type { Tier }

export interface DecisionResponse {
  answers: Answers
  model: string
  usage: { input_tokens: number }
  servedBy: Tier
  routeReason: string
  neurons: number
  ms: number
}

/** Everything the logger needs beyond the response. */
export interface Trace {
  routerPick?: Tier
  fallbackReason?: string
  servedBy?: Tier
  routeReason: string
  model?: string
  inputTokens: number
  neurons: number
  /** Free-served calls are eligible for the live Jev shadow. */
  mediaCount: number
}

export interface DecisionOutcome {
  response: DecisionResponse
  trace: Trace
}

export interface Deps {
  fetch?: typeof fetch
  now?: () => number
}

/** Free model gets `deadline - 1200ms`; the rest is kept for the Jev fallback. */
export const CLEF_RESERVE_MS = 1200
export const MIN_CLEF_MS = 250

class TracedError extends DecisionError {
  constructor(base: DecisionError, readonly trace: Trace) {
    super(base.message, base.status)
  }
}
export function traceOf(err: unknown): Trace | undefined {
  return err instanceof TracedError ? err.trace : undefined
}

export function escalationConfig(env: Env): EscalationConfig {
  return { ...DEFAULT_ESCALATION, ...(parseBand((env as any).AMBIGUITY_BAND) ?? {}) }
}

export async function decide(env: Env, req: DecisionRequest, meta: DecisionMeta, deps: Deps = {}): Promise<DecisionOutcome> {
  const now = deps.now ?? Date.now
  const { media, state: cleanState } = extractMedia(req.state, req as any)
  const trace: Trace = { routeReason: '', inputTokens: 0, neurons: 0, mediaCount: media.images.length + media.audio.length + media.videos.length }

  const callJevNow = async (reason: string, fallbackReason?: string): Promise<DecisionOutcome> => {
    trace.routeReason = reason
    if (fallbackReason) trace.fallbackReason = fallbackReason
    const r = await callJev(env, req.state, req.questions, meta.deadlineAt, deps.fetch)
    trace.model = r.model
    trace.inputTokens = r.inputTokens
    return finish(r.answers, r.model, r.inputTokens, 'jev', reason)
  }

  const finish = (answers: Answers, model: string, tokens: number, servedBy: Tier, routeReason: string): DecisionOutcome => {
    trace.servedBy = servedBy
    trace.routeReason = routeReason
    trace.model = model
    trace.inputTokens = tokens
    return {
      trace,
      response: {
        answers,
        model,
        usage: { input_tokens: tokens },
        servedBy,
        routeReason,
        neurons: round(trace.neurons),
        ms: now() - meta.startedAt,
      },
    }
  }

  const clef = async (tier: ClefTier, st: unknown, qs: Questions, m: Media | null) => {
    const r = await callClef(env.AI, env.AI_GATEWAY_ID, tier, st, qs, m, meta.deadlineAt - CLEF_RESERVE_MS - now())
    trace.neurons += r.neurons
    return r
  }

  try {
    const decision = route({ model: req.model, decision: meta.decision, media, skipClef: false })
    let tier: Tier
    let reason: string
    let escalate = false

    if (decision.kind === 'router') {
      reason = decision.reason
      try {
        const rq = buildRouterRequest(meta.decision, req.state, req.questions)
        const r = await clef('flash', rq.state, rq.questions, null)
        const pick = parseRouterAnswer(r.answers)
        if (!pick) throw new ClefError('incomplete', 'router returned no valid tier')
        trace.routerPick = pick
        tier = pick
        reason = `router:${pick}`
      } catch (err) {
        if (!(err instanceof ClefError)) throw err
        return await callJevNow(`${reason}`, `router-${err.kind}`)
      }
    } else {
      tier = decision.tier
      reason = decision.reason
      escalate = !!decision.escalate
    }

    if (tier === 'jev') return await callJevNow(reason)

    try {
      const r = await clef(tier, cleanState, req.questions, tier === 'omni' ? media : null)
      if (escalate && tier === 'flash' && needsEscalation(r.answers, escalationConfig(env)) && meta.deadlineAt - now() >= escalationConfig(env).minRemainingMs) {
        try {
          const r2 = await clef('clef', cleanState, req.questions, null)
          return finish(r2.answers, r2.model, r2.inputTokens, 'clef', `${reason}+escalated`)
        } catch (err) {
          if (!(err instanceof ClefError)) throw err
          trace.fallbackReason = `escalation-${err.kind}`
          return finish(r.answers, r.model, r.inputTokens, 'flash', `${reason}+escalation-failed`)
        }
      }
      return finish(r.answers, r.model, r.inputTokens, tier, reason)
    } catch (err) {
      if (!(err instanceof ClefError)) throw err
      return await callJevNow(`${reason}`, err.kind)
    }
  } catch (err) {
    if (err instanceof DecisionError && !(err instanceof TracedError)) throw new TracedError(err, { ...trace, servedBy: undefined })
    throw err
  }
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4
}
