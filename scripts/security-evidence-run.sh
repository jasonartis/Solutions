#!/usr/bin/env bash
# SECURITY EVIDENCE RUN — gathers everything docs/30-security-review.md needs,
# WITHOUT any Claude usage, into an evidence directory OUTSIDE the public repo.
# Started 2026-11-13 so the pack is ready when usage resets. Every step is
# read-only against prod (catalog SELECTs, prod-verify-migration.ts which only
# reads pg_proc, verify-acl-hardening --preflight, a Management API GET) or
# local (pnpm audit). Re-runnable.
#
#   bash scripts/security-evidence-run.sh [out-dir]
#
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/d/Jason_prompts/sessions/security-evidence-2026-11-13}"
mkdir -p "$OUT"
LOG="$OUT/run.log"
cd "$ROOT"

PNPM="corepack pnpm"
echo "=== security evidence run started $(date -Is) → $OUT" | tee "$LOG"

step() { echo "" | tee -a "$LOG"; echo "=== [$1] $(date -Is)" | tee -a "$LOG"; }

step "catalog dump"
$PNPM exec tsx scripts/security-evidence-dump.mts "$OUT/catalog" >>"$LOG" 2>&1 || echo "catalog dump FAILED" | tee -a "$LOG"

step "ACL hardening preflight (prod)"
$PNPM exec tsx scripts/verify-acl-hardening.ts --preflight >"$OUT/acl-preflight.log" 2>&1 || echo "acl preflight exited non-zero (see acl-preflight.log)" | tee -a "$LOG"

step "per-migration function parity against prod (prod-verify-migration.ts, read-only)"
: >"$OUT/migration-parity.log"
for f in supabase/migrations/*.sql; do
  echo "----- $f" >>"$OUT/migration-parity.log"
  $PNPM exec tsx scripts/prod-verify-migration.ts "$f" >>"$OUT/migration-parity.log" 2>&1
done
grep -c "FAIL" "$OUT/migration-parity.log" | sed 's/^/FAIL lines in migration-parity.log: /' | tee -a "$LOG"

step "dependency audit (local)"
$PNPM audit --json >"$OUT/pnpm-audit.json" 2>>"$LOG" || echo "pnpm audit exited non-zero (findings present or offline)" | tee -a "$LOG"
$PNPM outdated --format json >"$OUT/pnpm-outdated.json" 2>>"$LOG" || true

step "Supabase auth + project config via Management API (GET only)"
TOKEN="$(grep -E '^SUPABASE_ACCESS_TOKEN=' .env.deploy | cut -d= -f2- | tr -d '\r')"
REF="$(grep -E '^SUPABASE_PROJECT_REF=' .env.deploy | cut -d= -f2- | tr -d '\r')"
if [ -n "$TOKEN" ] && [ -n "$REF" ]; then
  for ep in config/auth config/database/postgres network-restrictions pgsodium config/database/pooler ssl-enforcement; do
    name="$(echo "$ep" | tr '/' '_')"
    curl -sS -H "Authorization: Bearer $TOKEN" "https://api.supabase.com/v1/projects/$REF/$ep" -o "$OUT/mgmt-$name.json" -w "mgmt $ep → HTTP %{http_code}\n" | tee -a "$LOG"
  done
  curl -sS -H "Authorization: Bearer $TOKEN" "https://api.supabase.com/v1/projects/$REF/api-keys" -o "$OUT/mgmt-api-keys.REDACT-BEFORE-SHARING.json" -w "mgmt api-keys → HTTP %{http_code}\n" | tee -a "$LOG"
else
  echo "no SUPABASE_ACCESS_TOKEN / REF in .env.deploy — management API step skipped" | tee -a "$LOG"
fi

step "public surface (unauthenticated HEAD/GET against the stable alias, no secrets)"
for p in / /login /signup /report /privacy /terms /console /console/view-as /api/health /robots.txt; do
  curl -sS -o /dev/null -w "%{http_code} $p\n" "https://solutions-platform.vercel.app$p" | tee -a "$OUT/public-surface.log"
done
curl -sSI "https://solutions-platform.vercel.app/login" >"$OUT/public-headers-login.txt" 2>&1

echo "" | tee -a "$LOG"
echo "=== finished $(date -Is)" | tee -a "$LOG"
ls -la "$OUT" | tee -a "$LOG"
