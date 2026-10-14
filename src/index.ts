import { createApp } from './app'
import type { Env } from './env'
import { scheduledPurge } from './sync'

const app = createApp()

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(scheduledPurge(env))
  },
} satisfies ExportedHandler<Env>
