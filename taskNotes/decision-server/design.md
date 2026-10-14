# Design: How the Decision Server Works

Companion to `requirements.md`. Grounded in the harness code at `~/.claude/skills/jev-harness` (`core/client.ts`, `core/engine.ts`, `core/types.ts`, `mcp/server.ts`).

## Facts from the harness that shape the design

| Fact | Where | Consequence |
|---|---|---|
| The wire format is `POST {model, state, questions}` → `{answers, model, usage.input_tokens}` | `core/client.ts:62,86-91` | The REST endpoint mirrors this exactly. Extra response fields are safe because the client ignores them. |
| The request carries **no decision type or mode**. Those are only in local `CallMeta` | `core/db.ts:9-16` | The harness has to forward them as headers. That's a small patch, so it isn't URL-only. |
| `ENDPOINT` is a hardcoded constant | `core/client.ts:8` | Patch: make it configurable. |
| The whole hook gets **4,000 ms** for Jev work | `core/config.ts` `timeoutMs` | Routing, the free model and any Jev fallback all have to fit in about 3.5 s. |
| Answers are probabilities, and decisions apply thresholds of 0.5–0.85 | `decisions/*.ts` (e.g. `injection-screen.ts:20` at 0.85) | Free models have to return calibrated numbers, not labels. This is the biggest quality risk. |
| On a thrown error, safety decisions return `ask` and the rest return `none` | `core/engine.ts:53-60` | The server **never fakes answers**. On total failure it returns an HTTP error and the harness's existing fail-safe takes over. That covers both safety rules for free. |
| `jev-tools` MCP reads local files and runs local commands | `mcp/server.ts:36-95` | A remote MCP can't do that. Local file and command tools stay local and get repointed. |

## Components

```
 harness hooks ──┐                         ┌─► Workers AI: clef-flash (light)
 jev-tools (local MCP) ──► POST /v1/systemone ─► router ─┼─► Workers AI: clef main (heavy)
 any agent ──► /mcp (remote MCP) ──┘           │         ├─► Workers AI: omni (image/audio)
                                               │         └─► Jev (budget out / error / forced)
                          quota error (4006) ─► Jev
                                     D1 call log ◄┘   cron (daily): purge > 30 days
```

