import type { Media } from './media'
import { hasMedia, overLimit } from './media'
import { ROUTE_TABLE, type RouteTarget } from './routes'
import type { Answers, Questions } from './schema'

export type Tier = 'flash' | 'clef' | 'omni' | 'jev'

export type RouteDecision =
  /** `escalate`: run flash first, then clef if the answers are low-confidence/ambiguous. */
  | { kind: 'tier'; tier: Tier; reason: string; escalate?: boolean }
  /** Unknown decision type: ask the flash router. */
  | { kind: 'router'; reason: string }

export interface RouteInput {
  model?: string
  decision?: string
  media: Media
  skipClef: boolean
}

const FORCED: Record<string, Tier> = {
  flash: 'flash',
  'clef-flash': 'flash',
  clef: 'clef',
  omni: 'omni',
  'clef-omni': 'omni',
  jev: 'jev',
}

/** Pure router. Order: forced model -> media -> skip-Clef flag -> static table -> flash router. */
export function route(input: RouteInput, table: Readonly<Record<string, RouteTarget>> = ROUTE_TABLE): RouteDecision {
  const forced = input.model ? FORCED[input.model.trim().toLowerCase()] : undefined
  if (forced) return { kind: 'tier', tier: forced, reason: `forced:${forced}` }
  if (hasMedia(input.media)) {
    if (overLimit(input.media)) return { kind: 'tier', tier: 'jev', reason: 'media-over-limit' }
    return { kind: 'tier', tier: 'omni', reason: 'media' }
  }
  if (input.skipClef) return { kind: 'tier', tier: 'jev', reason: 'skip-clef' }
  const target = input.decision ? (Object.hasOwn(table, input.decision) ? table[input.decision] : undefined) : undefined
  if (target === 'either') return { kind: 'tier', tier: 'flash', reason: `static:${input.decision}`, escalate: true }
  if (target) return { kind: 'tier', tier: target, reason: `static:${input.decision}` }
  return { kind: 'router', reason: input.decision ? `unknown:${input.decision}` : 'no-decision' }
}

export const ROUTER_QUESTION_ID = 'tier'

/** The ~200-token question sent to clef-flash for unknown decision types. */
export function buildRouterRequest(decision: string | undefined, state: unknown, questions: Questions) {
  const stateChars = typeof state === 'string' ? state.length : JSON.stringify(state ?? null).length
  return {
    state: {
      decision: decision ?? 'unknown',
      stateChars,
      questionCount: Object.keys(questions).length,
      questionKinds: Object.values(questions).map((q) => q.type),
    },
    questions: {
      [ROUTER_QUESTION_ID]: {
        type: 'choice' as const,
        instructions:
          'Pick the cheapest tier able to answer these decision questions reliably, given the decision type, payload size and question kinds.',
        criteria: {
          flash: 'Small, simple, low-stakes yes/no style judgments',
          clef: 'Larger payloads or nuanced judgments needing the bigger model',
          jev: 'Safety-critical or highly subtle judgments',
        },
      },
    },
  }
}

/** Reads the router's answer. Returns null when it is missing/invalid. */
export function parseRouterAnswer(answers: Answers): 'flash' | 'clef' | 'jev' | null {
  const a = answers[ROUTER_QUESTION_ID]
  if (a?.type !== 'choice') return null
  return a.choice === 'flash' || a.choice === 'clef' || a.choice === 'jev' ? a.choice : null
}

export interface EscalationConfig {
  minConfidence: number
  bandLow: number
  bandHigh: number
  minRemainingMs: number
}

export const DEFAULT_ESCALATION: EscalationConfig = { minConfidence: 0.6, bandLow: 0.3, bandHigh: 0.85, minRemainingMs: 1500 }

/** Any choice/score confidence below the floor, or any noul in the ambiguity band, wants the bigger model. */
export function needsEscalation(answers: Answers, cfg: EscalationConfig = DEFAULT_ESCALATION): boolean {
  for (const a of Object.values(answers)) {
    if (a.type === 'noul') {
      if (a.noul >= cfg.bandLow && a.noul <= cfg.bandHigh) return true
    } else if (a.confidence < cfg.minConfidence) return true
  }
  return false
}

export function parseBand(raw: string | undefined): Pick<EscalationConfig, 'bandLow' | 'bandHigh'> | null {
  const m = /^\s*([\d.]+)\s*[,-]\s*([\d.]+)\s*$/.exec(raw ?? '')
  if (!m) return null
  const [lo, hi] = [Number(m[1]), Number(m[2])]
  return lo <= hi ? { bandLow: lo, bandHigh: hi } : null
}
