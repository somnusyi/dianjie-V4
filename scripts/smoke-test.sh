#!/bin/bash
# ══════════════════════════════════════════════════════
# 滇界 V4 · 烟雾测试（复用现有 e2e + ui-smoke）
# 用法:
#   ./scripts/smoke-test.sh                          # 测生产 https://app.dianjie.cc
#   ./scripts/smoke-test.sh http://localhost:4444 http://localhost:3200
#                                                   # 测本地 API + Web
# ══════════════════════════════════════════════════════
set -euo pipefail

API_BASE="${1:-https://app.dianjie.cc}"
WEB_BASE="${2:-$API_BASE}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
FAILURES=0
LOGIN_COOLDOWN_SECONDS="${SMOKE_LOGIN_COOLDOWN_SECONDS:-60}"

if [[ "$API_BASE" =~ ^https?://(localhost|127\.0\.0\.1)(:|/) ]]; then
  if [ -z "${TENANT_SLUG:-}" ] && [ -f "$ROOT_DIR/apps/api/.env" ]; then
    PREVIEW_TENANT="$(sed -nE 's/^[[:space:]]*PREVIEW_TENANT_SLUG[[:space:]]*=[[:space:]]*([^#[:space:]]+).*/\1/p' "$ROOT_DIR/apps/api/.env" | tail -1)"
    if [ -n "$PREVIEW_TENANT" ]; then
      export TENANT_SLUG="$PREVIEW_TENANT"
    fi
  fi
  if [ -n "${TENANT_SLUG:-}" ] && [ -z "${UI_TENANT_SLUG:-}" ]; then
    export UI_TENANT_SLUG="$TENANT_SLUG"
  fi
elif [ -z "${E2E_PASSWORD:-}" ]; then
  echo "❌ 非本地 smoke 必须通过 E2E_PASSWORD 显式提供隔离测试账号密码"
  exit 2
fi

echo "==> API target: $API_BASE"
echo "==> Web target: $WEB_BASE"
echo "==> Test tenant: ${TENANT_SLUG:-test}"
echo ""

# 1. /api/health
echo "==> 1. health check"
HEALTH=$(curl -sf "$API_BASE/api/health" 2>/dev/null || curl -sf "$API_BASE/health" 2>/dev/null || echo "FAIL")
if [[ "$HEALTH" == FAIL* ]]; then
  echo "❌ /api/health 失败"; exit 1
fi
echo "$HEALTH" | head -3
echo ""

# 2. e2e (API 全角色链路)
echo "==> 2. e2e API roundtrip"
if [ -f "$SCRIPT_DIR/e2e-full-flow.js" ]; then
  if ! node "$SCRIPT_DIR/e2e-full-flow.js" --base "$API_BASE"; then
    echo "❌ e2e 有 step 失败，阻断部署"
    FAILURES=$((FAILURES + 1))
  fi
else
  echo "❌ e2e-full-flow.js 不存在，阻断部署"
  FAILURES=$((FAILURES + 1))
fi
echo ""

# API smoke and UI smoke together perform more than the production login limit
# (10 attempts/minute/IP). Wait for the limiter window instead of accepting
# false UI failures or weakening the production brute-force protection.
if [ "$LOGIN_COOLDOWN_SECONDS" -gt 0 ]; then
  echo "==> 登录限流冷却 ${LOGIN_COOLDOWN_SECONDS}s"
  sleep "$LOGIN_COOLDOWN_SECONDS"
  echo ""
fi

# 3. UI smoke (Playwright headless)
echo "==> 3. UI smoke (headless 浏览器跑 6 角色登录)"
if [ -f "$SCRIPT_DIR/ui-smoke.js" ]; then
  if ! node "$SCRIPT_DIR/ui-smoke.js" --base "$WEB_BASE"; then
    echo "❌ UI smoke 有失败，阻断部署"
    FAILURES=$((FAILURES + 1))
  fi
else
  echo "❌ ui-smoke.js 不存在，阻断部署"
  FAILURES=$((FAILURES + 1))
fi
echo ""

if [ "$FAILURES" -gt 0 ]; then
  echo "❌ Smoke test 失败项: $FAILURES"
  exit 1
fi

echo "✅ Smoke test 完成: API=$API_BASE Web=$WEB_BASE"