- **Worker** (Hono): REST and MCP on one domain, `decisions.prashamhtrivedi.app`.
- **Budget = an AI Gateway spend limit** (revised 2026-10-14, rev 3): Clef calls go through the existing `default` gateway (`AI_GATEWAY_ID`, shared with pi and its rules). The gateway answers `429 {code: 2041, "Spend limit exceeded…"}` (shape seen in pi's sessions) → Jev, and Clef is skipped for 15 min. The Workers AI free-quota error (4006) → Jev, and Clef is skipped until 00:00 UTC. There's no counter, and it works on Free and Paid plans.
- **Cron, daily**: purges log rows older than 30 days.
- **D1**: the call log (full payloads, 30-day retention purged by the same cron) plus shadow comparison pairs.
- **Secrets**: `DECISIONS_TOKEN` (inbound bearer), `TYPESAFE_API_KEY` (outbound to Jev).

## Routing: a recommended change from the PRD

The PRD has clef-flash route **every** call with a 200-token prompt. That prompt can only see metadata (decision type, size, question kinds), and the ledger already maps decision types to tiers. A model call that reproduces a lookup table costs neurons and about 300–800 ms of the 4 s budget for no gain.

**Proposed order:**
1. `model` field forced (`flash` / `clef` / `omni` / `jev`), used by replay and debugging → obey it.
2. Image or audio in `state` → omni.
3. The isolate's skip-Clef flag is set (2041: 15 min; 4006: until 00:00 UTC) → Jev.
4. `X-Decision` is in the **static route table** (the ledger mapping, stored in config) → that tier. Zero neurons.
5. Unknown or missing decision type (ad-hoc `ask_jev` / MCP `decide` calls) → **clef-flash router** with the ≤200-token prompt. This is where the router earns its place, and it's still a showcase feature.
6. "Either" types (`semantic-lint`, `subagent-router`) → flash first. If any answer has `confidence < 0.6`, escalate to clef main, as long as time allows.

**Deadline handling:** the client sends `X-Deadline-Ms` (the time it has left). The server gives the free model `deadline − 1,200 ms`. On timeout or error it falls to Jev with whatever remains. If nothing is left, it returns `504`.

## Clef speaks Jev's schema natively (updated 2026-10-14 after research)

`@cf/cloudflare/clef-flash`, `clef` and `clef-omni` take `{state, questions}` with the same noul/choice/score question types and return per-option probabilities. The server **passes `questions` through unchanged**. There's no prompt-to-JSON layer and no parsing of self-reported probabilities. The calibration risk drops to "a different model judging the same question": the shadow week still records `(free, jev)` answer pairs per decision, and any type whose disagreement near its harness threshold stays above 5% remains pinned to Jev. Applying a per-model correction is deferred past v1.

A missing answer id or an error (including the free-quota code 4006) is treated as a model failure and goes to Jev. The server never returns partial answers.

## REST API

All endpoints except `/health` require `Authorization: Bearer $DECISIONS_TOKEN`.

### `POST /v1/systemone`: the Jev-compatible decision call

Request body: identical to Jev, `{ "model": "jev-latest" | "auto" | "flash" | "clef" | "omni" | "jev", "state": ..., "questions": {...} }`. `jev-latest` and `auto` both mean "route it".

Optional headers (sent by the patched harness, all safe to omit):

| Header | Example | Use |
|---|---|---|
| `X-Decision` | `shell-safety` | Static route lookup and logging |
| `X-Mode` | `enforce` | Logging only. Mode is applied by the harness, never by the server |
| `X-Agent` / `X-Session` | `claude-code` / `abc123` | Logging |
| `X-Deadline-Ms` | `3800` | Time budget |
| `X-Replay` | `1` | Tags the call as a replay and skips the live shadow |

Response `200`:
```json
{
  "answers": { "dangerous": { "type": "noul", "noul": 0.04 } },
  "model": "clef-flash",
  "usage": { "input_tokens": 712 },
  "servedBy": "flash",
  "routeReason": "static:shell-safety",
  "neurons": 3.1,
  "ms": 640
}
```

Errors: `401` for a bad token, `400` when the body doesn't match the Jev schema, `502` when every model failed, `504` when the deadline ran out. The harness's existing error path turns all of them into `ask` for safety decisions and `none` for the rest. The server never returns `429` for its own budget, because running out of budget only reroutes.

### `GET /v1/budget`
Informational only: `{ "day": "2026-10-14", "serverNeurons": 6120, "freeTier": 10000, "spendLimitErrors": 0, "quotaErrors": 0, "lastLimitAt": null, "skipClefUntil": null, "resetsAt": "2026-10-15T00:00:00Z" }`. `serverNeurons` counts this server only, not the account.

### `GET /v1/stats?days=1`
Model mix (`servedBy` counts and shares), fallback counts by reason, p50 and p90 latency by tier, the free-served percentage, and the shadow disagreement rate by decision type.

### `GET /v1/calls?decision=&servedBy=&since=&limit=50`
Paged call log **including full payloads**, behind the token. Used for debugging misroutes.

### `GET /health`
Unauthenticated `{ ok: true, version }`, used by the setup smoke test.

## Remote MCP (`/mcp`, streamable HTTP)

This is for agents that don't run the harness: other machines, claude.ai, Cursor without hooks, open-source users. It works on content only and can't read local files.

| Tool | Input | Output |
|---|---|---|
| `decide` | `questions_json`, `state` (string), `decision?` | Answers plus `servedBy`, `routeReason`. Same question syntax as `jev-tools`. |
| `budget` | none | Same as `GET /v1/budget` |
| `stats` | `days?` | Compact text summary of `/v1/stats` |
| `recent_calls` | `decision?`, `limit?` (≤20) | Metadata rows. Payloads are **truncated to 200 chars** to protect the caller's context; the full rows are in REST. |

Auth uses the same bearer header. OAuth is skipped because there's a single user.

**Local `jev-tools` stays as it is.** `ask_jev_file`, `ask_jev_files`, `pick_first_file` and `ask_jev` need the local filesystem and shell. They already go through `core/client.ts`, so once the endpoint patch is in, they're served by the decision server automatically.

## Harness patch (in `jev-harness`, about 20 lines)

1. `config.json` gets `"endpoint"` (default: the Jev URL) and `"apiKeyName"` (default `TYPESAFE_API_KEY`). `client.ts` reads both instead of the constants.
2. `send()` forwards `opts.meta.decision`, `mode`, `agent` and `sessionId` as `X-*` headers, plus `X-Deadline-Ms`.
3. Nothing else changes. Without the headers the server still works, but every call goes through the flash router.

Rollback is removing `endpoint` from `config.json`.

## Rollout

1. Deploy. Patch the harness with every decision still in shadow mode.
2. Replay about 1,000 ledger calls locally: a script posts `{state, questions}` with `X-Replay: 1` and `model: auto`, then compares the answers with the ledger's Jev answers **at each decision's thresholds** rather than on raw values.
3. Live shadow week. For free-served calls, the server calls Jev in `waitUntil` and stores both answers.
4. Move decision types from Jev to free one at a time, using the per-type disagreement figures in `/v1/stats`.

## Open technical questions

- ~~Model IDs and neuron rates~~ resolved: `@cf/cloudflare/clef-flash` 3,455, `clef` 21,818, `clef-omni` 13,636 neurons per 1M input tokens; output is free.
- The exact shape of the quota error (code 4006 and its message) from the AI binding.
- ~~Logprobs~~ not needed, since Clef returns per-option probabilities.
