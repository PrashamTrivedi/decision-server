# Specs: decision-server v1

Build in this order. Each spec ends deployable, with its tests green.

| # | File | Depends on | Size |
|---|---|---|---|
| 01 | `01-scaffold-passthrough.md` | none | S |
| 02 | `02-clef-routing.md` | 01 | M |
| 03 | `03-gateway-budget.md` | 02 | S |
| 04 | `04-log-stats-shadow.md` | 02, 03 | M |
| 05 | `05-remote-mcp.md` | 02, 04 | S |
| 06 | `06-harness-patch.md` | 01 (live URL) | S |

06 can run in parallel with 02–05, because it only needs the passthrough contract from 01.
