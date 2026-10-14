import type { Answers, Questions } from '../schema'
import { answersComplete } from '../schema'
import { DecisionError } from '../errors'
import type { Env } from '../env'

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
/** Always sent to Jev, whatever routing alias the caller used. */
export const JEV_MODEL = 'jev-latest'

export interface ProviderResult {
  answers: Answers
  model: string
  inputTokens: number
  ms: number
}

type FetchFn = typeof fetch

/**
 * Calls Jev with whatever time remains. One 429 retry inside the deadline (same as the harness client).
 * Throws DecisionError(504) on deadline, DecisionError(502) on everything else.
 */
export async function callJev(
  env: Pick<Env, 'TYPESAFE_API_KEY'>,
  state: unknown,
  questions: Questions,
  deadlineAt: number,
  fetchFn: FetchFn = fetch,
): Promise<ProviderResult> {
  if (!env.TYPESAFE_API_KEY) throw new DecisionError('TYPESAFE_API_KEY not configured', 502)
  const body = JSON.stringify({ model: JEV_MODEL, state, questions })

  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 50) throw new DecisionError('deadline exceeded', 504)
    const started = Date.now()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), remaining)
    let res: Response
    try {
      res = await fetchFn(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      })
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new DecisionError('deadline exceeded', 504)
      throw new DecisionError(`jev network error: ${err?.message ?? err}`, 502)
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? 0.3) * 1000, deadlineAt - Date.now() - 100)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (!res.ok) throw new DecisionError(`jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, 502)
    let data: any
    try {
      data = await res.json()
    } catch {
      throw new DecisionError('jev returned invalid JSON', 502)
    }
    if (!answersComplete(questions, data?.answers)) throw new DecisionError('jev returned incomplete answers', 502)
    return {
      answers: data.answers,
      model: String(data.model ?? JEV_MODEL),
      inputTokens: data.usage?.input_tokens ?? 0,
      ms: Date.now() - started,
    }
  }
  throw new DecisionError('jev rate limited', 502)
}
