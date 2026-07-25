# 滇界云管 · 连锁餐饮数字化管理平台

滇界 V4 是面向连锁餐饮集团的多角色经营管理系统，覆盖订货、配送、收货、供应商库存、门店预计库存、营业与销量、菜品 BOM、对账、付款、发票、资金和凭证等闭环。

## 开发入口

- 当前架构、生产状态、业务口径、待办和多人协作规则：[TEAM_HANDOFF_2026-07-17.md](./TEAM_HANDOFF_2026-07-17.md)
- 项目质量门禁：[CLAUDE.md](./CLAUDE.md)
- 发布候选审计：[RELEASE_READINESS_2026-07-17.md](./RELEASE_READINESS_2026-07-17.md)
- 长时任务逐轮证据：[LONG_RUN_2026-07-16.md](./LONG_RUN_2026-07-16.md)

## 目录

```text
apps/web       Next.js 14 多角色前端与 Capacitor 容器
apps/api       Fastify + TypeScript 业务 API
apps/cmb       招行国密 Python 微服务
packages/db    Prisma schema、迁移和 seed
scripts        测试、部署、备份、回滚和迁移核验
```

## 本地启动

项目运行时契约为 Node.js 20.x、pnpm 10.32.1 和 Prisma 5.22.0。使用 nvm 时执行：

```bash
nvm use
corepack enable pnpm
pnpm env:check
pnpm install --frozen-lockfile
cp .env.example .env
docker-compose up -d
pnpm --filter @dianjie/db exec prisma generate
pnpm --filter @dianjie/db exec prisma migrate deploy --schema prisma/schema.prisma
pnpm dev
```

没有 nvm 时也必须使用 Node.js 20.x，并通过 Corepack 激活仓库 `packageManager` 指定的
pnpm 版本。本地环境必须使用隔离数据库，不能指向生产 RDS。测试账号由 seed 或项目负责人
提供，不在 README 中保存生产凭证。

## 提交前验证

```bash
pnpm --filter @dianjie/api test
pnpm --filter @dianjie/api build
pnpm --filter @dianjie/web test
pnpm --filter @dianjie/web exec tsc --noEmit
WEB_PORT=3299 pnpm --filter @dianjie/web build
PREVIEW_MODE=true DATABASE_URL="<本地 dianjie_v4_local URL>" bash scripts/verify-local-migration-chain.sh
```

生产只允许发布负责人从独立 worktree 执行 `scripts/deploy-worktree.sh`。禁止直接修改生产目录、手工同步半套产物或用 `prisma db push` 替代迁移。
