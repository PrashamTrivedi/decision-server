# Agent Setup Prompt

Paste everything below the line into Claude Code, Cursor or Antigravity. Before you paste, put your token in the environment: `export DECISIONS_TOKEN=...` (fish: `set -gx DECISIONS_TOKEN ...`). It's a single-line secret, so never paste the token into the chat.

---

Set up this machine to use my decision server. Work through the steps in order. Verify each step before moving to the next, and stop and report if a step fails.

**Server:** `DECISIONS_URL=https://decisions.prashamhtrivedi.app` (if I've set `DECISIONS_URL` in the environment, use that instead).
**Token:** in the `DECISIONS_TOKEN` environment variable. Never print it, echo it, write it into chat, or commit it. Only reference it as `$DECISIONS_TOKEN` or write it to the credential files named below.

### 1. Preflight
- `curl -s -H "Authorization: Bearer $DECISIONS_TOKEN" $DECISIONS_URL/health` must return `{"ok":true,...}`. `/health` needs the bearer header now; without it you get 401.
- `curl -s -H "Authorization: Bearer $DECISIONS_TOKEN" $DECISIONS_URL/v1/budget` must return HTTP 200 with a `serverNeurons` field. A 401 means the token is wrong, so stop.
- Check whether jev-harness is installed: `~/.jev-harness/config.json` exists, or `~/.claude/skills/jev-harness` exists. **If it's installed, do step 2. If not, skip to step 3.**

### 2. Point jev-harness at the decision server (harness users only)
- Confirm the harness supports a configurable endpoint: `grep -n '"endpoint"\|cfg.endpoint\|loadConfig().endpoint' ~/.claude/skills/jev-harness/core/client.ts`. If nothing matches, the harness is older than the endpoint patch. Stop and tell me. Don't patch it yourself.
- Back up `~/.jev-harness/config.json` to `config.json.bak-<date>`, then merge in these keys without touching the rest of the file:
  ```json
  { "endpoint": "https://decisions.prashamhtrivedi.app/v1/systemone", "apiKeyName": "DECISIONS_TOKEN" }
  ```
- Add `DECISIONS_TOKEN=<value of $DECISIONS_TOKEN>` to `~/.jev-harness/credentials` (create it with mode `600` if it's missing). Keep any existing `TYPESAFE_API_KEY` line, since rollback needs it.
- Do **not** change any decision's `mode`. Shadow/enforce settings stay as they are.

### 3. Register the remote MCP server for the agent you're running in
Name the server `decisions`. Use the URL `$DECISIONS_URL/mcp`. Without a header it uses OAuth (you log in through the browser once); the header variant `Authorization: Bearer <token>` is the non-interactive option.
- **Claude Code:** `claude mcp add --transport http --scope user decisions "$DECISIONS_URL/mcp"` (OAuth; then run `/mcp` in Claude Code and authenticate in the browser), or with the key: `claude mcp add --transport http --scope user decisions "$DECISIONS_URL/mcp" --header "Authorization: Bearer $DECISIONS_TOKEN"`, then `claude mcp list` should show `decisions` as connected.
- **Cursor:** merge into `~/.cursor/mcp.json` under `mcpServers`: `"decisions": { "url": "<DECISIONS_URL>/mcp", "headers": { "Authorization": "Bearer <token>" } }`.
- **Antigravity:** find its MCP config file (usually `~/.gemini/antigravity/mcp_config.json`, but check before writing to it) and add the same entry in the format that file already uses.
- If the agent's config file holds the token in plain text, tell me which file it's in.

### 4. Smoke test
Send one known-safe and one known-dangerous decision, with replay tagging so they don't count as live traffic:
```bash
curl -s -X POST "$DECISIONS_URL/v1/systemone" \
  -H "Authorization: Bearer $DECISIONS_TOKEN" -H "Content-Type: application/json" \
  -H "X-Decision: shell-safety" -H "X-Replay: 1" \
  -d '{"model":"auto","state":{"command":"ls -la"},"questions":{"dangerous":{"type":"noul","instructions":"Could this command destroy data or leak secrets?"}}}'
```
Repeat with `"command":"rm -rf ~"`. Expected: `dangerous` is below 0.3 for `ls` and above 0.7 for `rm -rf ~`, and both responses include `servedBy` and `routeReason`.
- If the MCP server was registered, call its `budget` tool once and confirm it answers.
- Harness users: trigger a harmless shell command in this session, then confirm a new row appears in `GET /v1/calls?limit=1` with `X-Decision` filled in. An empty decision means the header forwarding patch is missing.

### 5. Report
Reply with a short table covering each step (pass or fail), `servedBy` and latency for both smoke calls, today's usage (`serverNeurons`, `spendLimitErrors`, `quotaErrors`), every file you changed, and the rollback command:
`mv ~/.jev-harness/config.json.bak-<date> ~/.jev-harness/config.json` plus removing the `decisions` MCP entry.
