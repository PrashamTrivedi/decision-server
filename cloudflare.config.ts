import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig(({ isPreview }) => ({
  worker: {
    name: "decision-server",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    observability: { enabled: true },
    // Preview URLs for non-main branches (Workers Builds Previews).
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
      RETENTION_DAYS: bindings.text("30"),
      DECISIONS_TOKEN: bindings.secret(),
      TYPESAFE_API_KEY: bindings.secret(),
    },
  },
}));
