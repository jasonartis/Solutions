#!/usr/bin/env bash
# The Management-API half of security-evidence-run.sh, on its own so it can be
# approved and run separately (founder approved 2026-11-15). GET only; writes
# JSON into the evidence folder OUTSIDE the repo. Reads SUPABASE_ACCESS_TOKEN
# and SUPABASE_PROJECT_REF from .env.deploy.
#
#   bash scripts/security-evidence-mgmt.sh [out-dir]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/d/Jason_prompts/sessions/security-evidence-2026-11-13}"
mkdir -p "$OUT"
cd "$ROOT"
TOKEN="$(grep -E '^SUPABASE_ACCESS_TOKEN=' .env.deploy | cut -d= -f2- | tr -d '\r')"
REF="$(grep -E '^SUPABASE_PROJECT_REF=' .env.deploy | cut -d= -f2- | tr -d '\r')"
if [ -z "$TOKEN" ] || [ -z "$REF" ]; then echo "no token/ref in .env.deploy"; exit 1; fi
for ep in config/auth config/database/postgres network-restrictions pgsodium config/database/pooler ssl-enforcement; do
  name="$(echo "$ep" | tr '/' '_')"
  curl -sS -H "Authorization: Bearer $TOKEN" "https://api.supabase.com/v1/projects/$REF/$ep" -o "$OUT/mgmt-$name.json" -w "mgmt $ep -> HTTP %{http_code}\n"
done
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.supabase.com/v1/projects/$REF/api-keys" -o "$OUT/mgmt-api-keys.REDACT-BEFORE-SHARING.json" -w "mgmt api-keys -> HTTP %{http_code}\n"
