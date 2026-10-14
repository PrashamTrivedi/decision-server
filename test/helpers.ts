import type { Env } from '../src/env'
import { makeD1 } from './d1fake'

export const TOKEN = 'test-token'

export function makeEnv(over: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => { throw new Error('AI not stubbed') } },
    DB: makeD1(),
    DECISIONS_TOKEN: TOKEN,
    ACCESS_TEAM_DOMAIN: 'team.test',
    ACCESS_AUD: 'REPLACE_WITH_ACCESS_AUD',
    TYPESAFE_API_KEY: 'jev-key',
    AI_GATEWAY_ID: 'default',
    SHADOW: 'off',
    ...over,
  }
}

export const noulQ = { dangerous: { type: 'noul', instructions: 'Is it dangerous?' } } as const

export const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

export function jevOk(answers: unknown, model = 'jev-1', input_tokens = 10): Response {
  return new Response(JSON.stringify({ answers, model, usage: { input_tokens } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

export const noulAnswer = { dangerous: { type: 'noul', noul: 0.1 } }

import type { AiLike } from '../src/env'
import type { DecisionMeta } from '../src/schema'
import { vi } from 'vitest'

export interface AiCall { model: string; input: any; options: any }

/** Fake env.AI. `handler` returns the output (or throws) per call. */
export function fakeAi(handler: (call: AiCall, n: number) => unknown | Promise<unknown>) {
  const calls: AiCall[] = []
  const ai: AiLike = {
    run: async (model, input, options) => {
      const call = { model, input, options }
      calls.push(call)
      return handler(call, calls.length)
    },
  }
  return { ai, calls }
}

export function clefOut(answers: unknown, input_tokens = 100, model = 'clef-flash') {
  return { answers, model, usage: { input_tokens, output_tokens: 5 } }
}

export function meta(over: Partial<DecisionMeta> = {}, deadlineMs = 3800): DecisionMeta {
  const now = Date.now()
  return { replay: false, startedAt: now, deadlineAt: now + deadlineMs, ...over }
}

export function jevFetch(answers: unknown = noulAnswer) {
  return vi.fn(async (..._a: any[]) => jevOk(answers))
}

export const req = (over: Record<string, unknown> = {}) =>
  ({ model: 'jev-latest', state: { command: 'ls' }, questions: noulQ, ...over }) as any
