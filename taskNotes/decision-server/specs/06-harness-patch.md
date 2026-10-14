# 06: Harness patch (jev-harness side; spec of decision-server v1)

Let the live jev-harness send its Jev calls to a configurable endpoint (the decision server), and forward per-call decision metadata as headers, without changing the default behaviour.

## Original Ask

> jev-endpoint-patch: Patch the live jev-harness at ~/.claude/skills/jev-harness so it can talk to the decision server. (1) config.json gets optional "endpoint" (default https://api.typesafe.ai/v1/systemone) and "apiKeyName" (default TYPESAFE_API_KEY); core/client.ts reads them instead of constants. (2) send() forwards opts.meta decision/mode/agent/sessionId as X-Decision/X-Mode/X-Agent/X-Session headers plus X-Deadline-Ms (remaining ms). No other behavior change; default config = identical requests to Jev. Spec: /root/Code/decision-server/taskNotes/decision-server/design.md "Harness patch" section.

## Complexity and the reason behind it

**1/5.** Two files get small additive edits (`core/config.ts`, `core/client.ts`) and one test file is added. Nothing changes structurally. The only real risk is that this harness runs on every hook in the current session, and it isn't under git.

## Architectural changes required

None. `HarnessConfig` gets two optional fields.

## Backend changes required

**Target:** `~/.claude/skills/jev-harness` (the live, central install. It is newer than `/root/Code/CursorPlugin/skills/jev-harness`, and it is not a git repo).

0. **Backup first:** copy `core/client.ts` and `core/config.ts` to `~/.jev-harness/backups/jev-endpoint-patch-2026-10-14/` (that `backups/` folder already exists).
1. `core/config.ts`
   - Add `endpoint: string` and `apiKeyName: string` to `HarnessConfig`.
   - Add the defaults `endpoint: "https://api.typesafe.ai/v1/systemone"` and `apiKeyName: "TYPESAFE_API_KEY"` to `DEFAULTS`. The existing `{...DEFAULTS, ...user}` merge then handles overrides.
2. `core/client.ts`
   - Replace the `ENDPOINT` constant with `loadConfig().endpoint`.
   - `secret(loadConfig().apiKeyName)`. The "not set" error message names whichever key is configured.
   - In `send()`, build the headers: `Authorization` and `Content-Type` as before, plus `X-Decision`, `X-Mode`, `X-Agent` and `X-Session` from `opts.meta`, each **only when present**, and `X-Deadline-Ms` set to `remaining` (rounded), recomputed on each attempt so the 429 retry sends the time actually left.
   - The body, the retry logic, the response parsing and the fake mode stay as they are.
3. `tests/client.test.ts` (new): uses a temp `JEV_HARNESS_HOME` and a stubbed `globalThis.fetch`, the same pattern as `tests/deploy-preflight.test.ts`.

**Default request shape:** the URL, body and auth header stay identical. The only addition is the `X-*` headers. Jev ignores unknown headers, though that's an assumption, and the live check below confirms it.

## Frontend changes required

None.

## Acceptance Criteria

Complexity ≤ 2: the criterion is complete satisfaction of the Original Ask. Concretely:
- With no `endpoint`/`apiKeyName` in config, requests go to the Jev URL with `TYPESAFE_API_KEY`, and the body is unchanged.
- With them set, requests go to the configured URL using the configured secret.
- `X-Decision`/`X-Mode`/`X-Agent`/`X-Session` appear exactly when the matching meta field is set. `X-Deadline-Ms` is always present and no larger than `timeoutMs`.
- `bun test` and `bun run typecheck` pass.

## Validation

- `cd ~/.claude/skills/jev-harness && bun test && bun run typecheck`
- New tests: default URL and key, overridden URL and key, header presence and absence, deadline header ≤ the deadline, missing-key error naming the configured key.
- Live smoke test (real Jev, default config): one `ask_jev` MCP call or hook-triggered decision succeeds, and the newest row in `jev.db` has `status = ok`.
- Rollback: copy the two files back from the backup directory.

## Out of scope

- Syncing the patch into `/root/Code/CursorPlugin/skills/jev-harness`. That copy has already drifted (missing `hud.ts`, `deploy-preflight.ts`, `repo-state.ts`), so the sync is a separate task.
- Changing `~/.jev-harness/config.json`. Nothing gets pointed at the decision server until the server exists.

## Also in spec 06 (decision-server repo)

- `scripts/replay.ts`: reads `~/.jev-harness/ledger.jsonl` locally, posts `{state, questions}` with `X-Decision` and `X-Replay: 1`, and compares the answers with the logged Jev answers at each decision's harness thresholds. It prints per-decision agreement. Ledger content stays local.
- README (setup, secrets, deploy, rollback), `.dev.vars.example`, a secrets audit (`git grep` for key patterns) before making the repo public.
- Run `docs/agent-setup-prompt.md` against the live deployment and fix any drift.
