# src/

| File | Role |
|---|---|
| `app.ts` | Hono routes, bearer auth middleware, error mapping |
| `service.ts` | `runDecision`: `decide()` plus the D1 log row and shadow, via `waitUntil` |
| `decide.ts` | route → Clef → escalation → Jev fallback, plus deadlines |
| `router.ts`, `routes.ts` | pure routing; static decision → tier table |
| `quota.ts` | budget error classification (2041 gateway spend limit, 4006 free quota); per-isolate skip-Clef flag |
| `providers/` | the only code that calls Workers AI or Jev |
| `log.ts`, `sync.ts` | D1 call log, stats, 30-day purge cron |
| `mcp.ts` | MCP tools `decide`, `budget`, `stats`, `recent_calls` |

## Invariants

- **Never fabricate answers.** A 200 response carries only Clef or Jev answers that passed `answersComplete()`. A total failure is `DecisionError` 502, or 504 on deadline.
- **Auth.** Everything except `GET /`, `GET /health` and `GET /favicon.ico` sits behind the constant-time bearer check. New routes go under `/v1/*` or `/mcp`.
- **Jev gets drop-in requests.** It receives the caller's original body with `model` forced to `jev-latest` and `images`/`audio`/`videos` removed.
- **Budget has no counter.** Gateway and quota errors are the only signal. No Durable Objects or KV for budgeting.
- **Shadow** runs only for free-served calls with no media and no `X-Replay`.
- **Client errors are generic.** Detail goes to `console.error` and the D1 row.
- **Route-table keys are real harness decision names.** MCP calls arrive as `mcp:<tool>`. Check `~/.claude/skills/jev-harness/decisions/*.ts` before adding one.
- **console.error opens Cloudflare Issues; console.warn does not.** Only real failures get `console.error(new XError(), details)` with a STABLE message (`BothDownError`, `JevCircuitOpenError`; variable detail goes in the 2nd arg). Expected budget hits (2041, 4006) are `console.warn`, so daily exhaustion alone raises no Issue.
- Keep routing, quota and schema logic as pure functions.
