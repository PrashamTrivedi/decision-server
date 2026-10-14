import { decide, traceOf, type Deps, type DecisionOutcome } from './decide'
import { DecisionError } from './errors'
import type { Env } from './env'
import { buildRow, insertCall } from './log'
import { runShadow, shouldShadow } from './shadow'
import type { DecisionMeta, DecisionRequest } from './schema'

export interface Waiter {
  waitUntil(p: Promise<unknown>): void
}

/**
 * decide() plus the D1 log row and (optional) live shadow, both deferred through waitUntil
 * so they never add latency. Total failures are logged too, then rethrown (502/504).
 */
export async function runDecision(env: Env, waiter: Waiter, req: DecisionRequest, meta: DecisionMeta, deps: Deps = {}): Promise<DecisionOutcome> {
  const id = crypto.randomUUID()
  const now = deps.now ?? Date.now
  const log = (p: Promise<unknown>) => waiter.waitUntil(p.catch((e) => console.error('log failed', e)))
  try {
    const outcome = await decide(env, req, meta, deps)
    log(
      (async () => {
        await insertCall(env.DB, buildRow({ id, now: now(), meta, req, trace: outcome.trace, answers: outcome.response.answers }))
        if (shouldShadow(env, meta, outcome)) await runShadow(env, id, req, meta, outcome, deps.fetch)
      })(),
    )
    return outcome
  } catch (err) {
    const de = err instanceof DecisionError ? err : new DecisionError(`internal: ${(err as any)?.message ?? err}`, 502)
    const trace = traceOf(de) ?? { routeReason: '', inputTokens: 0, neurons: 0, mediaCount: 0 }
    log(insertCall(env.DB, buildRow({ id, now: now(), meta, req, trace, answers: null, error: de.message })))
    throw de
  }
}
