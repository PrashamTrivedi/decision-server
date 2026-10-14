import type { DecisionOutcome } from './decide'
import type { Env } from './env'
import { insertShadowPairs } from './log'
import { callJev } from './providers/jev'
import type { DecisionMeta, DecisionRequest } from './schema'

export function shouldShadow(env: Pick<Env, 'SHADOW'>, meta: DecisionMeta, outcome: DecisionOutcome): boolean {
  return env.SHADOW === 'on' && !meta.replay && outcome.response.servedBy !== 'jev' && outcome.trace.mediaCount === 0
}

export const SHADOW_BUDGET_MS = 10_000

/** Sends the same request to Jev in the background and stores both answers. Failures are swallowed. */
export async function runShadow(env: Env, callId: string, req: DecisionRequest, meta: DecisionMeta, outcome: DecisionOutcome, f?: typeof fetch): Promise<number> {
  try {
    const jev = await callJev(env, req, req.questions, Date.now() + SHADOW_BUDGET_MS, f)
    return await insertShadowPairs(env.DB, callId, meta.decision, outcome.response.answers, jev.answers)
  } catch {
    return 0
  }
}
