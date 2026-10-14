# scripts/

- `replay.ts` runs locally with bun and reads `~/.jev-harness/jev.db` at runtime. Never copy ledger or `jev.db` content into the repo, tests or fixtures, because it holds real commands and file contents.
- Replay requests always send `X-Replay: 1`, so they skip the live shadow. Agreement excludes Jev-served calls.
