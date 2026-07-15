# 滇界 V4 · 部署脚本说明

> 全部脚本都在 `scripts/` 下，2026-05-13 新增。
> 标准约定：所有可能动生产的脚本**首次执行前必须 `--dry-run` 看一遍**。

---

## 前置：环境变量

所有脚本读两个 env：

```bash
export V4_SSH_PASSWORD='<redacted>'    # ECS root 密码
export V4_DB_PASSWORD='<redacted>'     # RDS dianjie_v4 密码
```

**强烈建议尽快改成 SSH key + ~/.pgpass 免密**（详见末尾「SSH key 一次性配置」）。

---

## 脚本清单

### `deploy.sh` · 标准部署
完整 7 步流程：**预检 → 构建 → 备份 DB → 备份 build → 上传 → migrate → reload → smoke 验收**

```bash
./scripts/deploy.sh                  # 完整流程
./scripts/deploy.sh --dry-run        # 只打印步骤不执行
./scripts/deploy.sh --skip-tests     # 跳过 smoke test（紧急时）
```

预检会拦截：
- git 有未提交改动
- 本地落后 origin/main
- 当前不在 main 分支（会问你）

每次 deploy 自动留 2 份备份：
- `/app/backups/v4-build-bak-<TS>.tar.gz`（编译产物快照）
- `/app/backups/dianjie_v4-deploy-bak-<TS>.dump`（DB pg_dump）

两份都自动留 30 天。

### `rollback.sh` · 紧急回滚

```bash
./scripts/rollback.sh                            # 回滚到最近一次 build 备份（不动 DB）
./scripts/rollback.sh 20260513-103000            # 回滚到指定 tag
./scripts/rollback.sh --list                     # 列所有可用备份
./scripts/rollback.sh --with-db <tag>            # 同时回滚 DB（⚠️ 会丢 deploy 后数据）
```

**默认不回滚 DB** —— web/api code 回滚通常已经能解决问题，DB 回滚意味着丢失新写入的真实业务数据。只有数据被严重破坏才用 `--with-db`。

### `backup-db.sh` · 单独触发 DB 备份
deploy.sh 内部会自动调，平时也可单独跑（升 schema 前手动多留一份）：

```bash
./scripts/backup-db.sh
```

### `smoke-test.sh` · 烟雾测试
deploy.sh 内部最后一步会自动调。也能独立跑（任何时候健康巡检）：

```bash
./scripts/smoke-test.sh                          # 测生产 https://app.dianjie.cc
./scripts/smoke-test.sh http://localhost:4444    # 测本地
```

实际跑 3 项：
1. `/api/health` curl
2. `e2e-full-flow.js`（全 6 角色 API 链路）
3. `ui-smoke.js`（Playwright headless 6 角色登录）

---

## 已有的业务脚本（somnusyi 留下，复用）

| 脚本 | 用途 |
|---|---|
| `e2e-full-flow.js` | 6 角色完整业务链路 API 测试（采购→收货→付款→报损→对账） |
| `ui-smoke.js` | Playwright 浏览器烟雾测试 |
| `infer-moq-from-spec.js` | 商品规格推算最小订货量（一次性数据脚本） |
| `migrate-add-moq.sql` | 手写 SQL（不在 Prisma migrations 体系内，**纯历史，勿用**） |
| `sync-stock-from-snapshot.js` | 库存同步（一次性数据脚本） |

---

## 标准开发 / 部署工作流

```
┌─ 本地开发 ──────────────────────────────────────────────┐
│                                                           │
│  cd ~/Desktop/dianjie-V4/dianjie-V4                       │
│  git checkout -b feat/xxx                                 │
│                                                           │
│  # 改代码 ...                                              │
│                                                           │
│  # 如果改 schema:                                          │
│  cd packages/db                                           │
│  npx prisma migrate dev --name add_xxx_field              │
│  # ⬆️ 生成 migrations/<TS>_add_xxx_field/migration.sql    │
│  # 文件入 git                                              │
│                                                           │
│  pnpm dev          # 本地跑                                │
│  ./scripts/smoke-test.sh http://localhost:4444  # 本地烟雾 │
│                                                           │
│  git add . && git commit -m "feat: xxx"                   │
│  git push origin feat/xxx                                 │
│                                                           │
└───────────────────────────────────────────────────────────┘
                            │
                            ▼ (PR review，merge to main)
┌─ 部署生产 ──────────────────────────────────────────────┐
│                                                           │
│  git checkout main && git pull                            │
│                                                           │
│  export V4_SSH_PASSWORD=... V4_DB_PASSWORD=...            │
│  ./scripts/deploy.sh --dry-run    # 看一眼会跑啥           │
│  ./scripts/deploy.sh              # 真跑                   │
│                                                           │
│  # 观察 Sentry / OpLog 30 分钟                             │
│                                                           │
│  # 万一炸了 →                                              │
│  ./scripts/rollback.sh                                    │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

---

## 红线（绝对不能做）

1. ❌ **直接在生产改代码 / 改 schema**（`/app/dianjie-v4/` 是部署产物目录，不是工作区）
2. ❌ **本地 `prisma db push` 之后直接部署**（push 不生成 migration 文件，prod 会 schema drift）
3. ❌ **跳过 deploy.sh 手工 scp**（漏 migrate / 漏 reload 概率极高）
4. ❌ **直接 `psql` 改生产数据**（除非紧急修脏数据，且做 dump 备份）
5. ❌ **`pm2 delete` v4 进程**（用 `pm2 reload` 或 `pm2 restart`，否则要重写 ecosystem 配置）

---

## SSH key 一次性配置（推荐尽早做）

把 `V4_SSH_PASSWORD` 这个明文删掉，改用 SSH key：

```bash
# 1. 生成 key（如果还没有）
ssh-keygen -t ed25519 -C "reedom-dianjie-deploy" -f ~/.ssh/dianjie_deploy

# 2. 上传到服务器
ssh-copy-id -i ~/.ssh/dianjie_deploy.pub root@116.62.32.162

# 3. ~/.ssh/config 加：
cat >> ~/.ssh/config <<'EOF'
Host dianjie-prod
  HostName 116.62.32.162
  User root
  IdentityFile ~/.ssh/dianjie_deploy
EOF

# 4. 把所有脚本里 sshpass -p ... → ssh dianjie-prod
#    rsync -e "sshpass -p ... ssh ..." → rsync -e "ssh"

# 5. 关闭密码登录（高安全等级，可选）：
#    /etc/ssh/sshd_config: PasswordAuthentication no
#    systemctl restart sshd
```

数据库走 `~/.pgpass`：

```bash
cat >> ~/.pgpass <<'EOF'
pgm-bp14m7g69y66165r.pg.rds.aliyuncs.com:5432:dianjie_v4:dianjie_v4:<redacted>
EOF
chmod 600 ~/.pgpass
```

之后所有 `PGPASSWORD=... psql/pg_dump` 都可以省掉前缀。

---

## 后续可做（不强求）

- [ ] **GitHub Actions CI**：push 到 PR 自动跑 `pnpm build + pnpm test + e2e`，merge 到 main 自动 `deploy.sh`
- [ ] **Staging 环境**：同台 ECS 起 V4 第二份（端口 4445/3205 + DB `dianjie_v4_staging` + nginx `stage.dianjie.cc`），先 staging 验收再 prod
- [ ] **monitoring**：把 Sentry DSN 真正配上（现在 .env 是空的）+ 接 PagerDuty / 企微告警
- [ ] **deploy.sh 加 Slack / 企微 webhook 通知**
