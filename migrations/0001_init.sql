-- Call log (full payloads, purged after RETENTION_DAYS) and live-shadow comparison pairs.
CREATE TABLE calls (
  id              TEXT PRIMARY KEY,
  ts              INTEGER NOT NULL,           -- epoch ms
  decision        TEXT,
  mode            TEXT,
  agent           TEXT,
  session         TEXT,
  router_pick     TEXT,
  served_by       TEXT,                       -- flash | clef | omni | jev (NULL on total failure)
  route_reason    TEXT,
  model           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  neurons         REAL    NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT,
  status          TEXT    NOT NULL,           -- ok | error
  error           TEXT,
  state_json      TEXT,
  questions_json  TEXT,
  answers_json    TEXT,
  replay          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX calls_ts ON calls (ts);
CREATE INDEX calls_decision_ts ON calls (decision, ts);

CREATE TABLE shadow_pairs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id           TEXT NOT NULL,
  decision          TEXT,
  question_id       TEXT NOT NULL,
  free_answer_json  TEXT NOT NULL,
  jev_answer_json   TEXT NOT NULL,
  agree_at_default  INTEGER NOT NULL           -- 1 agree, 0 disagree at the harness default thresholds
);
CREATE INDEX shadow_pairs_call ON shadow_pairs (call_id);
CREATE INDEX shadow_pairs_decision ON shadow_pairs (decision);
