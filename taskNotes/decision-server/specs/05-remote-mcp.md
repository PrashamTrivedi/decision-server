# 05: Remote MCP

**Goal:** agents without the harness can use the server.

- `/mcp` through `createMcpHandler` from `agents/mcp/server` (stateless, the same as `memory-server`), with the bearer check in Hono before the handler.
- Tools:
  - `decide(questions_json, state, decision?)`: calls `decide.ts` and returns answers, `servedBy` and `routeReason`.
  - `budget()`
  - `stats(days?)`: compact text.
  - `recent_calls(decision?, limit≤20)`: metadata, payloads truncated to 200 chars.
- Tool descriptions reuse the question syntax from jev-tools' `PREAMBLE`.

**Done when:** `claude mcp add --transport http decisions <url>/mcp --header ...` connects and all 4 tools return.
