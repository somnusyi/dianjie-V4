#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$ROOT_DIR"

: "${NEXT_PUBLIC_API_URL:=http://116.62.32.162:4000}"
: "${DJ_MOBILE_SERVER_URL:=http://116.62.32.162:3000}"

export NEXT_PUBLIC_API_URL
export DJ_MOBILE_SERVER_URL

pnpm --filter @dianjie/web build
