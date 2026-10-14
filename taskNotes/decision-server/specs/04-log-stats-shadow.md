# 04: Log, stats, shadow

**Goal:** every call is visible, and the agreement data for switching decisions over is collected automatically.

- `migrations/0001_init.sql`: table `calls` (id, ts, decision, mode, agent, session, router_pick, served_by, model, input_tokens, neurons, latency_ms, fallback_reason, status, state_json, questions_json, answers_json, replay), plus table `shadow_pairs` (call_id, decision, question_id, free_answer_json, jev_answer_json, agree_at_default). Index on (ts), (decision, ts).
- Write each `calls` row in `ctx.waitUntil` so it never adds latency.
- Shadow: when `SHADOW=on`, the call was free-served and `X-Replay` isn't set, call Jev in `waitUntil` and store the pairs.
- `GET /v1/budget`, `GET /v1/stats?days=` (mix, fallbacks by reason, p50/p90 per tier, free %, shadow disagreement per decision), `GET /v1/calls?decision=&servedBy=&since=&limit=` (paged, full payloads).
- Cron: purge `calls`/`shadow_pairs` older than `RETENTION_DAYS=30`.

**Done when:** integration tests cover row-per-call, the stats aggregation, the shadow write and the purge.
