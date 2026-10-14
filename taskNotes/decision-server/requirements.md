# Requirements: Decision Server (decisions.prashamhtrivedi.app) — v1

Finalized 2026-10-14 from the raw PRD in `../../requirements.md` after brainstorming.

## Why this exists

Ranked by what matters:

1. **Less dependence on Jev.** The harness should keep making good decisions even if Jev's pricing, limits or availability change. Jev becomes a fallback, not the default.
2. **Open-source showcase.** A public, reusable reference for "free tier first, paid fallback" decision routing, worth writing up.
3. **Cost at future scale.** Today Jev costs about $0.50/month (5.09M input tokens over 12 days at $0.0385/M), so savings are not a reason on their own. They matter if call volume grows 10–100×.

Latency is not a driver. It only has to stay no worse than today.

## Users and scope

- Single user (Prasham). Open-source repo. Not a studio product.
- Out of scope for v1: UI, multi-tenant, billing, studio productization, the AWS version.

## What it does

1. The harness sends each decision to one endpoint that speaks Jev's format. The harness side needs a small change: a configurable endpoint, and passing the decision type and mode along, which Jev never needed. Removing that one setting rolls back to Jev.
1a. The same server is also offered as a remote MCP server, so agents without the harness can ask for decisions, check the budget and see stats.
2. Every call is triaged by a small, cheap model. It either answers on its own (light decision types), passes the call to a stronger free model (heavy types), or sends it to Jev.
3. Calls with image or audio payloads go to the multimodal model. No harness decision sends media today. screenshot-gate only sends text about the screenshot request, so it uses the light model. Media can only come from ad-hoc or MCP calls. When such a call falls back to Jev, Jev gets the original request unchanged, and media calls are never shadowed.
4. For now the server shares pi's existing daily spending limit on Cloudflare. Either one can use up the shared limit for both, and a separate limit can come later. When Cloudflare says that limit or the account's free allowance is used up, calls go to Jev until it frees up again.
5. The server doesn't keep its own budget count. Cloudflare's limit is the measure, and it works the same on free and paid Cloudflare plans.
6. If a free model errors or times out, the call goes to Jev.
7. Responses match Jev's format, plus which model served the call, the tokens used and the routing reason.

## Safety rules

- Shadow/enforce mode is passed through unchanged.
- A fallback never makes a decision more lenient than the original route would have.
- If every option fails (free models and Jev), the server reports a failure and never makes up an answer. The harness already handles failures: safety decisions ask the user, and other decisions take no action and log the gap. That gives:
  - **enforce** safety types: ask, never allow.
  - **shadow** types: "no opinion", recorded as a gap.
- The budget running out never causes a failed call. It only changes who answers.

## Access and logging

- One secret bearer token protects every endpoint, including stats and logs.
- Every call is logged with the **full payload**, the decision type, triage pick, model that served it, tokens, neurons, latency, final decision and any fallback reason.
- Because full payloads can contain commands, file contents or secrets:
  - logs are never readable without the token, and never included in the repo, examples or stats output;
  - log entries expire after a retention period (**assumed 30 days — confirm**).
- A stats view shows today's remaining budget, the mix of models used, the fallback count and the shadow disagreement rate.

## Validation before switching enforce types

1. **Offline replay.** About 1,000 past ledger calls are replayed through the router and its decisions are compared with Jev's. Target: at least 95% agreement.
2. **Live shadow week.** For about a week, calls answered by free models are also sent to Jev in the background, and every disagreement is logged. That costs pennies.
3. Enforce types switch over only after both steps pass.

## Expected routing (checked during replay)

- Light (small model answers itself): shell-safety, outbound-leak, loop-detector, compact-advisor, promise-continue, failure-triage
- Heavy (stronger free model): read-budget, mcp-trim, memory-hygiene, injection-screen, ask_jev_file
- Either: semantic-lint, subagent-router

## Success targets (not gates)

- At least 80% of calls served free.
- Jev usage down by 70% or more.
- At least 95% agreement with Jev, in both the replay and the shadow week.
- p90 latency no worse than today's Jev baseline.

## Open-source hygiene

- No secrets in the repo. An example env file and a README with setup steps.
- Anyone without Jev access can still run it free-first. If no fallback is configured, the safety rules above apply.

## Later (not v1)

- AWS version, once v1 has been validated. It has no free tier, so its value is portability, not cost.
- A configurable fallback chain (other providers beyond Jev). v1 deliberately uses Jev only.

## Risks

- Triage calls use up neurons too. Keep them tiny.
- Heavy calls could be routed as light. This is caught by the replay and the shadow week.
- Cloudflare's "allowance used up" signal can arrive early. That's harmless, since Jev just serves sooner. The server's own spending limit covers paid plans.
- Full-payload logs hold sensitive data. Handled by the token-only access and retention limit above.

## Open items

- Confirm the log retention period (30 days assumed).
- Get the p90 latency baseline from `jev.db`. I couldn't read it in this session because the read was blocked as potential credential exposure.
