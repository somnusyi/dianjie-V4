#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
WEB_DIR="$ROOT_DIR/apps/web"
WEB_PORT="${WEB_PORT:-3200}"
LOCK_DIR="$ROOT_DIR/tmp/web-next.lock"

listener_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true
  fi
}

clean_next_cache() {
  rm -rf "$WEB_DIR/.next"
}

release_lock() {
  rm -rf "$LOCK_DIR"
}

acquire_lock() {
  local mode="$1"
  local owner_pid=""
  local owner_mode="unknown"

  mkdir -p "$(dirname "$LOCK_DIR")"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    owner_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    owner_mode="$(cat "$LOCK_DIR/mode" 2>/dev/null || true)"
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
      echo "ERROR: Web $owner_mode is already running (PID $owner_pid)."
      exit 1
    fi

    echo "==> Removing stale Web process lock"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR"
  fi

  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  printf '%s\n' "$mode" > "$LOCK_DIR/mode"
  trap release_lock EXIT INT TERM
}

case "${1:-}" in
  build)
    acquire_lock build
    pids="$(listener_pids)"
    if [ -n "$pids" ]; then
      echo "ERROR: Web port $WEB_PORT is in use (PID ${pids//$'\n'/,}). Stop the dev server before building."
      exit 1
    fi

    echo "==> Removing stale Web .next cache"
    clean_next_cache
    cd "$WEB_DIR"
    pnpm exec next build

    [ -f .next/BUILD_ID ] || { echo "ERROR: Web production BUILD_ID is missing."; exit 1; }
    [ -f .next/standalone/apps/web/server.js ] || { echo "ERROR: Web standalone server is missing."; exit 1; }
    echo "==> Web production build verified"
    ;;
  dev)
    acquire_lock dev
    pids="$(listener_pids)"
    if [ -n "$pids" ]; then
      echo "ERROR: Web port $WEB_PORT is already in use (PID ${pids//$'\n'/,})."
      exit 1
    fi

    if [ -f "$WEB_DIR/.next/BUILD_ID" ]; then
      echo "==> Removing production Web .next before starting dev"
      clean_next_cache
    fi

    cd "$WEB_DIR"
    pnpm exec next dev -p "$WEB_PORT"
    ;;
  *)
    echo "Usage: $0 {build|dev}"
    exit 2
    ;;
esac
