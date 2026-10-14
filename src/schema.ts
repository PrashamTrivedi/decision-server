import { z } from 'zod'

/** Jev wire types. Permissive (loose objects) so new Jev fields never break the server. */
const instructions = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])

export const questionSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('noul'), instructions }),
  z.looseObject({ type: z.literal('choice'), instructions, criteria: z.record(z.string(), z.unknown()) }),
  z.looseObject({ type: z.literal('score'), instructions, criteria: z.array(z.unknown()) }),
])

export const questionsSchema = z
  .record(z.string(), questionSchema)
  .refine((q) => Object.keys(q).length >= 1, 'questions must have at least one entry')

export const requestSchema = z.looseObject({
  model: z.string().optional(),
  state: z.unknown().refine((v) => v !== undefined, 'state is required'),
  questions: questionsSchema,
})

export type Question = z.infer<typeof questionSchema>
export type Questions = z.infer<typeof questionsSchema>
export type DecisionRequest = z.infer<typeof requestSchema>

export type NoulAnswer = { type: 'noul'; noul: number }
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export type ScoreAnswer = { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer
export type Answers = Record<string, Answer>

/** Validates that `answers` has a well-formed answer for every question id (never return partial answers). */
export function answersComplete(questions: Questions, answers: unknown): answers is Answers {
  if (!answers || typeof answers !== 'object') return false
  const a = answers as Record<string, any>
  for (const [id, q] of Object.entries(questions)) {
    const x = a[id]
    if (!x || typeof x !== 'object' || x.type !== q.type) return false
    if (q.type === 'noul' && typeof x.noul !== 'number') return false
    if (q.type === 'choice' && typeof x.choice !== 'string') return false
    if (q.type === 'score' && typeof x.score !== 'number') return false
  }
  return true
}

export interface DecisionMeta {
  decision?: string
  mode?: string
  agent?: string
  session?: string
  replay: boolean
  /** Absolute epoch ms by which the response must be sent. */
  deadlineAt: number
  startedAt: number
}

export const DEFAULT_DEADLINE_MS = 3800

export function parseMeta(headers: Headers, now = Date.now()): DecisionMeta {
  const raw = Number(headers.get('x-deadline-ms'))
  const ms = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30_000) : DEFAULT_DEADLINE_MS
  const replay = headers.get('x-replay')
  return {
    decision: headers.get('x-decision') ?? undefined,
    mode: headers.get('x-mode') ?? undefined,
    agent: headers.get('x-agent') ?? undefined,
    session: headers.get('x-session') ?? undefined,
    replay: !!replay && replay !== '0' && replay.toLowerCase() !== 'false',
    deadlineAt: now + ms,
    startedAt: now,
  }
}
