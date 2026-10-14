# 01: Scaffold, auth, Jev passthrough

**Goal:** a deployed Worker that is a transparent Jev proxy behind your own bearer token.

- `git init`. Copy `memory-server` conventions: Hono, zod 4, vitest, `wrangler.jsonc` (`nodejs_compat`, observability), npm scripts `dev`/`deploy`/`type-check`/`test:run`/`cf-typegen`.
- `src/schema.ts`: zod for the Jev request `{model, state, questions}` (noul/choice/score) and the answers. Keep it permissive (`passthrough`) so new Jev fields don't break the server.
- Auth middleware: `Authorization: Bearer` compared in constant time against `DECISIONS_TOKEN`. `/health` is exempt.
- `POST /v1/systemone`: validate, call `providers/jev.ts` with the remaining deadline (`X-Deadline-Ms`, default 3,800 ms), return the Jev body plus `servedBy: "jev"`, `routeReason: "passthrough"`, `neurons: 0`, `ms`.
- Errors: 400 for schema problems, 401 for auth, 502 when Jev fails, 504 on deadline.
- Custom domain `decisions.prashamhtrivedi.app` in `wrangler.jsonc`. Set the secrets with `wrangler secret put`.

**Done when:** the unmodified harness client body works against the deployed URL, and the tests cover auth, schema and error mapping.
