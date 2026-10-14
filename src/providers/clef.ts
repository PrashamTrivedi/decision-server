import type { AiLike } from '../env'
import type { Media } from '../media'
import { hasMedia } from '../media'
import { classify } from '../quota'
import type { Answers, Questions } from '../schema'
import { answersComplete } from '../schema'
import type { ProviderResult } from './jev'

export type ClefTier = 'flash' | 'clef' | 'omni'

/** Workers AI ids, the `model` selector Clef requires inside the input, and neurons per 1M input tokens (output is free). */
export const CLEF_MODELS: Record<ClefTier, { id: string; selector: string; neuronsPerMTok: number }> = {
  flash: { id: '@cf/cloudflare/clef-flash', selector: 'clef-flash', neuronsPerMTok: 3455 },
  clef: { id: '@cf/cloudflare/clef', selector: 'clef', neuronsPerMTok: 21818 },
  omni: { id: '@cf/cloudflare/clef-omni', selector: 'clef-omni', neuronsPerMTok: 13636 },
}

export function neuronsFor(tier: ClefTier, inputTokens: number): number {
  return (inputTokens * CLEF_MODELS[tier].neuronsPerMTok) / 1e6
}

export type ClefErrorKind = 'timeout' | 'incomplete' | 'no-time' | 'error' | 'spend-limit' | 'quota'

export class ClefError extends Error {
  constructor(
    readonly kind: ClefErrorKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ClefError'
  }
}

export interface ClefResult extends ProviderResult {
  neurons: number
}

/**
 * env.AI.run(model, {model, state, questions[, images, audio, videos]}) raced against `timeoutMs`.
 * Workers AI has no documented abort signal, so an abandoned call may still be billed.
 * Media is only attached for omni (flash/clef accept images only, and the router sends media to omni).
 */
export async function callClef(
  ai: AiLike,
  /** null calls Workers AI directly, outside the gateway and its spend rules (billed at paid rates). */
  gatewayId: string | null,
  tier: ClefTier,
  state: unknown,
  questions: Questions,
  media: Media | null,
  timeoutMs: number,
): Promise<ClefResult> {
  if (timeoutMs <= 0) throw new ClefError('no-time', 'no time left for clef')
  const spec = CLEF_MODELS[tier]
  const input: Record<string, unknown> = { model: spec.selector, state, questions }
  if (tier === 'omni' && media && hasMedia(media)) {
    if (media.images.length) input.images = media.images
    if (media.audio.length) input.audio = media.audio
    if (media.videos.length) input.videos = media.videos
  }
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new ClefError('timeout', `clef ${tier} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  let out: any
  try {
    out = await Promise.race([(gatewayId === null ? ai.run(spec.id, input) : ai.run(spec.id, input, { gateway: { id: gatewayId } })), timeout])
  } catch (err) {
    if (err instanceof ClefError) throw err
    const cls = classify(err)
    throw new ClefError(cls === 'other' ? 'error' : cls, String((err as any)?.message ?? err), err)
  } finally {
    clearTimeout(timer)
  }
  if (!answersComplete(questions, out?.answers)) throw new ClefError('incomplete', `clef ${tier} returned missing/invalid answers`)
  const inputTokens = Number(out?.usage?.input_tokens) || 0
  return {
    answers: out.answers as Answers,
    model: String(out.model ?? spec.selector),
    inputTokens,
    ms: Date.now() - started,
    neurons: neuronsFor(tier, inputTokens),
  }
}
