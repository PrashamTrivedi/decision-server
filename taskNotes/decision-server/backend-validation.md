# Backend Validation: decision-server v1

**Status: unit- and contract-validated locally. Live and integration validation is pending, blocked on `npm install` (cf CLI) and the deploy.**
Branch `feat/decision-server-v1`, base `60ffd9b`. Validated 2026-10-14.

## Gates

| Gate | Result |
|---|---|
| `npm run type-check` (`tsc --noEmit`) | exit 0 |
| `npx vitest run` | `Tests 122 passed (122)`, 7 files, 5 consecutive runs |
| Review loop | 11 → 3 → 0 findings (`review-passes.md`) |
| Security review | 2 passes by security-code-reviewer: auth, SQL, secrets and fail-safe all clean |
| Secrets audit | `git grep` for key patterns: none |
| jev-harness patch | `bun test` 94/94, typecheck exit 0, live Jev smoke `jev-1.13.0` in 373 ms |
| `npm run typecheck` (`cf workers types && tsc`) | **not run**: `cf` isn't installed (stale lockfile) |
| Changed-file coverage | **not measured**: `@vitest/coverage-v8` isn't installed (same blocked install) |
| Integration (`cf dev --local`) / qa-validator | **not run**: needs `cf` |

## Acceptance criteria

| # | Criterion | Evidence | Status |
|---|---|---|---|
| 1 | Jev request body accepted; response parses for the unmodified harness client, plus extra fields | `test/passthrough.test.ts` | ✅ unit |
| 2 | Static table, flash router for unknown types, omni for media | `test/router.test.ts`, `test/decide.test.ts` (every `ROUTE_TABLE` row, including `mcp:*`) | ✅ unit |
| 3 | 2041/4006 → Jev, skip-Clef flag (15 min / until 00:00 UTC) | `test/quota.test.ts`, `test/decide.test.ts` using the exact 2041 body from pi's sessions | ✅ unit · live ⏳ (can't force without locking pi) |
| 4 | Other Clef errors and timeouts → Jev; total failure → 502/504, never invented answers | `test/decide.test.ts` (timeout with fake timers, both fail → 502, deadline → 504, stalled Jev body → 504) | ✅ unit |
| 5 | Full-payload log row per call (failures too); 30-day purge | `test/log.test.ts` (row per call, non-DecisionError logged with detail, purge) | ✅ unit (D1 fake) · real D1 ⏳ |
| 6 | 401 on every route except `/health` | `test/passthrough.test.ts`, `test/mcp.test.ts`; the reviewer checked path, method and case bypasses | ✅ unit |
| 7 | Remote MCP with 4 tools, usable from Claude Code | `test/mcp.test.ts` | ✅ unit · `claude mcp add` ⏳ |
| 8 | Live shadow in waitUntil, skipped for replay/media/Jev-served calls | `test/log.test.ts` | ✅ unit · live ⏳ |
| 9 | Replay reports per-decision agreement, excluding Jev-served calls | `test/replay.test.ts` | ✅ unit · real 1k replay ⏳ |
| 10 | Harness: default config unchanged plus X-* headers; `endpoint` override works | jev-harness `tests/client.test.ts` (6 tests) and the live smoke test | ✅ |
| 11 | No secrets in the repo; `.dev.vars.example`; README; setup prompt passes live | audit clean, files present | ✅ static · setup prompt live ⏳ |
| 12 | Type-check and tests green | see Gates | ✅ |

## Corrections found during validation

- The PRD's "omni for screenshot-gate" was wrong. `screenshot-gate` sends text only, so it's routed to flash now.
- MCP decisions are named `mcp:<tool>`, so the original `ask_jev_file` table key never matched. Fixed in `fcf61d0`.

## Pending (in order)

1. `npm install`, then `npm run typecheck` (with cf types) and `npx vitest run --coverage` (needs `@vitest/coverage-v8`).
2. `cf d1 create`, migrate, secrets, `npm run deploy`.
3. The live checks in `taskWalkthrough.md` §2, then the agent setup prompt, then `bun scripts/replay.ts --limit 1000`.
