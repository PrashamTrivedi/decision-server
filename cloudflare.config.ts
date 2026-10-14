import { bindings, defineConfig, triggers } from "cf/config";

// AUD of the "decision-server previews" Access app (scripts/setup-access.sh --previews). Placeholder = login off on previews (key only).
const PREVIEW_ACCESS_AUD = "REPLACE_WITH_ACCESS_AUD";

export default defineConfig(({ isPreview }) => ({
  worker: {
    name: "decision-server",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    // Issues groups console.error(Error) calls, uncaught exceptions and 5xx; see src/AGENTS.md for what we log there.
    observability: { enabled: true, issues: { enabled: true } },
    // Production is served only on the custom domain; branch Previews get <slug>-decision-server.dev-286.workers.dev.
    workersDev: false,
    previewUrls: true,
    // Previews reject `domains`; they also skip the purge cron so only production runs it.
    ...(isPreview ? {} : {
      domains: ["decisions.prashamhtrivedi.app"],
      triggers: [triggers.scheduled({ schedule: "0 3 * * *" })],
    }),
    env: {
      AI: bindings.ai(),
      DB: bindings.d1({ name: "decisions-db", id: "4e152711-4afd-4482-868c-b98df3e6ef35" }),
      AI_GATEWAY_ID: bindings.text("default"),
      SHADOW: bindings.text("off"),
      EMERGENCY_PAID: bindings.text("on"),
      RETENTION_DAYS: bindings.text("30"),
      // Cloudflare Access (see scripts/setup-access.sh). Access JWT path is off if ACCESS_AUD is empty or the REPLACE_WITH_ACCESS_AUD placeholder.
      ACCESS_TEAM_DOMAIN: bindings.text("prasham-dev.cloudflareaccess.com"),
      // Previews live on *-decision-server.dev-286.workers.dev behind their own Access app, so they verify its AUD.
      ACCESS_AUD: bindings.text(isPreview ? PREVIEW_ACCESS_AUD : "8faf8eb1d36b8aefd8e887efbc36c2b2d14a607dfdeb6129f59be9bce0f08d2e"),
      DECISIONS_TOKEN: bindings.secret(),
      TYPESAFE_API_KEY: bindings.secret(),
    },
  },
}));
