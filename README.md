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

Everything except `/health` needs `Authorization: Bearer $DECISIONS_TOKEN`.

## How a call is routed

1. Forced `model` (`flash`/`clef`/`omni`/`jev`) wins.
2. Embedded image/audio/video in `state` goes to `clef-omni`.
3. A skip-Clef flag (set by a gateway spend-limit error, code 2041, for 15 min, or a Workers AI free-quota error, 4006, until 00:00 UTC) goes straight to Jev.
4. `X-Decision` in the static table (`src/routes.ts`) picks flash or clef; "either" types run flash and escalate to clef when answers are ambiguous.
5. Unknown decision types ask `clef-flash` which tier fits.

Any Clef error, timeout, or incomplete answer falls back to Jev within the request deadline (`X-Deadline-Ms`, default 3800). If Jev fails too the server returns `502` (or `504` on deadline). It never invents answers.

## Setup

Uses the Cloudflare `cf` CLI (`cloudflare.config.ts`).

```bash
npm install
cp .dev.vars.example .dev.vars            # local dev secrets
npm run typecheck                         # cf workers types && tsc
npm run test:run

cf d1 create --name decisions-db          # put the returned id in cloudflare.config.ts (DB binding)
export DECISIONS_DB_ID=<that id>
npm run db:migrate                        # cf d1 migrations apply "$DECISIONS_DB_ID"

cf workers secrets update DECISIONS_TOKEN  --worker decision-server --text "$DECISIONS_TOKEN"
cf workers secrets update TYPESAFE_API_KEY --worker decision-server --text "$TYPESAFE_API_KEY"
npm run deploy                            # cf deploy; serves decisions.prashamhtrivedi.app
```

Config (`cloudflare.config.ts`): `AI_GATEWAY_ID` (default `default`, every Clef call goes through that AI Gateway, so its spend-limit rules are the budget), `SHADOW` (`on` sends each free-served call to Jev too and stores both answers), `RETENTION_DAYS` (30; a daily cron purges older rows). `AMBIGUITY_BAND` (e.g. `0.3,0.85`) can be added as a text binding to tune escalation.

Local dev: `npm run dev` (`cf dev`), `npm run db:migrate:local`.

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

Redeploy the previous commit (`git checkout <sha> && npm run deploy`), or create a deployment of an older Worker version with `cf workers deployments create`. For the harness side, remove `endpoint` from `~/.jev-harness/config.json`.

## License

MIT
