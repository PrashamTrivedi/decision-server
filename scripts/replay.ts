#!/usr/bin/env bun
/**
 * Replays logged jev-harness calls against the decision server and reports per-decision agreement
 * with the logged Jev answers, at each decision's default harness thresholds.
 *
 *   DECISIONS_TOKEN=... bun scripts/replay.ts --limit 1000 [--url https://...] [--db ~/.jev-harness/jev.db] [--decision shell-safety]
 *
 * The ledger (ledger.jsonl) only keeps compact signals, not the request payloads, so the full
 * {state, questions, answers} comes from the harness's jev.db (table jev_calls, see core/db.ts).
 * Everything is read locally; the only network traffic is POSTs to your own server, tagged X-Replay: 1
 * (so they skip the live shadow). Nothing is written back.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatReport, summarize, type ReplayResult } from './replay-lib'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const url = (arg('url') ?? process.env.DECISIONS_URL ?? 'https://decisions.prashamhtrivedi.app').replace(/\/$/, '')
const token = process.env.DECISIONS_TOKEN
const limit = Number(arg('limit', '1000'))
const concurrency = Number(arg('concurrency', '4'))
const only = arg('decision')
const dbPath = (arg('db') ?? join(process.env.JEV_HARNESS_HOME ?? join(homedir(), '.jev-harness'), 'jev.db')).replace(/^~\//, homedir() + '/')

if (!token) {
  console.error('DECISIONS_TOKEN is not set')
  process.exit(1)
}

const { Database } = await import('bun:sqlite')
const db = new Database(dbPath, { readonly: true })
const rows = db
  .query(
    `SELECT decision, state, questions, answers FROM jev_calls
      WHERE status = 'ok' AND answers IS NOT NULL AND decision IS NOT NULL ${only ? 'AND decision = ?' : ''}
      ORDER BY id DESC LIMIT ?`,
  )
  .all(...(only ? [only, limit] : [limit])) as { decision: string; state: string; questions: string; answers: string }[]
db.close()

console.error(`replaying ${rows.length} calls against ${url} ...`)

async function replayOne(r: (typeof rows)[number]): Promise<ReplayResult> {
  const jev = JSON.parse(r.answers)
  try {
    const res = await fetch(`${url}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Decision': r.decision, 'X-Replay': '1', 'X-Deadline-Ms': '8000' },
      body: JSON.stringify({ model: 'auto', state: JSON.parse(r.state), questions: JSON.parse(r.questions) }),
    })
    if (!res.ok) return { decision: r.decision, servedBy: 'none', ok: false, error: `HTTP ${res.status}`, jev }
    const data: any = await res.json()
    return { decision: r.decision, servedBy: data.servedBy ?? 'unknown', ok: true, free: data.answers, jev }
  } catch (e: any) {
    return { decision: r.decision, servedBy: 'none', ok: false, error: String(e?.message ?? e), jev }
  }
}

const results: ReplayResult[] = []
let next = 0
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < rows.length) {
      const r = rows[next++]
      results.push(await replayOne(r))
      if (results.length % 50 === 0) console.error(`  ${results.length}/${rows.length}`)
    }
  }),
)
console.log(formatReport(summarize(results)))
