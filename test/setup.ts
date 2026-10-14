import { beforeEach } from 'vitest'
import { resetJevBreaker } from '../src/providers/jev'
import { resetSkip } from '../src/quota'

// Per-isolate module state (skip-Clef flag, Jev circuit breaker) must not leak between tests.
beforeEach(() => {
  resetSkip()
  resetJevBreaker()
})
