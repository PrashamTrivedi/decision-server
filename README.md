# decision-server

A Cloudflare Worker that answers [Jev](https://typesafe.ai)-format decision calls (`{model, state, questions}`) on **free Workers AI Clef models first** (`clef-flash`, `clef`, `clef-omni`) and falls back to Jev when the free budget is gone, a model fails, or the question is too important to risk. REST plus a stateless remote MCP server.

```
POST /v1/systemone   Jev-compatible; adds servedBy, routeReason, neurons, ms
GET  /v1/budget      today's usage, spend-limit/quota errors, skip-Clef flag
GET  /v1/stats       mix, fallbacks, p50/p90 per tier, free %, shadow disagreement
GET  /v1/calls       call log with full payloads
POST /mcp            tools: decide, budget, stats, recent_calls
GET  /health         needs auth (see below)
GET  /visualize      dashboard (Access login)
```

## Auth

The whole host sits behind Cloudflare Access, and the Worker checks credentials itself. Three ways in:

1. **Decision key** (machines): `Authorization: Bearer $DECISIONS_TOKEN` works on every route.
2. **Cloudflare Access login** (browser): `/`, `/health`, `/visualize` and `/v1/*` accept a valid Access JWT (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie), verified against `https://$ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs` (RS256, `iss`, `aud` = `ACCESS_AUD`). If `ACCESS_AUD` is empty or still `REPLACE_WITH_ACCESS_AUD`, this path is off and only the decision key works.
3. **MCP OAuth** (`/mcp` only): the server is its own OAuth authorization server (dynamic client registration, PKCE S256). `/oauth/authorize` requires the Access login, so approving a client means logging in. Access and refresh tokens are opaque, hashed in D1 (migration `0002_oauth.sql`); access tokens last 1h, refresh tokens 30 days and rotate. They are rejected on `/v1/*`.

Set up Access once: `OWNER_EMAIL=you@example.com bash scripts/setup-access.sh` creates the owner-only whole-host app plus a Bypass app for `/v1`, `/mcp`, `/oauth/token`, `/oauth/register` and `/.well-known`, and prints the `ACCESS_AUD` to put in `cloudflare.config.ts`. No new secrets; just apply the D1 migration before deploying.

## How a call is routed

1. Forced `model` (`flash`/`clef`/`omni`/`jev`) wins.
2. Embedded image/audio/video in `state` goes to `clef-omni`.
3. A skip-Clef flag (set by a gateway spend-limit error, code 2041, for 15 min, or a Workers AI free-quota error, 4006, until 00:00 UTC) goes straight to Jev.
4. `X-Decision` in the static table (`src/routes.ts`) picks flash or clef; "either" types run flash and escalate to clef when answers are ambiguous.
5. Unknown decision types ask `clef-flash` which tier fits.

Any Clef error, timeout, or incomplete answer falls back to Jev within the request deadline (`X-Deadline-Ms`, default 3800). If Jev fails too the server returns `502` (or `504` on deadline). It never invents answers.

**Budget.** Clef calls go through the AI Gateway named by `AI_GATEWAY_ID` (default `default`). That gateway's spend-limit rules are the budget, and there's no counter in the server. If other tools share the gateway, they share its limit: when one trips it, the server falls back to Jev, and the other tools are locked out until it resets. On a Workers Paid plan with no gateway rule, usage past the free 10k neurons is billed at $0.011 per 1,000 instead of returning an error.

**Issues.** Workers Issues is enabled (`observability.issues`). Hitting the spend limit or free quota only logs a `console.warn`. When the gateway limit blocks Clef and Jev also fails (or its circuit is open), the server logs `BothDownError` ("both-down: clef spend-limit + jev unavailable") via `console.error`, whether the paid emergency Clef call rescued the request or a 502/504 was returned. A tripped Jev circuit breaker logs `JevCircuitOpenError`. Messages are fixed so occurrences group into one Issue each; details (status, decision, tier) are attached as the second argument.

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

# MCP with OAuth (browser login via Access, no key stored):
claude mcp add --transport http decisions "$DECISIONS_URL/mcp"
# or with the decision key:
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
