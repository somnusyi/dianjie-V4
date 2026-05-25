#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$ROOT_DIR"

# 2026-05-22 切 njdianjie.com 备案域名 (nginx 443 SSL → web :3204 / api :4004 内部转发)
# 老 IP 入口 116.62.32.162:8080 仍保留兼容客户手机里旧 app, 直到全员重装迁完
: "${NEXT_PUBLIC_API_URL:=https://www.njdianjie.com}"
: "${DJ_MOBILE_SERVER_URL:=https://www.njdianjie.com}"

export NEXT_PUBLIC_API_URL
export DJ_MOBILE_SERVER_URL

pnpm --filter @dianjie/web build
