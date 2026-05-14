#!/usr/bin/env bash
# 部署校验脚本 — 比对本地 build 和 ECS 上的关键文件 hash
# 用法: bash scripts/deploy-verify.sh
#
# 防止 rsync 偶发漏传 / pm2 引用旧模块 / 缓存问题
# 不一致时自动 force 重推 + restart pm2

set -e

SSHPASS_PWD='weiyi9216!'
ECS_HOST='root@116.62.32.162'
ECS_API_DIST='/app/dianjie-v4/apps/api/dist'
ECS_WEB_NEXT='/app/dianjie-v4/apps/web/apps/web/.next'
LOCAL_API_DIST='/Users/somnusyi/Projects/dianjie-local/apps/api/dist'
LOCAL_WEB_NEXT='/Users/somnusyi/Projects/dianjie-local/apps/web/.next'

ssh_cmd() { sshpass -p "$SSHPASS_PWD" ssh -o StrictHostKeyChecking=no "$ECS_HOST" "$@"; }
rsync_to() {
  sshpass -p "$SSHPASS_PWD" rsync -az --delete -e 'ssh -o StrictHostKeyChecking=no' "$1" "$ECS_HOST:$2"
}

echo "=== 1. 校验 API dist ==="
LOCAL_API_HASH=$(find "$LOCAL_API_DIST" -name "*.js" -exec md5 -q {} \; | sort | md5)
ECS_API_HASH=$(ssh_cmd "find $ECS_API_DIST -name '*.js' -exec md5sum {} \; | awk '{print \$1}' | sort | md5sum | awk '{print \$1}'")
echo "local: $LOCAL_API_HASH"
echo "ecs:   $ECS_API_HASH"
if [ "${LOCAL_API_HASH:0:8}" != "${ECS_API_HASH:0:8}" ]; then
  echo "⚠ API dist 不一致, 强推..."
  rsync_to "$LOCAL_API_DIST/" "$ECS_API_DIST/"
  ssh_cmd "pm2 restart dianjie-v4-api"
  echo "✓ API 重推 + 重启完成"
else
  echo "✓ API 一致"
fi

echo ""
echo "=== 2. 校验 web .next/static/chunks ==="
# 只比对 chunks (服务端渲染主要靠这个)
LOCAL_WEB_FILES=$(find "$LOCAL_WEB_NEXT/static/chunks" -name "*.js" 2>/dev/null | wc -l | tr -d ' ')
ECS_WEB_FILES=$(ssh_cmd "find $ECS_WEB_NEXT/static/chunks -name '*.js' 2>/dev/null | wc -l")
echo "local files: $LOCAL_WEB_FILES   ecs files: $ECS_WEB_FILES"
if [ "$LOCAL_WEB_FILES" != "$ECS_WEB_FILES" ]; then
  echo "⚠ web chunks 数量不一致, 强推..."
  rsync_to "$LOCAL_WEB_NEXT/" "$ECS_WEB_NEXT/"
  ssh_cmd "pm2 restart dianjie-v4-web"
  echo "✓ web 重推 + 重启完成"
else
  # 抽查一个关键文件 hash
  LOCAL_KEY=$(find "$LOCAL_WEB_NEXT/static/chunks/app/v2/supplier/orders/[id]" -name "page-*.js" -not -path "*/delivery-note/*" 2>/dev/null | head -1)
  if [ -n "$LOCAL_KEY" ]; then
    LOCAL_KEY_NAME=$(basename "$LOCAL_KEY")
    EXISTS=$(ssh_cmd "ls $ECS_WEB_NEXT/static/chunks/app/v2/supplier/orders/\[id\]/$LOCAL_KEY_NAME 2>/dev/null | wc -l")
    if [ "$EXISTS" = "0" ]; then
      echo "⚠ 关键 chunk $LOCAL_KEY_NAME 不在 ECS, 强推..."
      rsync_to "$LOCAL_WEB_NEXT/" "$ECS_WEB_NEXT/"
      ssh_cmd "pm2 restart dianjie-v4-web"
      echo "✓ web 重推 + 重启完成"
    else
      echo "✓ web 一致 (关键 chunk $LOCAL_KEY_NAME 已在 ECS)"
    fi
  fi
fi

echo ""
echo "=== 3. PM2 状态 ==="
ssh_cmd "pm2 status | grep -E 'v4-(api|web)' | head -5"

echo ""
echo "=== 4. API 健康检查 ==="
HEALTH=$(curl -s --max-time 5 http://116.62.32.162:8080/health 2>&1 | head -c 100)
if echo "$HEALTH" | grep -q '"status"'; then
  echo "✓ API 健康"
else
  echo "⚠ API 异常: $HEALTH"
fi

echo ""
echo "✅ 部署校验完成"
