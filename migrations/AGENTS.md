# migrations/

- D1 migrations are applied with `cf d1 migrations apply` (`bun run db:migrate:local` locally).
- Never edit an applied migration. Add the next numbered file (`0002_…sql`).
