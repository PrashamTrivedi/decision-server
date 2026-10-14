/** Total failure. 502 = every model failed, 504 = deadline ran out. Never carries answers. */
export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status: 502 | 504,
  ) {
    super(message)
    this.name = 'DecisionError'
  }
}

/**
 * Reported via console.error so Cloudflare Workers Issues opens one Issue for it. Keep messages STABLE (no ids, statuses or
 * timings): variable detail goes in the second console.error argument.
 */
export class BothDownError extends Error {
  constructor() {
    super('both-down: clef spend-limit + jev unavailable')
    this.name = 'BothDownError'
  }
}
export class JevCircuitOpenError extends Error {
  constructor() {
    super('jev circuit open')
    this.name = 'JevCircuitOpenError'
  }
}
