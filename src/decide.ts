import type { Env } from './env'
import type { Answers, DecisionMeta, DecisionRequest } from './schema'
import { callJev } from './providers/jev'

export type Tier = 'flash' | 'clef' | 'omni' | 'jev'

export interface DecisionResponse {
  answers: Answers
  model: string
  usage: { input_tokens: number }
  servedBy: Tier
  routeReason: string
  neurons: number
  ms: number
}

export interface Deps {
  fetch?: typeof fetch
}

export async function decide(
  env: Env,
  req: DecisionRequest,
  meta: DecisionMeta,
  deps: Deps = {},
): Promise<DecisionResponse> {
  const r = await callJev(env, req.state, req.questions, meta.deadlineAt, deps.fetch)
  return {
    answers: r.answers,
    model: r.model,
    usage: { input_tokens: r.inputTokens },
    servedBy: 'jev',
    routeReason: 'passthrough',
    neurons: 0,
    ms: Date.now() - meta.startedAt,
  }
}
