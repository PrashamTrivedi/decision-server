# decision-server

A Cloudflare Worker that answers [Jev](https://typesafe.ai)-format decision calls (`{model, state, questions}`) on **free Workers AI Clef models first** (`clef-flash`, `clef`, `clef-omni`) and falls back to Jev when the free budget is gone, a model fails, or the question is too important to risk. REST plus a stateless remote MCP server.

```
POST /v1/systemone   Jev-compatible; adds servedBy, routeReason, neurons, ms
GET  /v1/budget      today's usage, spend-limit/quota errors, skip-Clef flag
GET  /v1/stats       mix, fallbacks, p50/p90 per tier, free %, shadow disagreement
GET  /v1/calls       call log with full payloads
POST /mcp            tools: decide, budget, stats, recent_calls
GET  /health         public
```

Everything except `/` (service info) and `/health` needs `Authorization: Bearer $DECISIONS_TOKEN`.

## How a call is routed

1. Forced `model` (`flash`/`clef`/`omni`/`jev`) wins.
2. Embedded image/audio/video in `state` goes to `clef-omni`.
3. A skip-Clef flag (set by a gateway spend-limit error, code 2041, for 15 min, or a Workers AI free-quota error, 4006, until 00:00 UTC) goes straight to Jev.
4. `X-Decision` in the static table (`src/routes.ts`) picks flash or clef; "either" types run flash and escalate to clef when answers are ambiguous.
5. Unknown decision types ask `clef-flash` which tier fits.

Any Clef error, timeout, or incomplete answer falls back to Jev within the request deadline (`X-Deadline-Ms`, default 3800). If Jev fails too the server returns `502` (or `504` on deadline). It never invents answers.

**Budget.** Clef calls go through the AI Gateway named by `AI_GATEWAY_ID` (default `default`). That gateway's spend-limit rules are the budget, and there's no counter in the server. If other tools share the gateway, they share its limit: when one trips it, the server falls back to Jev, and the other tools are locked out until it resets. On a Workers Paid plan with no gateway rule, usage past the free 10k neurons is billed at $0.011 per 1,000 instead of returning an error.

**Media.** Embedded media goes only to `clef-omni`. On a Jev fallback the top-level `images`/`audio`/`videos` arrays are dropped, because Jev's API has no media fields. Calls with media are never shadowed. **Shadow.** With `SHADOW=on`, free-served calls are also sent to Jev in the background, and both answers are stored in `shadow_pairs` for the agreement stats.

## Setup

Uses the Cloudflare `cf` CLI (`cloudflare.config.ts`), with `@cloudflare/vite-plugin` (`vite.config.ts`) as the build backend.

```bash
bun install
cp .dev.vars.example .dev.vars            # fill in DECISIONS_TOKEN (e.g. openssl rand -hex 32) and TYPESAFE_API_KEY
bun run typecheck                         # cf workers types && tsc
bun run test:run                          # vitest (not `bun test`, which is bun's own runner)

cf d1 create --name decisions-db          # put the returned id in cloudflare.config.ts (DB binding)
export DECISIONS_DB_ID=<that id>
bun run db:migrate                        # cf d1 migrations apply "$DECISIONS_DB_ID"

# First deploy: the Worker doesn't exist yet, so its required secrets ship with the deploy.
bunx cf deploy --secrets-file .dev.vars   # serves decisions.prashamhtrivedi.app
# Later rotations: cf workers secrets update <NAME> --worker decision-server --text "$VALUE"
```

**Deploys after that come from git** (Workers Builds). Every push runs `bun run typecheck && bun run test:run`. On `main` it then runs `bun run deploy` to production. On any other branch it runs `bun run preview` (`cf previews deploy`), which publishes a Preview named after the branch. Previews share production's D1 and secrets.

Config (`cloudflare.config.ts`): `AI_GATEWAY_ID` (default `default`, every Clef call goes through that AI Gateway, so its spend-limit rules are the budget), `SHADOW` (`on` sends each free-served call to Jev too and stores both answers), `RETENTION_DAYS` (30; a daily cron purges older rows). `AMBIGUITY_BAND` (e.g. `0.3,0.85`) can be added as a text binding to tune escalation.

Local dev: `bun run dev` (`cf dev`), `bun run db:migrate:local`.

## Use it

```bash
curl -s -X POST "$DECISIONS_URL/v1/systemone" \
  -H "Authorization: Bearer $DECISIONS_TOKEN" -H "Content-Type: application/json" \
  -H "X-Decision: shell-safety" \
  -d '{"model":"auto","state":{"command":"ls -la"},"questions":{"dangerous":{"type":"noul","instructions":"Could this destroy data?"}}}'

claude mcp add --transport http decisions "$DECISIONS_URL/mcp" --header "Authorization: Bearer $DECISIONS_TOKEN"
```

Optional headers: `X-Decision`, `X-Mode`, `X-Agent`, `X-Session`, `X-Deadline-Ms`, `X-Replay` (tags the call as a replay and skips the live shadow). See `docs/agent-setup-prompt.md` for a paste-in agent setup.

## Replay (agreement check)

```bash
DECISIONS_TOKEN=... bun scripts/replay.ts --limit 1000
```

Reads logged calls locally from the harness `jev.db`, posts them with `X-Replay: 1`, and prints per-decision agreement with the logged Jev answers at the harness default thresholds. Nothing leaves your machine except calls to your own server.

## Rollback

Redeploy the previous commit (`git checkout <sha> && bun run deploy`), or create a deployment of an older Worker version with `cf workers deployments create`. For the harness side, remove `endpoint` from `~/.jev-harness/config.json`.

## License

MIT
