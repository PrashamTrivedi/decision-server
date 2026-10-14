# Purpose

Build `decisions.prashamhtrivedi.app`: a Cloudflare Worker that answers Jev-format decision calls on free Workers AI Clef models first and falls back to Jev, exposed over REST and remote MCP.

## Original Ask

> PRD (memory `6bba73b4`, copied to `/root/Code/decision-server/requirements.md`):
> Jev harness decisions cost money on every call, while Cloudflare Workers AI's free 10k neurons a day go unused. Build one endpoint that answers on free Clef models first and falls back to Jev when the free budget runs out. […full PRD in `requirements.md`…]
>
> Finalized in brainstorming: `taskNotes/decision-server/requirements.md` (independence from Jev + OSS showcase + future scale; account-wide budget; AWS later; replay + live shadow; Jev-only fallback; full-payload log). How it works: `taskNotes/decision-server/design.md` (REST + MCP + setup prompt).
>
> "Now How it will work. MCP and REST API. Plus agent setup prompt." → "This is the decision server. PRD was for that. Let's rework on the plan first"

## Research facts this plan depends on (2026-10-14)

| Fact | Source | Effect on plan |
|---|---|---|
| `@cf/cloudflare/clef-flash` (9B, 24k ctx), `@cf/cloudflare/clef` (27B, 64k), `@cf/cloudflare/clef-omni` (30B MoE, 64k, images + audio + video) | developers.cloudflare.com/workers-ai/models/clef* | Real models. |
| Clef takes **`{state, questions}` with noul/choice/score and returns `{answers, usage}` with per-option probabilities**, the same shape as Jev | same | **There's no prompt-to-JSON layer.** The server passes `questions` straight through. This replaces design.md's "Making free models return Jev-shaped answers" section. |
| Neurons per 1M input tokens: flash 3,455, clef 21,818, omni 13,636. **Output is free.** 10k/day free, resets 00:00 UTC | workers-ai/platform/pricing | About 424k tokens/day comes to roughly 1.5k neurons all on flash or 9.3k all on clef. A mix fits under 9.5k. |
| Paid rates: clef $0.24/M vs Jev $0.0385/M; flash $0.038/M | same | Past the free tier, Jev is never more expensive, so the Jev-only fallback holds. |
| On the Workers **Free** plan, requests fail once the 10k is used up (quota error, code 4006). On **Paid**, they're billed at $0.011/1k neurons instead | pricing page | Secondary signal (account-wide, Free plan only). The gateway spend limit below is primary because it also covers Paid. |
| `env.AI.run` has no documented AbortSignal or timeout | bindings page | Use `Promise.race` with a timer. An abandoned call may still be billed, so it's counted anyway. |
| **AI Gateway spend limits return `429 {code: 2041, "Spend limit exceeded: rule '<id>' (cost limit X per Ns, sliding\|fixed) for workers-ai <model>"}`**. Seen 20× in pi's sessions (Jul–Aug 2026) on the `default` gateway (rules: $0.20/day sliding, $0.43/day fixed, $10/30d sliding) | `~/.pi/agent/sessions/*.jsonl` | **Primary budget signal** (tweak rev 3). Clef calls go through the **existing `default` gateway** (tweak rev 4: `AI_GATEWAY_ID=default` as a var, so moving to a dedicated gateway later is config only). The server inherits `default`'s rules, which work on Free and Paid alike. pi and the server share that budget, so either one can trip the limit for both. |
| Free-quota error 4006 sometimes fires early | community reports | Harmless: early 4006 just means Jev serves sooner. |
| Remote MCP: stateless `createMcpHandler` from `agents/mcp/server`; `McpAgent` is deprecated; auth is checked in your own `fetch` | agents/api-reference/mcp-handler-api | Same as `memory-server`. |

## Complexity and the reason behind it

**3/5.** It's a greenfield Worker that follows conventions you already use in `memory-server` (Hono, `createMcpHandler`, D1 migrations, vitest, `cloudflare.config.ts` + `cf` CLI). Because Clef speaks Jev's schema, the hardest part of the design is gone, and using the quota error as the budget signal removes the meter. What's left with real moving parts: a deadline-bounded fallback chain and a live shadow comparison. Verification needs live Workers AI and Jev calls plus a ledger replay, and that's where most of the effort goes.

## Architectural changes required

A new repo at `/root/Code/decision-server` (`git init`, GitHub repo `PrashamTrivedi/decision-server`, public at the end, after the secrets audit).

```
src/
  index.ts            Hono app: /health, /v1/*, /mcp; bearer auth middleware
  schema.ts           zod: Jev request/response (questions, answers), headers
  router.ts           pure: (req, headers, budget, routeTable) → {tier, reason}
  providers/clef.ts   env.AI.run('@cf/cloudflare/clef*', {state, questions}) + timeout
  providers/jev.ts    fetch api.typesafe.ai/v1/systemone with the remaining deadline
  decide.ts           orchestrates route → call → fallback → log → shadow
  quota.ts            classify(err): spend-limit 2041 | quota 4006 | other; per-isolate skip-Clef flag
  sync.ts             scheduled(): purge logs > 30 days
  log.ts              D1 writes/reads
  mcp.ts              createMcpHandler: decide, budget, stats, recent_calls
  routes.ts           static decision→tier table (from the ledger mapping)
migrations/0001_init.sql   calls, shadow_pairs
scripts/replay.ts          ledger.jsonl → POST with X-Replay → agreement report
docs/agent-setup-prompt.md (exists)
```

Bindings: `AI` (every call sent through AI Gateway `env.AI_GATEWAY_ID` = `default`: `env.AI.run(model, input, { gateway: { id: env.AI_GATEWAY_ID } })`), `DB` (D1 `decisions-db`), daily cron for the purge, custom domain `decisions.prashamhtrivedi.app`. Secrets: `DECISIONS_TOKEN`, `TYPESAFE_API_KEY`.

