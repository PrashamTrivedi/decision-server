import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "decision-server",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    observability: { enabled: true },
    domains: ["decisions.prashamhtrivedi.app"],
    triggers: [triggers.scheduled({ schedule: "0 3 * * *" })],
    env: {
      AI: bindings.ai(),
      // Replace the id after `cf d1 create` (not run by the build agent).
      DB: bindings.d1({ name: "decisions-db", id: "REPLACE_AFTER_D1_CREATE" }),
      AI_GATEWAY_ID: bindings.text("default"),
      SHADOW: bindings.text("off"),
      RETENTION_DAYS: bindings.text("30"),
      DECISIONS_TOKEN: bindings.secret(),
      TYPESAFE_API_KEY: bindings.secret(),
    },
  },
});
