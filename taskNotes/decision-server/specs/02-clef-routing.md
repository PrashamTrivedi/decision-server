# 02: Clef routing and fallback

**Goal:** most calls are served by `@cf/cloudflare/clef-flash` / `clef` / `clef-omni`, and nothing gets more lenient on failure.

- `src/routes.ts`: the static table. flash: shell-safety, outbound-leak, loop-detector, compact-advisor, promise-continue, failure-triage. clef: read-budget, mcp-trim, memory-hygiene, injection-screen, ask_jev_file. either: semantic-lint, subagent-router.
- `src/router.ts`: a pure function implementing the router order in taskFindings (forced model → media → quota-hit flag → table → flash router → either-escalation). It returns `{tier, reason}`.
- `providers/clef.ts`: `env.AI.run(modelId, {state, questions})` wrapped in `Promise.race` against `deadline − 1,200 ms`. The router itself is one `choice` question to clef-flash.
- Media detection: base64 or data-URL images and audio in `state` → omni. Check the field names against Clef docs; media must be embedded, not passed as URLs.
- `decide.ts`: on any Clef error, timeout, 4006 or missing answer id, fall back to Jev with the time remaining. If Jev fails too, return 502/504. Never return partial or invented answers.
- Response: `model` is the actual Clef or Jev model, `servedBy` is the tier, plus `routeReason`.

**Done when:** unit tests cover every row of the route table and every fallback branch with stubbed AI and Jev, and the live smoke calls are served by flash.
