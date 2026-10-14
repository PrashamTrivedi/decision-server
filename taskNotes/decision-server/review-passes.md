# Review passes: decision-server v1

| Pass | Level | Reviewer | Findings | Notes |
|---|---|---|---|---|
| 1 | max | security-code-reviewer + orchestrator | 11 | 9 from the reviewer (M1–M3, L1–L6), plus 2 from the orchestrator: MCP decision names are `mcp:<tool>`, so `ask_jev_file` never matched the table; `screenshot-gate`, `deploy-preflight` and `mcp:command-gate` were missing. Auth, SQL and secrets were clean. |
| 2 | high | security-code-reviewer | 3 | 10 of 11 confirmed FIXED; L6 partial. New: N1, Jev fallback forwarded Clef-only media arrays (Jev API has no media fields); N2, internal error text leaked to clients; N3, L5/L6 tests didn't exercise their code paths. |
| 3 | high | orchestrator (36-line diff) | 0 | N1: `images`/`audio`/`videos` stripped before forwarding, model still forced. N2: generic `internal error` to the client, detail in `console.error` and the D1 row. N3: L6 test throws inside `decide()`, L5 test stalls the body until abort → 504. 122/122 tests ×5, type-check 0. **Stop: zero findings.** |