## Backend changes required

Built in six specs, in order. Each spec ends deployable and tested. Details are in `specs/`.

| # | Spec | Ends with |
|---|---|---|
| 01 | Scaffold, auth, Jev passthrough | `POST /v1/systemone` proxies to Jev with `servedBy: "jev"`; `/health`; 401 on a bad token; deployed to the custom domain |
| 02 | Clef routing and fallback | Static route table, flash router for unknown types, omni for media, "either" escalation, deadline and `Promise.race`, any Clef error goes to Jev, total failure returns 502/504 |
| 03 | Budget via gateway | Clef through AI Gateway `default` (shared with pi, existing rules). 2041 → Jev and skip Clef 15 min; 4006 → Jev and skip until 00:00 UTC. `neurons` logged for stats only |
| 04 | Log, stats, shadow | D1 call log (full payloads); `/v1/budget`, `/v1/stats`, `/v1/calls`; 30-day purge; live shadow in `waitUntil` → `shadow_pairs` |
| 05 | Remote MCP | `/mcp` with `decide`, `budget`, `stats`, `recent_calls`; bearer check before the handler |
| 06 | Harness patch, replay, OSS hygiene | jev-harness endpoint/key config and `X-*` headers (`specs/06-harness-patch.md`); `scripts/replay.ts`; README; `.dev.vars.example`; secrets audit |

**Router order** (pure function, unit-tested):
1. A forced `model` (`flash`/`clef`/`omni`/`jev`) wins.
2. Audio, video or image in `state` → omni.
3. The isolate's skip-Clef flag is set (by a 2041 or 4006) → Jev (no wasted Clef attempt).
4. `X-Decision` is in the route table → its tier.
5. Unknown type → clef-flash answers one `choice` question ("which tier fits: flash / clef / jev") given the type, size and question kinds. That costs about 200 input tokens, roughly 0.7 neurons.
6. "Either" types run flash first, then escalate to clef if any choice or score `confidence < 0.6`, or any `noul` sits in a configurable ambiguity band (default 0.3–0.85), and only while at least 1,500 ms remain.

**Fail-safe:** the server never makes up answers. When everything fails it returns `502`, or `504` on deadline, and the harness's own `engine.ts:53-60` policy turns that into `ask` for safety decisions and `none` for the rest.

## Frontend changes required

None (no UI in v1).

## Acceptance Criteria

1. `POST /v1/systemone` accepts the exact Jev request body and returns a body the unmodified harness client parses (`answers`, `model`, `usage.input_tokens`), plus `servedBy`, `routeReason`, `neurons`, `ms`.
2. With the patched harness, known decision types route according to the static table. An unknown type goes through the flash router. Image or audio payloads go to omni.
3. When the gateway returns its spend-limit error (2041) or Workers AI returns its quota error (4006), that call is served by Jev within its deadline. Later calls in the same isolate skip Clef for 15 min (2041) or until 00:00 UTC (4006).
4. Any other Workers AI error or timeout falls back to Jev within the request's deadline. If Jev also fails, the response is 502/504 and never invented answers.
5. Every call is logged to D1 with full payload, route, model, tokens, neurons, latency and fallback reason. Rows older than 30 days are purged by cron.
6. `/v1/budget`, `/v1/stats`, `/v1/calls` and `/mcp` all reject a missing or wrong bearer token with 401. `/health` is public.
7. The remote MCP lists 4 tools that work from Claude Code via `claude mcp add --transport http`.
8. Live shadow: each free-served call is also sent to Jev in `waitUntil` while `SHADOW=on`, and both answers are stored.
9. The replay script runs about 1,000 ledger calls and reports per-decision agreement at the harness thresholds.
10. jev-harness with no `endpoint` set sends byte-identical requests to Jev, apart from the added `X-*` headers. With `endpoint` set, it uses the decision server.
11. The repo contains no secrets. It has `.dev.vars.example` and a README with setup steps, and `docs/agent-setup-prompt.md` passes against the live deployment.
12. `bun run typecheck` and `bun run test:run` are green.

## Validation

- **Unit (vitest):** router table cases (every ledger type, forced model, media, quota-hit flag, unknown, either-escalation), schema parsing, neuron math, deadline arithmetic, fallback chain with stubbed AI and Jev (Clef error, Clef timeout, quota error, Jev error, both fail → 502, deadline → 504).
- **Integration (`cf dev --local` or fakes):** auth 401/200 on every route; the quota flag resets at 00:00 UTC; D1 log row per call; purge job.
- **Live, after deploy:**
  - `curl /health` → 200.
  - Setup-prompt smoke calls: `ls -la` returns low `dangerous` and `rm -rf ~` returns high, both with `servedBy` set.
  - Force `model: "jev"` and check `servedBy: "jev"`.
  - Live spend-limit test: the spend-limit path is covered by stubbed tests using the exact 2041 body from pi's sessions. Tightening the shared `default` rule to force it would also lock pi, so that's skipped. The live 4006 can't be forced cheaply, so it's covered by stubbed tests.
  - `claude mcp add` then call `budget`.
- **Replay:** `bun scripts/replay.ts --limit 1000` reports at least 95% threshold-level agreement overall, broken down per decision. It runs locally, and the ledger never leaves the machine except as calls to your own server.
- **Latency:** p90 per tier from `/v1/stats`, compared against the `jev.db` baseline. You run the `jev.db` query yourself (it was blocked for me earlier).

## Out of scope

UI, multi-tenant, billing, the AWS port, a configurable fallback chain, applying calibration (v1 records pairs only), and syncing the harness patch into `/root/Code/CursorPlugin`.
