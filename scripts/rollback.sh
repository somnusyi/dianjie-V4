#!/usr/bin/env bash
# Legacy rollback is deliberately retired for the 1.3.3 candidate.
# It cannot read encrypted credentials or preserve new order, transfer and session facts.
set -euo pipefail
printf '%s\n' \
  'BLOCKED: scripts/rollback.sh is a legacy recovery path and is disabled.' \
  'Use the reviewed compatible recovery package and its mandatory read-only gate.' \
  'No application or database changes were made.' >&2
exit 2
