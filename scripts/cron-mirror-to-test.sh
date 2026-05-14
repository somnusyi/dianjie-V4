#!/bin/bash
# ══════════════════════════════════════════════════════
# cron wrapper: 每天 03:00 把 dianjie 业务流水镜像到 test tenant
#
# 一次性安装到服务器后, 由 crontab 触发:
#   0 3 * * * /app/dianjie-v4/scripts/cron-mirror-to-test.sh
#
# 行为:
#   - 加载 /app/dianjie-v4/.env (拿到 DATABASE_URL)
#   - node 跑 apps/api/scripts/mirror-business-to-test.cjs
#   - 日志写到 /var/log/dianjie/mirror-YYYYMMDD-HHMMSS.log
#   - 失败 (没出现 "✅ 完成") → 退出码 1, cron 邮件能收到
#   - 自动清理 30 天前的旧 log
# ══════════════════════════════════════════════════════
set -euo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin
cd /app/dianjie-v4
# cjs 脚本会自己用 dotenv 加载 .env (avoid bash source 撞 & 字符问题)

LOG_DIR=/var/log/dianjie
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/mirror-$(date +%Y%m%d-%H%M%S).log"

{
  echo "=== mirror cron started at $(date) ==="
  node apps/api/scripts/mirror-business-to-test.cjs
  echo "=== mirror cron exit code: $? ==="
  echo "=== finished at $(date) ==="
} > "$LOG_FILE" 2>&1 || true

# 失败检测
if ! grep -q '^✅ 完成' "$LOG_FILE"; then
  echo "❌ mirror failed, see $LOG_FILE" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi

# 清理 30 天前的旧 log
find "$LOG_DIR" -name 'mirror-*.log' -mtime +30 -delete 2>/dev/null || true

echo "✓ mirror ok, log: $LOG_FILE"
