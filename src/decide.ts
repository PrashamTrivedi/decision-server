import type { Env } from './env'
import { BothDownError, DecisionError } from './errors'
import { extractMedia, type Media } from './media'
import { callClef, ClefError, neuronsFor, type ClefTier } from './providers/clef'
import { callJev, jevBreakerOpen, recordJev } from './providers/jev'
import { markSkip, skipState } from './quota'
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
/** Held back from Jev when the paid emergency Clef call may be needed after it. */
export const EMERGENCY_RESERVE_MS = 800

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

  // Both down: the gateway spend limit blocks Clef and Jev fails. One paid Clef call outside the gateway.
  // Not for the free quota (4006): that is account-wide, so bypassing the gateway doesn't help.
  const emergencyEligible = () => env.EMERGENCY_PAID !== 'off' && skipState(now()).kind === 'spend-limit'

  // Every both-down case (Clef budget-blocked and Jev failing) is one Cloudflare Issue, rescued or not.
  const reportBothDown = (jevErr: DecisionError, outcome: string, extra: Record<string, unknown> = {}) =>
    console.error(new BothDownError(), { outcome, decision: meta.decision, budget: skipState(now()).kind, jevStatus: jevErr.status, jevError: jevErr.message, ...extra })
  /** Jev failed; if Clef is budget-blocked but no rescue is allowed (free quota, or EMERGENCY_PAID=off), report and rethrow. */
  const unrescuable = (jevErr: DecisionError): never => {
    if (skipState(now()).active) reportBothDown(jevErr, 'unrescued', { cause: env.EMERGENCY_PAID === 'off' ? 'emergency-off' : 'quota' })
    throw jevErr
  }

  const emergency = async (reason: string, jevErr: DecisionError): Promise<DecisionOutcome> => {
    const tier: ClefTier = trace.mediaCount > 0 ? 'omni' : 'flash'
    const timeoutMs = meta.deadlineAt - now() - 50
    const report = (outcome: string, extra: Record<string, unknown> = {}) => reportBothDown(jevErr, outcome, { tier, ...extra })
    if (timeoutMs < MIN_CLEF_MS) {
      report('unrescued', { cause: 'no-time' })
      throw jevErr
    }
    try {
      const r = await callClef(env.AI, null, tier, cleanState, req.questions, trace.mediaCount > 0 ? media : null, timeoutMs)
      trace.neurons += r.neurons
      trace.fallbackReason = `${trace.fallbackReason ?? 'spend-limit'}+jev-${jevErr.status}`
      report('rescued', { servedBy: tier })
      return finish(r.answers, r.model, r.inputTokens, tier, `${reason}+emergency-paid`)
    } catch (err) {
      if (err instanceof ClefError) {
        report('unrescued', { cause: `clef-${err.kind}` })
        throw jevErr
      }
      throw err
    }
  }

  const callJevNow = async (reason: string, fallbackReason?: string): Promise<DecisionOutcome> => {
    trace.routeReason = reason
    if (fallbackReason) trace.fallbackReason = fallbackReason
    const eligible = emergencyEligible()
    if (jevBreakerOpen(now())) {
      const open = new DecisionError('jev unavailable (circuit open)', 502)
      if (eligible) return emergency(reason, open)
      return unrescuable(open)
    }
    try {
      const r = await callJev(env, req, req.questions, eligible ? meta.deadlineAt - EMERGENCY_RESERVE_MS : meta.deadlineAt, deps.fetch)
      recordJev(true, now())
      trace.model = r.model
      trace.inputTokens = r.inputTokens
      return finish(r.answers, r.model, r.inputTokens, 'jev', reason)
    } catch (err) {
      if (!(err instanceof DecisionError)) throw err
      recordJev(false, now())
      if (eligible) return emergency(reason, err)
      return unrescuable(err)
    }
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
    const timeoutMs = meta.deadlineAt - CLEF_RESERVE_MS - now()
    if (timeoutMs < MIN_CLEF_MS) throw new ClefError('no-time', 'no time left for clef')
    try {
      const r = await callClef(env.AI, env.AI_GATEWAY_ID, tier, st, qs, m, timeoutMs)
      trace.neurons += r.neurons
      return r
    } catch (err) {
      // An abandoned call may still be billed: estimate input tokens (~4 chars each) at the tier's rate.
      if (err instanceof ClefError && err.kind === 'timeout') trace.neurons += neuronsFor(tier, Math.ceil(JSON.stringify({ state: st, questions: qs }).length / 4))
      // Gateway spend limit (15 min) or Workers AI free quota (until 00:00 UTC): stop wasting attempts in this isolate.
      if (err instanceof ClefError && (err.kind === 'spend-limit' || err.kind === 'quota')) {
        markSkip(err.kind, now())
        // Expected budget exhaustion: warn only, so it doesn't open a Workers Issue by itself.
        console.warn(`clef budget hit: ${err.kind}`, { tier, decision: meta.decision })
      }
      throw err
    }
  }

  try {
    const decision = route({ model: req.model, decision: meta.decision, media, skipClef: skipState(now()).active })
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
      if (escalate && tier === 'flash' && needsEscalation(r.answers, escalationConfig(env)) && meta.deadlineAt - now() >= escalationConfig(env).minRemainingMs && meta.deadlineAt - now() - CLEF_RESERVE_MS >= MIN_CLEF_MS) {
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
