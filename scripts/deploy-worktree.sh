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

SERVER='root@116.62.32.162'
REMOTE='/app/dianjie-v4'
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"

ssh_run() {
  if [ -n "${V4_SSH_PASSWORD:-}" ]; then
    sshpass -p "$V4_SSH_PASSWORD" ssh $SSH_OPTS "$SERVER" "$@"
  else
    ssh $SSH_OPTS "$SERVER" "$@"
  fi
}
rsync_run() {
  if [ -n "${V4_SSH_PASSWORD:-}" ]; then
    sshpass -p "$V4_SSH_PASSWORD" rsync -avz --delete -e "ssh $SSH_OPTS" "$@"
  else
    rsync -avz --delete -e "ssh $SSH_OPTS" "$@"
  fi
}

# Sparse worktrees may omit tracked static assets. Materialize them before the
# clean-worktree check so a release cannot fail after partially uploading build
# output.
if [ ! -d apps/web/public ]; then
  git checkout --ignore-skip-worktree-bits HEAD -- apps/web/public
fi
[ -d apps/web/public ] || { echo "❌ apps/web/public 缺失，停止部署"; exit 1; }

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "❌ 部署 worktree 不是干净状态，停止部署:"
  git status --short
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ] && [ ! -f apps/api/.env ]; then
  echo "❌ 缺少本地测试 DATABASE_URL；它必须指向隔离测试库，不能指向生产库。"
  exit 1
fi

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
# 稀疏 worktree 在 checkout 新提交时可能再次把 tracked public/ 隐藏。
# 必须在切换目标提交后重新物化，否则前面的检查通过、上传阶段仍会失败。
if [ ! -d apps/web/public ]; then
  git checkout --ignore-skip-worktree-bits HEAD -- apps/web/public
fi
[ -d apps/web/public ] || { echo "❌ 切换目标提交后 apps/web/public 缺失，停止部署"; exit 1; }
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
# Never let a caller's API development environment leak into `next build`.
# A forced NODE_ENV=development makes Next load both dev and production React
# runtimes during prerender and can fail every static page with useContext null.
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @dianjie/db exec prisma generate >/dev/null 2>&1
pnpm --filter @dianjie/api test
pnpm --filter @dianjie/api build
pnpm --filter @dianjie/web exec tsc --noEmit
WEB_BUILD_LOG="${TMPDIR:-/tmp}/dianjie-v4-web-build-${SHORT_HEAD}-$$.log"
if ! WEB_PORT="${V4_BUILD_GUARD_PORT:-3299}" pnpm --filter @dianjie/web build >"$WEB_BUILD_LOG" 2>&1; then
  echo "   ⚠ Web 首次正式构建失败，保留完整日志并清缓存重试一次"
  tail -80 "$WEB_BUILD_LOG"
  if ! WEB_PORT="${V4_BUILD_GUARD_PORT:-3299}" pnpm --filter @dianjie/web build >"$WEB_BUILD_LOG" 2>&1; then
    echo "❌ Web 正式构建重试后仍失败"
    tail -160 "$WEB_BUILD_LOG"
    exit 1
  fi
fi
grep -E "(error|Failed|✓ Compiled|✓ Generating|Web production build verified)" "$WEB_BUILD_LOG" | tail -6 || true
rm -f "$WEB_BUILD_LOG"

# 校验产物 (build 完整性)
[ -f apps/api/dist/index.js ] || { echo "❌ api dist 缺失"; exit 1; }
[ -f apps/api/dist/routes/cmb.js ] || { echo "❌ cmb 路由 dist 缺失"; exit 1; }
[ -f apps/web/.next/standalone/apps/web/server.js ] || { echo "❌ web standalone 缺失"; exit 1; }
grep -q "cmbRoutes" apps/api/dist/index.js || { echo "❌ index.js 没注册 cmbRoutes"; exit 1; }
echo "   ✓ 本地产物校验通过"

