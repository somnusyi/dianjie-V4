#!/bin/bash
# ══════════════════════════════════════════════════════
# 滇界 V4 · worktree 部署脚本 (杜绝基于旧代码部署 + 双人同时部署)
#
# 用法 (必须在 worktree 目录里跑):
#   cd ~/Desktop/dianjie-V4/dianjie-V4-deploy
#   export V4_SSH_PASSWORD='xxx'
#   ./scripts/deploy-worktree.sh
#
# 三层防护:
#   1. cwd 检查 — 必须在 worktree 跑 (避免污染主仓库 dev)
#   2. git 版本检查 — 服务器 .deployed-commit 必须是当前 origin/main 的祖先
#      (如果同事推过更新的 commit, 你这边没拉到 → 拒绝部署)
#   3. 服务器锁 — /app/dianjie-v4/.deploy-lock 目录, 一次只能一个人部署
# ══════════════════════════════════════════════════════
set -euo pipefail

# ── 0. 前置检查 ──────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

if [ "$(basename "$ROOT_DIR")" != "dianjie-V4-deploy" ]; then
  echo "❌ 部署必须在 worktree 目录跑: ~/Desktop/dianjie-V4/dianjie-V4-deploy"
  echo "   当前位置: $ROOT_DIR"
  exit 1
fi

: "${V4_SSH_PASSWORD:?需先 export V4_SSH_PASSWORD=...}"

SERVER='root@116.62.32.162'
REMOTE='/app/dianjie-v4'
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"

ssh_run() {
  sshpass -p "$V4_SSH_PASSWORD" ssh $SSH_OPTS "$SERVER" "$@"
}
rsync_run() {
  sshpass -p "$V4_SSH_PASSWORD" rsync -avz --delete -e "ssh $SSH_OPTS" "$@"
}

# ── 1. 上锁 ─────────────────────────────────────────
echo "==> [1/8] 抢占部署锁 (服务器 .deploy-lock)"
if ! ssh_run "mkdir $REMOTE/.deploy-lock 2>/dev/null"; then
  echo "❌ 别人正在部署 (锁存在)"
  LOCK_INFO=$(ssh_run "cat $REMOTE/.deploy-lock/owner 2>/dev/null || echo unknown")
  echo "   锁持有者: $LOCK_INFO"
  echo "   等他完成, 或确认死锁后手动清理:"
  echo "   ssh $SERVER 'rm -rf $REMOTE/.deploy-lock'"
  exit 1
fi

# 上锁后任何退出 (失败/Ctrl+C/正常) 都自动解锁
LOCK_OWNER="$(whoami)@$(hostname) $(date '+%H:%M:%S')"
ssh_run "echo '$LOCK_OWNER' > $REMOTE/.deploy-lock/owner"
trap 'ssh_run "rm -rf $REMOTE/.deploy-lock" 2>/dev/null || true' EXIT
echo "   锁已获取 ($LOCK_OWNER)"

# ── 2. fetch 最新 origin/main + worktree 切过去 ─────
echo ""
echo "==> [2/8] git fetch + worktree 切到 origin/main"
git fetch origin
ORIGIN_HEAD=$(git rev-parse origin/main)
LOCAL_HEAD=$(git rev-parse HEAD)
if [ "$LOCAL_HEAD" != "$ORIGIN_HEAD" ]; then
  git checkout "$ORIGIN_HEAD"
  echo "   worktree 切到 $ORIGIN_HEAD"
fi
SHORT_HEAD=$(git rev-parse --short HEAD)

# ── 3. 版本检查 (服务器是不是你的祖先?) ─────────────
echo ""
echo "==> [3/8] 检查服务器已部署版本"
SERVER_COMMIT=$(ssh_run "cat $REMOTE/.deployed-commit 2>/dev/null || echo NONE")
echo "   服务器: $SERVER_COMMIT"
echo "   即将部署: $ORIGIN_HEAD"

if [ "$SERVER_COMMIT" != "NONE" ] && [ "$SERVER_COMMIT" != "$ORIGIN_HEAD" ]; then
  if ! git cat-file -e "$SERVER_COMMIT" 2>/dev/null; then
    echo "⚠  服务器 commit $SERVER_COMMIT 本地仓库找不到 (可能 push 过的 commit 我没 fetch)"
    echo "   强烈建议先 git fetch --all && git pull 再试"
    exit 1
  fi
  if ! git merge-base --is-ancestor "$SERVER_COMMIT" "$ORIGIN_HEAD"; then
    echo "❌ 服务器版本 ($SERVER_COMMIT) 不是 origin/main ($ORIGIN_HEAD) 的祖先"
    echo "   说明有比 origin/main 更新的代码已经部署到服务器"
    echo "   先 git pull origin main, 解决冲突后再来"
    exit 1
  fi
