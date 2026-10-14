# AGENTS.md

A Cloudflare Worker that answers Jev-format decision calls (`{model, state, questions}`) on free Workers AI Clef models and falls back to Jev. It serves REST (`/v1/*`) and a stateless remote MCP (`/mcp`). Human docs are in `README.md`, and the design and its reasoning are in `taskNotes/decision-server/`.

## Commands

```bash
bun install
bun run typecheck      # cf workers types && tsc --noEmit
bun run test:run       # vitest. Not `bun test`, which is bun's own runner
bun run dev            # cf dev
```

- The package manager is bun (`bun.lock`). Never add `package-lock.json`.
- Tooling is the Cloudflare `cf` CLI with `cloudflare.config.ts`, built through `@cloudflare/vite-plugin` (`vite.config.ts`). Never add `wrangler.jsonc`.

## Directories

`src/` Worker code · `test/` vitest suite · `scripts/` local replay tooling · `migrations/` D1 schema · `docs/` agent setup prompt · `taskNotes/` plans and validation records.

Cursor Cloud Agents use `.cursor/environment.json` (image `cursor-dev-setup:v1.4.0`; secrets `DECISIONS_TOKEN`, `TYPESAFE_API_KEY` in the Cursor dashboard). Each pushed branch also gets a Worker Preview at `https://<branch-slug>-decision-server.dev-286.workers.dev`.

## Conventions

- TypeScript strict, Hono, zod 4.
- Commits are one-line conventional commits with an emoji (`✨ feat: …`, `🐛 fix: …`).
- This repo is public. Never commit `.dev.vars`, tokens, account IDs or ledger data. `.dev.vars.example` holds placeholders only.

## Ask before

**Pushing to `main` deploys to production** (Workers Builds). Ask before pushing there. The same goes for anything else that touches live Cloudflare resources: `cf deploy`, `cf d1 …` without `--local`, `cf workers secrets …`, or AI Gateway rules. The `default` gateway is shared with other tools, and tightening its spend limit locks them out too.
