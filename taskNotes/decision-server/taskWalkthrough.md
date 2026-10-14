# Walkthrough: decision-server v1

Backend only. Every step is a shell command. `$DECISIONS_URL` is `https://decisions.prashamhtrivedi.app` once deployed, or the `cf dev` URL locally.

## 1. Setup (one-time)

```bash
cd /root/Code/decision-server
bun install
bun run typecheck                            # cf workers types && tsc
bun run test:run                             # expect: Tests 122 passed

cf auth login                                # if not already logged in
cf d1 create --name decisions-db             # copy the returned id into cloudflare.config.ts (DB binding)
export DECISIONS_DB_ID=<that id>
bun run db:migrate                           # applies migrations/0001_init.sql (calls, shadow_pairs)

# cf has no interactive prompt for secrets (checked with --help). Pass env vars so the literal value stays out of shell history.
cf workers secrets update DECISIONS_TOKEN  --worker decision-server --text "$DECISIONS_TOKEN"
cf workers secrets update TYPESAFE_API_KEY --worker decision-server --text "$TYPESAFE_API_KEY"
bun run deploy                               # cf deploy, custom domain decisions.prashamhtrivedi.app
```

The `AI_GATEWAY_ID` var is already set to `default`, which is shared with pi and its spend rules. The gateway itself needs no setup.

## 2. Verify end to end

```bash
export DECISIONS_URL=https://decisions.prashamhtrivedi.app

# Public health check
curl -s $DECISIONS_URL/health                                   # {"ok":true,"version":...}

# Auth: every other route rejects a missing or bad token
curl -s -o /dev/null -w '%{http_code}\n' $DECISIONS_URL/v1/budget                       # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST $DECISIONS_URL/mcp                     # 401

# Static route to flash: safe command
curl -s -X POST $DECISIONS_URL/v1/systemone \
  -H "Authorization: Bearer $DECISIONS_TOKEN" -H "Content-Type: application/json" \
  -H "X-Decision: shell-safety" -H "X-Replay: 1" \
  -d '{"model":"auto","state":{"command":"ls -la"},"questions":{"dangerous":{"type":"noul","instructions":"Could this command destroy data or leak secrets?"}}}' | jq '{answers,servedBy,routeReason,ms}'
# expect: servedBy "flash", routeReason "static:shell-safety", dangerous.noul < 0.3

# Same call with a dangerous command
#   ... "state":{"command":"rm -rf ~"} ...   expect dangerous.noul > 0.7

# Forced Jev, which also checks the passthrough contract
#   ... "model":"jev" ...                    expect servedBy "jev", model "jev-*"

# Unknown decision type goes through the flash router
#   -H "X-Decision: something-new"           expect routeReason "router:<tier>"

# Budget, stats and the call log
curl -s -H "Authorization: Bearer $DECISIONS_TOKEN" $DECISIONS_URL/v1/budget | jq
curl -s -H "Authorization: Bearer $DECISIONS_TOKEN" "$DECISIONS_URL/v1/stats?days=1" | jq
curl -s -H "Authorization: Bearer $DECISIONS_TOKEN" "$DECISIONS_URL/v1/calls?limit=3" | jq '.[] | {decision,served_by,fallback_reason,latency_ms}'

# Remote MCP
claude mcp add --transport http --scope user decisions "$DECISIONS_URL/mcp" --header "Authorization: Bearer $DECISIONS_TOKEN"
claude mcp list                              # decisions: connected; then call its `budget` tool
```

## 3. What to verify

| Check | Where | Expected |
|---|---|---|
| One row per call | `/v1/calls` or `cf d1 execute decisions-db --command "select count(*) from calls"` | The count goes up by 1 for every call above, including the forced-Jev and 4xx-free error calls |
| Replay calls don't shadow | `select count(*) from shadow_pairs` | 0 for `X-Replay: 1` calls, and 0 while `SHADOW=off` |
| Budget errors route to Jev | `/v1/calls?servedBy=jev` | `fallback_reason` is `spend-limit` or `quota` if the gateway or free tier trips. It can't be forced live without locking pi too, so it's covered by stubbed tests in `test/quota.test.ts` and `test/decide.test.ts` |
| Fail-safe | (tests) `decide.test.ts` "Clef and Jev both fail -> 502" | The status is 502/504 and the body has no `answers` |
| Retention | after the 03:00 UTC cron | No `calls` rows older than `RETENTION_DAYS` (30) |

## 4. Harness switch-over (only after the replay passes)

```bash
bun scripts/replay.ts --limit 1000           # reads ~/.jev-harness/jev.db locally; reports per-decision agreement, excluding Jev-served calls
# Then merge into ~/.jev-harness/config.json:
#   { "endpoint": "https://decisions.prashamhtrivedi.app/v1/systemone", "apiKeyName": "DECISIONS_TOKEN" }
# and add DECISIONS_TOKEN=... to ~/.jev-harness/credentials. Keep every decision in shadow mode for the live shadow week (set SHADOW=on).
```

Rollback: remove `endpoint` from `~/.jev-harness/config.json`, and the harness talks to Jev directly again.
