# 03: Budget via AI Gateway spend limit

**Goal:** when the gateway's spend limit (or the free allowance) runs out, Jev answers. No counter, Free and Paid plans alike.

**Gateway (rev 4):** use the existing `default` gateway (`AI_GATEWAY_ID=default` in `vars`). It's shared with pi, and its current rules are $0.20/day sliding, $0.43/day fixed and $10/30d sliding. No new gateway, rule or auth change. A dedicated gateway with its own rule is a later config-only switch.

**Code:**
- `providers/clef.ts`: `env.AI.run(modelId, {state, questions}, { gateway: { id: env.AI_GATEWAY_ID } })`.
- `src/quota.ts`: `classify(err)` →
  - `spend-limit`: HTTP 429 with code `2041` / "Spend limit exceeded" (shape confirmed from pi's sessions).
  - `quota`: Workers AI free-quota code `4006` (shape not yet confirmed; matcher kept here).
  - `other`.
- `decide.ts`: `spend-limit` → Jev, skip Clef in this isolate for 15 min (window resets are unknown or sliding, and a rejected probe costs no neurons). `quota` → Jev, skip until 00:00 UTC. `other` → Jev, no flag. `fallbackReason` is logged as one of these.
- `neurons` per call = `usage.input_tokens × rate / 1e6`, for stats only.
- `GET /v1/budget`: today's server neurons (D1 sum), spend-limit and quota error counts, last occurrence, and the flag state.

**Done when:** stubbed tests cover each class → Jev, the flag TTLs (15 min / 00:00 UTC), and that `other` sets no flag. The stub uses the exact 2041 body seen in pi's sessions. There's no live forcing, because that would lock pi too.
