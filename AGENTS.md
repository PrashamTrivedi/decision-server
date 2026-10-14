# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, Gemini) working in this repo. Human docs are in `README.md`.

## What this is

A Cloudflare Worker that answers Jev-format decision calls (`{model, state, questions}`) on free Workers AI Clef models (`@cf/cloudflare/clef-flash`, `clef`, `clef-omni`) and falls back to Jev (`api.typesafe.ai/v1/systemone`). It exposes REST (`/v1/*`) and a stateless remote MCP server (`/mcp`). The design and its reasoning are in `taskNotes/decision-server/` (`requirements.md`, `design.md`, `taskFindings.md`).

## Commands

```bash
bun install
bun run typecheck      # cf workers types && tsc --noEmit (types land in .cloudflare/types)
bun run test:run       # vitest. Do NOT use `bun test`, which runs bun's own runner and not this suite
bun run dev            # cf dev
bun run db:migrate:local
```

The package manager is bun (`bun.lock`). Don't add `package-lock.json`. The tooling is the Cloudflare `cf` CLI with `cloudflare.config.ts`. There's no `wrangler.jsonc`, so don't add one.

## Layout

| Path | Role |
|---|---|
| `src/app.ts` | Hono routes, bearer auth middleware, error mapping |
| `src/service.ts` | `runDecision`: `decide()` plus the D1 log row and live shadow, via `waitUntil` |
| `src/decide.ts` | route → Clef → escalation → Jev fallback, plus deadline handling |
| `src/router.ts`, `src/routes.ts` | pure routing; static decision → tier table |
| `src/quota.ts` | classifies budget errors (2041 gateway spend limit, 4006 free quota); per-isolate skip-Clef flag |
| `src/providers/{clef,jev}.ts` | the only code that calls Workers AI / Jev |
| `src/log.ts`, `src/sync.ts` | D1 call log, stats, 30-day purge cron |
| `src/mcp.ts` | MCP tools: `decide`, `budget`, `stats`, `recent_calls` |
| `scripts/replay.ts` | local agreement replay from `~/.jev-harness/jev.db` |
| `test/` | vitest with fakes (`helpers.ts`, `d1fake.ts`). No network |

## Invariants (don't break these)

- **Never fabricate answers.** Every 200 response carries answers from Clef or Jev that passed `answersComplete()`. A total failure is `DecisionError` 502, or 504 on deadline. The jev-harness turns errors into `ask` for safety decisions itself.
- **Auth.** Everything except `GET /health` sits behind the constant-time bearer check. New routes go under `/v1/*` or `/mcp`.
- **Jev gets drop-in requests.** It receives the caller's original body with `model` forced to `jev-latest` and the Clef-only `images`/`audio`/`videos` removed.
- **Budget has no counter.** Gateway and quota errors are the signal. Don't add Durable Objects or KV for budgeting.
- **Shadow** runs only for free-served calls with no media and no `X-Replay`.
- **Client errors are generic.** Detail goes to `console.error` and the D1 row only.
- **Route-table keys match real harness decision names.** MCP calls arrive as `mcp:<tool>`. Check `~/.claude/skills/jev-harness/decisions/*.ts` before adding one.

## Conventions

- TypeScript strict. Hono and zod 4. Keep routing, quota and schema logic as pure functions and test them directly.
- Every behaviour change gets a test. Timing tests use `vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','Date'] })`, not real sleeps.
- Commits: one-line conventional commit with emoji (for example `✨ feat: …`, `🐛 fix: …`).
- Never commit `.dev.vars` or real tokens. `.dev.vars.example` holds placeholders only.

## Ask before

Anything that touches live Cloudflare resources: `cf deploy`, `cf d1 …` without `--local`, `cf workers secrets …`, or AI Gateway rules. The `default` gateway is shared with other tools, and tightening its spend limit locks them out too.
