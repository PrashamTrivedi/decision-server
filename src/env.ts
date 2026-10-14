/** Minimal structural type for the Workers AI binding so tests can pass fakes. */
export interface AiLike {
  run(model: string, input: unknown, options?: { gateway?: { id: string } }): Promise<unknown>
}

export interface Env {
  AI: AiLike
  DB: D1Database
  /** Secret: inbound bearer token. */
  DECISIONS_TOKEN: string
  /** Secret: outbound Jev key. */
  TYPESAFE_API_KEY: string
  /** AI Gateway id used for every AI.run call. */
  AI_GATEWAY_ID: string
  /** "on" enables live shadow comparison against Jev. */
  SHADOW?: string
  RETENTION_DAYS?: string
  VERSION?: string
}
