# test/

- vitest with fakes only (`helpers.ts`, `d1fake.ts`). No network, no real Workers AI or Jev.
- Every behaviour change in `src/` gets a test here.
- Timing tests use `vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','Date'] })`. Never use real sleeps or wall-clock margins, which flake.
- Use the exact 2041 body from `SPEND_LIMIT_BODY` (`src/quota.ts`) for gateway spend-limit cases.
