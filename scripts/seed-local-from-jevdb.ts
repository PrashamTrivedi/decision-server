/**
 * LOCAL DEMO ONLY. Reads a COPY of a Jev harness DB (jev_calls) and writes a SQL file that inserts
 * the rows into the decision-server `calls` schema (served_by='jev', route_reason='import:jev.db').
 * Never commit the DB copy or the generated SQL. Prints counts only, never payloads.
 *
 *   bun scripts/seed-local-from-jevdb.ts <jev-copy.db> <out.sql>
 *   sqlite3 <local-d1.sqlite> < <out.sql>     # or: cf d1 query <id> --local --persist-to <dir> --sql "$(cat out.sql)"
 */
import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'

const [src, out] = process.argv.slice(2)
if (!src || !out) {
  console.error('usage: bun scripts/seed-local-from-jevdb.ts <jev-copy.db> <out.sql>')
  process.exit(1)
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  return `'${String(v).replace(/'/g, "''")}'`
}

const db = new Database(src, { readonly: true })
const rows = db
  .query(
    `SELECT id, ts, agent, decision, mode, session_id, model, state, questions, answers, input_tokens, latency_ms, status, error
       FROM jev_calls ORDER BY ts`,
  )
  .all() as any[]

const cols = 'id,ts,decision,mode,agent,session,served_by,route_reason,model,input_tokens,neurons,latency_ms,status,error,state_json,questions_json,answers_json,replay'
const lines = ['DELETE FROM calls WHERE route_reason = \'import:jev.db\';']
for (const r of rows) {
  const ts = Date.parse(r.ts)
  if (Number.isNaN(ts)) continue
  const status = r.status === 'ok' ? 'ok' : 'error'
  const v = [
    `jev-import-${r.id}`, ts, r.decision, r.mode, r.agent, r.session_id, 'jev', 'import:jev.db', r.model,
    r.input_tokens ?? 0, 0, r.latency_ms ?? 0, status, r.error, r.state, r.questions, r.answers, 0,
  ]
  lines.push(`INSERT INTO calls (${cols}) VALUES (${v.map(lit).join(',')});`)
}
writeFileSync(out, lines.join('\n') + '\n')
db.close()
console.log(`read ${rows.length} jev_calls rows, wrote ${lines.length - 1} INSERTs`)
