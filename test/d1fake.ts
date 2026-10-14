import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'

/** Minimal D1 fake over node:sqlite running the real migration. */
export function makeD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../migrations/', import.meta.url)
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'))
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => {
      const r = db.prepare(sql).run(...(args as any[]))
      return { success: true, meta: { changes: Number(r.changes) } }
    },
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) as any[], success: true }),
    first: async () => (db.prepare(sql).get(...(args as any[])) as any) ?? null,
    _run: () => db.prepare(sql).run(...(args as any[])),
  })
  return {
    raw: db,
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => {
      db.exec('BEGIN')
      try { for (const s of stmts) s._run(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
      return []
    },
  } as unknown as D1Database & { raw: DatabaseSync }
}

/** Collects waitUntil promises so tests can await them. */
export function makeCtx() {
  const pending: Promise<unknown>[] = []
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    flush: async () => { await Promise.all(pending.splice(0)) },
  }
}
