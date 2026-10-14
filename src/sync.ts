import type { Env } from './env'
import { purge } from './log'
import { purgeOauth } from './oauth'

/** Daily cron: purge calls/shadow pairs older than RETENTION_DAYS (default 30), plus expired OAuth codes/tokens. */
export async function scheduledPurge(env: Env, now = Date.now()) {
  const days = Number(env.RETENTION_DAYS) > 0 ? Number(env.RETENTION_DAYS) : 30
  await purgeOauth(env.DB, now)
  return purge(env.DB, now, days)
}
