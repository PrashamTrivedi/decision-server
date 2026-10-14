#!/usr/bin/env bash
# Puts the whole decision-server host behind Cloudflare Access (browser login), with a Bypass app for the
# machine paths that the Worker authenticates itself (decision key on /v1, OAuth on /mcp).
# Order matters: the bypass app is created first so /v1 and /mcp never sit behind the browser login.
#
# Usage: OWNER_EMAIL=you@example.com HOST=decisions.example.com bash scripts/setup-access.sh
# Prints the whole-host app's AUD tag: put it in cloudflare.config.ts as ACCESS_AUD.
set -euo pipefail
: "${OWNER_EMAIL:?set OWNER_EMAIL (the only identity allowed to log in)}"
HOST="${HOST:-decisions.prashamhtrivedi.app}"

bypass=$(jq -nc --arg h "$HOST" '{
  name: "decision-server machine paths (worker-authenticated)", type: "self_hosted",
  domain: ($h + "/v1"),
  self_hosted_domains: [($h+"/v1"), ($h+"/mcp"), ($h+"/oauth/token"), ($h+"/oauth/register"), ($h+"/.well-known")],
  app_launcher_visible: false,
  policies: [{ name: "Bypass: worker enforces decision key / OAuth", decision: "bypass", include: [{ everyone: {} }] }]
}')
host=$(jq -nc --arg h "$HOST" --arg e "$OWNER_EMAIL" '{
  name: "decision-server", type: "self_hosted", domain: $h, self_hosted_domains: [$h],
  session_duration: "24h", app_launcher_visible: false,
  policies: [{ name: "Owner only", decision: "allow", include: [{ email: { email: $e } }] }]
}')

echo "Creating bypass app for machine paths..."
bunx cf zero-trust access applications create --body "$bypass" | jq -c '{id, name, self_hosted_domains}'
echo "Creating whole-host login app..."
bunx cf zero-trust access applications create --body "$host" | jq -r '"ACCESS_AUD=" + .aud'
