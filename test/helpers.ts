import type { Env } from '../src/env'

export const TOKEN = 'test-token'

export function makeEnv(over: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => { throw new Error('AI not stubbed') } },
    DB: undefined as unknown as D1Database,
    DECISIONS_TOKEN: TOKEN,
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
