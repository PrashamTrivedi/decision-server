# PRD: decisions.prashamhtrivedi.app (v1, 2026-10-14)

## Problem
Jev harness decisions cost money on every call, while Cloudflare Workers AI's free 10k neurons a day go unused. Build one endpoint that answers on free Clef models first and falls back to Jev when the free budget runs out.

## Users and scope
Prasham only, single user. Open source repo. Not a studio product for now.

## Goals
Most calls served for free. Quality holds on heavy decision types. Nothing fails when the budget runs out.

## Flow
1. Request comes in: decision type, payload, mode (shadow or enforce), token estimate.
2. Flash routes every call. clef-flash picks the model: flash (answers itself), clef main, or jev. The routing prompt is capped at about 200 tokens.
3. Omni is used only for image or audio payloads (for example, screenshot-gate).
4. Budget meter overrides the router. Track neurons against the 10k/day free tier, which resets at 00:00 UTC (05:30 IST), with a cutoff around 9.5k. Past the cutoff, every call goes to Jev.
5. Fallback to Jev also happens on a Workers AI error or timeout.
6. Response uses the same schema as Jev, plus servedBy (flash/clef/omni/jev), tokens and routeReason.

## Functional requirements
- Drop-in replacement for the Jev endpoint, so the harness only changes its URL.
- One bearer token, stored as a Worker secret.
- Log every call to D1: type, router pick, model served, tokens, neurons, latency, fallback reason.
- GET /stats: budget left today, model mix, fallback count.
- Pass shadow/enforce through unchanged. A fallback never makes a decision more lenient.

## Non-functional requirements
- p90 latency no worse than Jev today. Get the baseline from jev.db.
- Fail safe: if every model fails on an enforce type, return block/ask, never allow.
- Stack: Cloudflare Worker, Workers AI binding, D1, and a Durable Object or KV counter for the budget.
- Also ship an AWS version (Lambda + Bedrock) per the Cloudflare-tools rule.
- Open source hygiene: no secrets in the repo, .dev.vars.example, README with setup steps.

## Success metrics (targets, not gates)
- At least 80% of calls served free.
- Jev spend down 70% or more.
- Decisions match Jev on at least 95% of a replayed ledger.jsonl sample.
- Router accuracy checked against the ledger-based mapping:
  - flash: shell-safety, outbound-leak, loop-detector, compact-advisor, promise-continue, failure-triage
  - clef: read-budget, mcp-trim, memory-hygiene, injection-screen, ask_jev_file
  - either: semantic-lint, subagent-router

## Baseline (ledger, Oct 3-14)
2,740 calls, 5.09M input tokens, median 704 tokens per call. Jev bills about $0.0385 per million input tokens, and output is free.

## Risks
- Routing calls burn neurons. Mitigation: tiny prompt, short output.
- Flash misroutes heavy calls. Mitigation: catch it in the ledger replay.
- The neuron count is an estimate. Mitigation: safety margin.

## Out of scope for v1
UI, multi-tenant, billing, studio productization.

## Validation plan
Replay about 1,000 ledger calls through the router and compare against Jev decisions before switching enforce types over.