fi

# ── 4. 依赖 + 构建 ───────────────────────────────────
echo ""
echo "==> [4/8] pnpm install + build (worktree, 主仓库 dev 不受影响)"
pnpm install --frozen-lockfile
pnpm --filter @dianjie/db exec prisma generate >/dev/null 2>&1

# tsc 有 7 个 pre-existing error 但 emit dist (按内部规则)
pnpm --filter @dianjie/api exec tsc 2>&1 | tail -3 || echo "   ⚠ tsc 有 pre-existing error, 但 dist 已 emit"

pnpm --filter @dianjie/web build 2>&1 | grep -E "(error|Failed|✓ Compiled|✓ Generating)" | tail -5

# 校验产物 (build 完整性)
[ -f apps/api/dist/index.js ] || { echo "❌ api dist 缺失"; exit 1; }
[ -f apps/api/dist/routes/cmb.js ] || { echo "❌ cmb 路由 dist 缺失"; exit 1; }
[ -f apps/web/.next/standalone/apps/web/server.js ] || { echo "❌ web standalone 缺失"; exit 1; }
grep -q "cmbRoutes" apps/api/dist/index.js || { echo "❌ index.js 没注册 cmbRoutes"; exit 1; }
echo "   ✓ 本地产物校验通过"

# ── 5. rsync ────────────────────────────────────────
echo ""
echo "==> [5/8] rsync 上传"
rsync_run apps/api/dist/                          "$SERVER:$REMOTE/apps/api/dist/" | tail -2
rsync_run apps/web/.next/standalone/apps/web/     "$SERVER:$REMOTE/apps/web/apps/web/" | tail -2
rsync_run apps/web/.next/static/                  "$SERVER:$REMOTE/apps/web/apps/web/.next/static/" | tail -2

# ── 6. pm2 reload (两个进程都要 reload 一次, 防止某次不响应) ──
echo ""
echo "==> [6/8] pm2 reload api + web"
ssh_run "pm2 reload dianjie-v4-api --update-env" >/dev/null
ssh_run "pm2 reload dianjie-v4-web --update-env" >/dev/null
sleep 4

# ── 7. 验证 (4 项必过) ───────────────────────────────
echo ""
echo "==> [7/8] 部署后验证"
LOCAL_API_MD5=$(md5 -q apps/api/dist/index.js 2>/dev/null || md5sum apps/api/dist/index.js | awk '{print $1}')

ssh_run "
  set -e
  test -f $REMOTE/apps/api/dist/routes/cmb.js || { echo '❌ cmb.js 不在'; exit 1; }
  test \$(grep -c cmbRoutes $REMOTE/apps/api/dist/index.js) -ge 1 || { echo '❌ cmbRoutes 没注册'; exit 1; }
  REMOTE_MD5=\$(md5sum $REMOTE/apps/api/dist/index.js | awk '{print \$1}')
  [ \"\$REMOTE_MD5\" = '$LOCAL_API_MD5' ] || { echo \"❌ MD5 不一致 local=$LOCAL_API_MD5 remote=\$REMOTE_MD5\"; exit 1; }
  test \$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4004/health) = '200' || { echo '❌ /health'; exit 1; }
  test \$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4004/api/cmb/status) = '401' || { echo '❌ /api/cmb/status'; exit 1; }
  echo '   ✓ 4 项验证全通过'
"

# ── 8. 标记 deployed commit (verify 通过才写, 失败留旧值) ─
echo ""
echo "==> [8/8] 标记 deployed commit"
ssh_run "echo '$ORIGIN_HEAD' > $REMOTE/.deployed-commit"

echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ 部署成功"
echo "     commit: $SHORT_HEAD"
echo "     时间:   $(date '+%Y-%m-%d %H:%M:%S')"
echo "     操作员: $LOCK_OWNER"
echo "═══════════════════════════════════════════"
echo ""
echo "建议: 在群里发一句 '部署完成 $SHORT_HEAD'"
