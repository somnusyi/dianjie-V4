# 滇界 V4 · AI 协作者项目上下文

餐饮供应链 SaaS（订货/库存/BOM/财务/反馈）。pnpm monorepo。任务多来自真实用户反馈，**永远做最小改动**。

## 结构

- `apps/api` — Fastify + Prisma + PostgreSQL，路由在 `src/routes/`，业务服务在 `src/services/`
- `apps/web` — Next.js App Router，手机端页面在 `src/app/v2/`，纯逻辑抽在 `src/lib/`（配套 .test.ts）
- `packages/db` — Prisma schema 与客户端

## 常用命令

```bash
# Web 测试 + 类型（提交前必过）
pnpm --filter @dianjie/web test
pnpm exec tsc -p apps/web/tsconfig.json --noEmit

# API 测试 + 类型
cd apps/api && npx vitest run
cd apps/api && pnpm exec tsc --noEmit
```

## 硬性约定

- 入参一律 zod 校验；写操作必须记 OpLog（entityType/targetId 齐全）
- 多步写入用事务，并发敏感处加 `pg_advisory_xact_lock`
- OSS 附件：数据库里可能是过期签名 URL，读取返回前用 `resignOssUrls()` 重签（见 `apps/api/src/routes/upload.ts`）
- 权限/角色用现有 helper（如 `isInternalSupplyChainRole`、`requireSupplierCapability`），不发明新机制
- UI 沿用页面现有 Tailwind 类名与组件，不引入新依赖

## 禁区（除非任务书明确授权）

- 不改 `packages/db/prisma/schema.prisma`，不生成迁移
- 不碰库存扣减、资金、支付、权限模型相关代码
- 不执行 `git commit` / `git push` / 任何部署命令；只留工作区改动

## 生产常识（只读了解，不要操作）

- 生产目录 `/app/dianjie-v4`，源码 `/app/dianjie-src`；pm2 进程 `dianjie-v4-api`(4004) / `dianjie-v4-web`(3204)
- Web 重启禁止 `--update-env`（API 的 PORT=4004 会污染 Web 3204）

## 反馈驱动工作方式

任务书会给出：用户反馈原文、根因分析、允许改的范围、验收命令。先读懂相关代码再动手；拿不准设计取舍时选"改动更小、更符合现状"的方案。
