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