# ── 4.1 当前生产快照（上传任何新产物之前）──────────────
BACKUP_TAG="$(date +%Y%m%d-%H%M%S)-${SHORT_HEAD}"
echo ""
echo "==> [4.1/8] 备份当前生产 DB + build"
ssh_run "
  set -e
  DB_URL=\$(grep -E '^DATABASE_URL=' $REMOTE/.env | head -1 | cut -d= -f2-)
  DB_URL_PG=\$(printf '%s' \"\$DB_URL\" | sed 's/?[^?]*$//')
  mkdir -p /app/backups
  chmod 700 /app/backups
  pg_dump \"\$DB_URL_PG\" --no-owner --no-acl --format=custom \\
    --file=/app/backups/dianjie_v4-deploy-bak-${BACKUP_TAG}.dump
  pg_restore -l /app/backups/dianjie_v4-deploy-bak-${BACKUP_TAG}.dump >/dev/null
  tar -czf /app/backups/v4-build-bak-${BACKUP_TAG}.tar.gz -C $REMOTE \\
    .deployed-commit apps/api/dist apps/web/apps/web apps/cmb packages/db/prisma scripts
  tar -tzf /app/backups/v4-build-bak-${BACKUP_TAG}.tar.gz >/dev/null
  chmod 600 /app/backups/dianjie_v4-deploy-bak-${BACKUP_TAG}.dump \\
    /app/backups/v4-build-bak-${BACKUP_TAG}.tar.gz
  echo '   ✓ 当前生产 DB 与 build 快照均已校验'
"

# ── 5. rsync ────────────────────────────────────────
echo ""
echo "==> [5/8] rsync 上传"
rsync_run apps/api/dist/                          "$SERVER:$REMOTE/apps/api/dist/" | tail -2
rsync_run apps/web/.next/standalone/apps/web/     "$SERVER:$REMOTE/apps/web/apps/web/" | tail -2
rsync_run apps/web/.next/static/                  "$SERVER:$REMOTE/apps/web/apps/web/.next/static/" | tail -2
# apps/web/public — PWA manifest / icons / 静态资源 (旧 deploy.sh 有, 新脚本之前漏了)
# 历史教训: 改 icon / manifest 后 build 不动 public/, 不同步就用户看旧 icon
rsync_run apps/web/public/                        "$SERVER:$REMOTE/apps/web/apps/web/public/" | tail -2
# 同步 scripts — cron 跑的 mirror-business-to-test.cjs / e2e-full-flow.js 等
# 历史教训: scripts 不同步会出现"代码已 push 但服务器仍跑旧版本"的脏状态
# (e.g. 2026-05-28 mirror cron 修了 7 天没生效, 因为 cjs 没拷过去)
rsync_run apps/api/scripts/                       "$SERVER:$REMOTE/apps/api/scripts/" | tail -2
# Operational TypeScript scripts import shared validators/services from src/.
# Keeping only scripts/ made migrations pass in a production clone but fail on
# ECS with MODULE_NOT_FOUND.  Source is not used by the running dist process;
# it is deployed solely so audited one-off jobs can execute the same code.
rsync_run apps/api/src/                           "$SERVER:$REMOTE/apps/api/src/" | tail -2
rsync_run scripts/                                "$SERVER:$REMOTE/scripts/" | tail -2
# apps/cmb (Python Flask 国密微服务) — 同事+我之前手 SSH 推过, 现在纳入 deploy
# 排除 __pycache__ / *.pyc (本地 build 产物, ECS 自己会重新生成)
# 排除 .env (ECS .env 是真理, 不能被 worktree 覆盖)
rsync_run --exclude='__pycache__/' --exclude='*.pyc' --exclude='.env' \
          apps/cmb/                               "$SERVER:$REMOTE/apps/cmb/" | tail -2

# apps/api/package.json + packages/db (源码 + index.js + prisma) — 让 ECS install 依赖时用最新
# 历史教训 (2026-05-28): 同事 commit 加 axios / @prisma/client / cuid2 等新依赖到 apps/api/package.json,
# 但 deploy 只同步 dist 不同步 package.json → ECS node_modules 永远跟 git 不一致 → 运行时 MODULE_NOT_FOUND
# 排除 packages/db/node_modules (ECS 自己维护) 和 prisma client 生成产物
rsync_run apps/api/package.json                   "$SERVER:$REMOTE/apps/api/package.json" | tail -2
rsync_run --exclude='node_modules' --exclude='.env' \
          packages/db/                            "$SERVER:$REMOTE/packages/db/" | tail -2

# ══════════════════════════════════════════════════════
# ECS 状态同步 (5.1 → 5.5): 把 ECS 拉到跟 git HEAD 一致
# 顺序敏感: 装依赖 → 跑 DB migration → regenerate prisma client → 校验 env
# ══════════════════════════════════════════════════════

# ── 5.1 cmb Python 依赖 ─────────────────────────────
# rsync 把 requirements.txt 推上去了, 但不会自动 pip install.
# 历史教训: 加 Python 包后 pm2 reload cmb 会 ModuleNotFoundError 起不来,
# fail-fast 抓得到但用户看到的是"部署失败", 不知是缺包.
echo ""
echo "==> [5.1/8] ECS cmb Python 依赖 (pip install)"
ssh_run "
  set -e
  cd $REMOTE/apps/cmb
  pip3 install -q --disable-pip-version-check -r requirements.txt 2>&1 | tail -3 || true
  echo '   ✓ cmb 依赖同步完成'
"

# ── 5.2 ECS api Node 依赖 (用 /tmp 干净环境避开 workspace:* 协议) ───
# pnpm workspace:* 协议在生产端解析不动 (生产没 workspace 配置), npm 也不认.
# 方案: /tmp 临时复制 package.json → 删 workspace: 行 → npm install → cp 缺失的包到
# apps/api/node_modules, 保留 @dianjie/db symlink. 全套耗时 ~30s.
echo ""
echo "==> [5.2/8] ECS 装/补 apps/api 依赖 (axios / cuid2 / 任何 package.json 新加的)"
ssh_run "
  set -e
  rm -rf /tmp/api-rebuild
  mkdir -p /tmp/api-rebuild
  cd /tmp/api-rebuild
  cp $REMOTE/apps/api/package.json ./
  sed -i '/workspace:/d' package.json   # npm 不支持 workspace: 协议, 临时删
  npm install --no-audit --no-fund --silent 2>&1 | tail -2
  # cp 缺失的包 (--no-clobber 不覆盖已有), 保留 @dianjie/db symlink
  cp -rn node_modules/* $REMOTE/apps/api/node_modules/ 2>/dev/null || true
  # 确保 @dianjie/db symlink 完好
  if [ ! -L $REMOTE/apps/api/node_modules/@dianjie/db ]; then
    mkdir -p $REMOTE/apps/api/node_modules/@dianjie
    ln -sf $REMOTE/packages/db $REMOTE/apps/api/node_modules/@dianjie/db
  fi
  echo '   ✓ apps/api 依赖同步完成'
"

# ── 5.3 prisma migrate deploy (DB schema 跟代码对齐) ───
# 旧 deploy.sh line 160-165 有这步, 新 deploy-worktree.sh 之前漏了.
# 不跑这步, schema.prisma 加的字段/表/enum 在 ECS DB 里不存在 →
# 运行时第一次 query 报 "column does not exist" / "relation does not exist".
# 必须在 prisma generate 之前 — generate 出来的 client 假设 DB 是 schema 描述的形状.
echo ""
echo "==> [5.3/8] ECS prisma migrate deploy (应用待执行的 migration)"

if [ -d packages/db/prisma/migrations/20260715101500_reconcile_schema_drift ]; then
  BASELINE_COUNT=$(ssh_run "
    DB_URL=\$(grep -E '^DATABASE_URL=' $REMOTE/.env | head -1 | cut -d= -f2-)
    DB_URL_PG=\$(printf '%s' \"\$DB_URL\" | sed 's/?[^?]*$//')
    psql \"\$DB_URL_PG\" -X -Atc \"SELECT count(*) FROM \\\"_prisma_migrations\\\" WHERE migration_name='20260715101500_reconcile_schema_drift' AND finished_at IS NOT NULL AND rolled_back_at IS NULL\"
  ")
  if [ "$BASELINE_COUNT" != "1" ]; then
    echo "❌ 生产历史漂移迁移尚未完成安全 baseline，停止执行 migration。"
    echo "   先在开发仓库运行 scripts/prepare-production-p0-baseline.sh，"
    echo "   并在新备份和批准窗口后显式执行 --apply-baseline。"
    exit 1
  fi
fi

ssh_run "
  set -e
  cd $REMOTE/packages/db
  export \$(grep -E '^DATABASE_URL=' $REMOTE/.env | xargs)
  npx -y prisma@5.22.0 migrate deploy --schema=./prisma/schema.prisma 2>&1 | tail -5
  echo '   ✓ migration 应用完成 (idempotent, 无 pending 时不操作)'
"

# ── 5.4 ECS prisma generate + 同步到 apps/api/node_modules/.prisma ───
# 历史教训 (2026-05-28): 同事在 schema 里加了 PAYMENT_REQUEST enum 值,
# DB migrate 上去了, 但 ECS @prisma/client 还是旧 generated 版本 →
# 老板审批报 "Value 'PAYMENT_REQUEST' not found in enum 'DocumentType'".
# prisma migrate deploy 不会自动 regenerate client, 必须显式 prisma generate.
# 每次 schema 改 (加表 / 加字段 / 加 enum 值) 都得跑这步.
echo ""
echo "==> [5.4/8] ECS prisma generate + 同步 client 到 apps/api"
ssh_run "
  set -e
  cd $REMOTE/packages/db
  export \$(grep -E '^DATABASE_URL=' $REMOTE/.env | xargs)
  npx -y prisma@5.22.0 generate --schema=./prisma/schema.prisma 2>&1 | tail -3
  # 校验 generate 真的产出了 client (npx 网络挂掉会静默)
  test -d $REMOTE/packages/db/node_modules/.prisma/client || { echo '❌ prisma generate 没产出 client'; exit 1; }
  # 把新 generated client 同步到 apps/api 的 node_modules (运行时实际用的位置)
  rm -rf $REMOTE/apps/api/node_modules/.prisma
  cp -r $REMOTE/packages/db/node_modules/.prisma $REMOTE/apps/api/node_modules/.prisma
  echo '   ✓ prisma client 已 regenerate + 同步到 apps/api'
"

# ── 5.5 .env 一致性检测 (warn-only, 不阻断) ─────────
# 历史教训: 新代码加 env 变量, .env.example 更了但 ECS .env 没更.
# api 端大量 process.env.X || 'default' 或 ! non-null assert, 不会 fail-fast,
# 跑到该 endpoint 才报奇怪错误, 排查成本高. 这里只是提醒, 不阻断部署.
echo ""
echo "==> [5.5/8] ECS .env 一致性检测 (vs .env.example, warn-only)"
rsync_run .env.example "$SERVER:$REMOTE/.env.example" | tail -1
ssh_run "
  set -e
  MISSING=''
  for k in \$(grep -oE '^[A-Z_][A-Z0-9_]*=' $REMOTE/.env.example | sed 's/=//' | sort -u); do
    if ! grep -qE \"^\$k=\" $REMOTE/.env; then
      MISSING=\"\$MISSING \$k\"
    fi
  done
  if [ -n \"\$MISSING\" ]; then
    echo '   ⚠ ECS .env 缺以下 key (.env.example 里有):'
    for k in \$MISSING; do echo \"      - \$k\"; done
    echo '   → 部署不阻断, 但功能可能 lazy fail, 请尽快补'
  else
    echo '   ✓ ECS .env key 覆盖 .env.example'
  fi
"

# ── 6. pm2 restart api + web + cmb (硬重启, 比 reload 更彻底) ────────────────
# 历史教训 (2026-06-02 b5deea0 部署后 38 min 客户撞上 CSS 404):
#   pm2 reload 在 fork mode 下虽然等同 restart, 但 Next.js 14 standalone 内部 manifest cache
#   一旦因为 _error.js SSR 偶发 useContext null 进入 degraded mode, reload 信号不会 reset
#   内存里的 stale file table. 改 restart (硬杀进程) 100% 干净, 避免静态资源 404.
# 顺手清理 /app/dianjie-v4/apps/web/.next (May 9 老 standalone 目录残留, 跟现役混淆)
echo ""
echo "==> [6/8] pm2 restart api + web + cmb (硬重启 + 清理废弃旧 .next)"
ssh_run "
  # 清理 May 9 残留废弃目录 (跟现役 /app/dianjie-v4/apps/web/apps/web/.next 同名混淆)
  rm -rf $REMOTE/apps/web/.next 2>/dev/null || true
"
ssh_run "pm2 restart dianjie-v4-api --update-env" >/dev/null
ssh_run "pm2 restart dianjie-v4-web --update-env" >/dev/null
# cmb 是 Python 进程, restart 后会重跑 module-level 代码 (含 fail-fast 校验)
# .env 缺关键字段会直接 raise; 启动失败 pm2 会反复重启, 后面验证会抓到
ssh_run "pm2 restart dianjie-v4-cmb --update-env" >/dev/null
sleep 2  # 给 pm2 拉起新进程的最小窗口, 验证步骤自己会 retry

# ── 7. 验证 (静态产物 + 服务健康 + web E2E) ─────────────
echo ""
echo "==> [7/8] 部署后验证"
LOCAL_API_MD5=$(md5 -q apps/api/dist/index.js 2>/dev/null || md5sum apps/api/dist/index.js | awk '{print $1}')

# 静态产物校验立刻可做 (md5/文件存在), 不依赖进程起好
ssh_run "
  set -e
  test -f $REMOTE/apps/api/dist/routes/cmb.js || { echo '❌ cmb.js 不在'; exit 1; }
  test \$(grep -c cmbRoutes $REMOTE/apps/api/dist/index.js) -ge 1 || { echo '❌ cmbRoutes 没注册'; exit 1; }
  REMOTE_MD5=\$(md5sum $REMOTE/apps/api/dist/index.js | awk '{print \$1}')
  [ \"\$REMOTE_MD5\" = '$LOCAL_API_MD5' ] || { echo \"❌ MD5 不一致 local=$LOCAL_API_MD5 remote=\$REMOTE_MD5\"; exit 1; }
  echo '   ✓ 静态产物校验通过 (md5 / cmb.js / cmbRoutes 注册)'
"

# 服务健康用 retry-with-backoff, 给 cold-start 留时间
# 历史教训 (2026-05-28): 固定 sleep 4 + 一次 curl, 大 build 重启 + prisma client 加载会跑到 ~10s,
# 第一次 curl 还在 hang, 脚本误报失败. 实际服务已起好.
echo "   等 api + cmb 起好 (最多 30s)..."
ssh_run "
  for i in 1 2 3 4 5 6 7 8 9 10; do
    api_ok=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:4004/health 2>/dev/null || echo 000)
    cmb_relay_ok=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:4004/api/cmb/status 2>/dev/null || echo 000)
    cmb_self_ok=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:5001/health 2>/dev/null || echo 000)
    if [ \"\$api_ok\" = '200' ] && [ \"\$cmb_relay_ok\" = '401' ] && [ \"\$cmb_self_ok\" = '200' ]; then
      echo \"   ✓ api + cmb 健康 (第 \${i} 次 retry, api=\$api_ok cmb-relay=\$cmb_relay_ok cmb-self=\$cmb_self_ok)\"
      exit 0
    fi
    sleep 3
  done
  echo \"❌ api/cmb 服务 30s 内未就绪: api=\$api_ok cmb-relay=\$cmb_relay_ok cmb-self=\$cmb_self_ok\"
  echo '   pm2 logs dianjie-v4-api --lines 30 自查'
  exit 1
"

# Web E2E 验证 (2026-06-02 加固): 防止 Next.js 14 standalone _error.js 触发 cache 死锁
# 拉 HTML → 提 CSS path → 拉 CSS, 必须 200; 否则强制 pm2 restart 一次再试
# 失败 2 次才放弃, 留 .deployed-commit 不写, 让人来排查
echo "   验证 web (HTML + CSS 必须 200)..."
ssh_run "
  for attempt in 1 2; do
    HTML_BODY=\$(curl -sk --max-time 5 http://localhost:3204/v2/login 2>/dev/null)
    HTML_CODE=\$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3204/v2/login 2>/dev/null || echo 000)
    CSS_PATH=\$(echo \"\$HTML_BODY\" | grep -oE 'href=\"/_next/static/css/[^\"]+\"' | head -1 | sed 's/href=\"//; s/\"//')
    if [ -n \"\$CSS_PATH\" ]; then
      CSS_CODE=\$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \"http://localhost:3204\$CSS_PATH\" 2>/dev/null || echo 000)
      CSS_SIZE=\$(curl -sk -o /dev/null -w '%{size_download}' --max-time 5 \"http://localhost:3204\$CSS_PATH\" 2>/dev/null || echo 0)
    else
      CSS_CODE='no_path'
      CSS_SIZE=0
    fi
    if [ \"\$HTML_CODE\" = '200' ] && [ \"\$CSS_CODE\" = '200' ] && [ \"\$CSS_SIZE\" -gt 1000 ]; then
      echo \"   ✓ web 健康 (HTML=\$HTML_CODE, CSS=\$CSS_CODE, \${CSS_SIZE}b)\"
      exit 0
    fi
    if [ \"\$attempt\" = '1' ]; then
      echo \"   ⚠ web 异常 (HTML=\$HTML_CODE, CSS=\$CSS_CODE, \${CSS_SIZE}b), pm2 restart 一次再试...\"
      pm2 restart dianjie-v4-web --update-env >/dev/null
      sleep 6
    fi
  done
  echo \"❌ web 经 1 次 restart 后仍异常: HTML=\$HTML_CODE CSS=\$CSS_CODE size=\$CSS_SIZE\"
  echo '   pm2 logs dianjie-v4-web --lines 30 自查'
  exit 1
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
