# Codex 交接：P1a AI 自动修复流水线（suggest 模式）实现

> 2026-07-26 · 交接人：Kimi · 执行人：Codex
> 设计文档（必读）：仓库根目录 `P1_AUTO_FIX_DESIGN_2026-07-26.md`
> 本文档 = 当前进展 + 实现任务拆解 + 代码/环境精确位置 + 验收标准。照此可实现，不需要重新考古。

---

## 0. 一句话任务

员工反馈被 Qwen 分诊为 BUG_BLOCKING 后，由 AI 自动完成「定位 → 出补丁 → 验证」，到 **PLAN_READY 停住**，超管手机一键批准后才走「部署 → 生产健康检查 → 闭环通报」。即设计文档的 **P1a（suggest 模式）**，不做全自动。

## 1. 当前进展（已完成，勿重复建设）

反馈系统 P0 已全部上线生产（commit `1ef13d53`）：

- `POST /api/feedback` 创建反馈 + Qwen 首轮澄清 + triage 分诊（`apps/api/src/routes/feedback.ts`）
- 分诊结果：`BUG_BLOCKING` → 企微紧急卡（仅 SUPER_ADMIN）；`IMPROVEMENT/NEW_FEATURE` → AWAITING_APPROVAL + 审批卡；`QUESTION` → CLOSED
- `POST /api/feedback/:id/decision` 批准/驳回（仅 SUPER_ADMIN）
- `POST /api/feedback/:id/resolve` 标记已解决 + OpLog + 消息中心通知提报人（仅 SUPER_ADMIN）
- 手机端：`/v2/feedback/new|mine|[id]` 用户侧；`/v2/boss/feedback` + `/v2/boss/feedback/[id]` 超管审批中心（含标记已解决按钮）
- PC 端：`/feedback` 全角色提交+对话；`/feedback/admin` 超管管理页
- 企微通知：`apps/api/src/services/notify/events.ts` 中 `FEEDBACK_URGENT_BUG` / `FEEDBACK_APPROVAL_PENDING`，defaultRoles 均为 `['SUPER_ADMIN']`

**7/26 已做过全链路演练**：埋 404 bug → 真实 API 提交 → Qwen 10s 分诊 BUG_BLOCKING → 企微通知 → 人工修复部署 → resolve 闭环，全程 7 分钟。缺的就是「AI 自动修复」这一段，即本任务。

## 2. 关键代码位置（精确到文件）

| 内容 | 位置 |
|---|---|
| 反馈路由（create/messages/mine/inbox/detail/decision/resolve） | `apps/api/src/routes/feedback.ts` |
| 分诊触发点（P1a 的 enqueue 挂钩在这里） | 同文件 `applyTriage()`（约 75 行），BUG_BLOCKING 分支 |
| Qwen 调用封装（复用，勿另写 client） | `apps/api/src/services/qwenChat.ts` — `qwenChat()`，env：`QWEN_API_KEY/QWEN_BASE_URL/QWEN_MODEL`，生产 model=`qwen3.8-max-preview`，超时 90s，强制思考模式（不能传 enable_thinking=false，会 400） |
| 分诊解析 | `apps/api/src/services/feedbackTriage.ts` |
| 企微/消息中心通知 | `apps/api/src/services/notify/`（事件注册在 `events.ts`）、`apps/api/src/services/notification.ts` 的 `sendNotification()` |
| Prisma schema（加表在这里） | `packages/db/prisma/schema.prisma`，包名 `@dianjie/db` |
| 超管审批中心（加「自动修复」入口/页） | `apps/web/src/app/v2/boss/feedback/`（手机）、`apps/web/src/app/feedback/admin/`（PC） |
| apiFetch（手机端请求封装，带 token 刷新） | `apps/web/src/lib/v2-auth.ts` |

## 3. 实现任务拆解（P1a）

### 3.1 数据层（唯一一次人工 review 的 migration）
- `packages/db/prisma/schema.prisma` 加 `AutoFixRun` 模型：
  - `id, tenantId, feedbackId(唯一), status(枚举: RECEIVED/ANALYZING/PLAN_READY/AWAITING_APPROVAL/PATCHING/VERIFYING/DEPLOYING/VERIFY_PROD/RESOLVED/FAILED_ROLLBACK/ESCALATED/REJECTED)`
  - `analysis(text, AI 定位结论), planSummary(text), diffPatch(text 完整 unified diff), diffFiles(json 文件列表+行数), error(text?), commitSha?, deployLog(text?), createdAt/updatedAt/decidedById/decidedAt`
- 跑 `prisma migrate dev` 生成 migration 并随 PR 提交

### 3.2 修复执行器（worker）
- 新服务 `apps/api/src/services/autofix/`（或独立 `apps/autofix`，建议先在 api 内做队列消费者，减少部署面）：
  - 触发：`applyTriage` 判定 BUG_BLOCKING 后调用 `enqueueAutoFix(feedbackId)`（同步建 AutoFixRun=RECEIVED，异步开跑，勿阻塞反馈请求）
  - 并发：PG advisory lock `hashtext('autofix:global')`，同时只跑一个；`AUTO_FIX_DAILY_CAP`（默认 3，按 createdAt 计数）；同一 feedback 24h 不重复
  - 急停开关：`AUTO_FIX_MODE=off|suggest`（P1a 只有这两档，默认 off；为 auto 预留枚举值但本阶段不实现）
- 分析+补丁（两步提示词）：
  1. **ANALYZING**：输入=反馈内容+对话+context.path+候选文件清单（按 path 猜路由文件+其 import 闭包，限制总 token），输出=定位结论 JSON `{rootCause, candidateFiles[], inWhitelist, confidence}`
  2. **PATCHING**：输出 unified diff。硬性校验（代码实现，非提示词约束）：
     - diff 能 `git apply --check` 通过
     - 触碰文件全部在白名单（见 §5 红线清单，用路径 matcher 实现）
     - ≤5 文件且 ≤200 行
     - 任一失败 → 重试至多 2 次 → ESCALATED
- 到 PLAN_READY 后：企微卡片通知超管（新事件 `AUTOFIX_PLAN_READY`，textcard 链接到审批详情页）→ 状态 AWAITING_APPROVAL

### 3.3 审批与部署（固定脚本，AI 只产 diff）
- 新路由 `apps/api/src/routes/autofix.ts`（全部仅 SUPER_ADMIN）：
  - `GET /api/autofix/runs?status=` 列表
  - `GET /api/autofix/runs/:id` 详情（含 diffFiles 摘要，diff 全文分段取）
  - `POST /api/autofix/runs/:id/approve` → 执行固定部署流程（下方）
  - `POST /api/autofix/runs/:id/reject` → REJECTED + 通知
  - `POST /api/autofix/runs/:id/rollback` → 固定回滚脚本
- 部署流程（写在 api 内的固定函数，调 shell，**不接受 AI 生成的任何命令**）：
  1. 在 `/app/dianjie-src`（见 §4 前置）`git apply` diff → `git commit` → `git tag autofix-<runId>`
  2. 按触碰范围构建：web-only → `pnpm --filter web build`；触碰 api → 加 `pnpm --filter api build`（即 tsc）
  3. 产物同步（与现行部署一致，见 §4）→ `pm2 restart dianjie-v4-web`（和/或 `dianjie-v4-api`）
  4. 健康检查 60s：`/api/health` 200 + 反馈 context.path 页面 200
  5. 失败 → `git revert` + 重新构建恢复 + 状态 FAILED_ROLLBACK + 企微 🚨
  6. 成功 → 自动调内部逻辑复用 resolve：反馈置 RESOLVED + 对话追加解决说明 + `sendNotification` 通知提报人 + 企微通报超管（含「一键回滚」入口链接）

### 3.4 前端
- 手机：`/v2/boss/feedback` 加「自动修复」tab 或入口卡片 → run 详情页（定位结论/diff 摘要/部署日志 + 批准/驳回/回滚按钮，复用现有 ConfirmSheet）
- PC：`/feedback/admin` 加对应 tab（可放二期，手机优先——老板主要在手机处理）
- OpLog：approve/reject/rollback/每步状态迁移都写 `isAi` 标记

## 4. 环境事实（服务器前置条件，Codex 应先做并验证）

- 服务器：`root@116.62.32.162`，应用目录 `/app/dianjie-v4`（**不是 git 仓库，无 web 源码**，只有 standalone 产物）
- pm2 进程：`dianjie-v4-api`（`/app/dianjie-v4/apps/api/dist/index.js`，端口 4004）、`dianjie-v4-web`（`/app/dianjie-v4/apps/web/apps/web/server.js`，端口 3204）
- 服务器已有 pnpm 10.32.1 + node 20.20.1；内存 3.5G（常驻占 ~1.3G）→ **必须先加 2G swap** 再实测 web 构建，否则 OOM
- **前置步骤**：服务器新建 `/app/dianjie-src` = GitHub 仓库克隆（配只读 deploy key）→ `pnpm install`（Linux 原生依赖，注意 sharp 等平台包，Mac 的 node_modules 不可复用）→ 低峰实测 `pnpm --filter web build` 成功且内存安全
- 现行部署路径（保持一致）：
  - api：本地/源码机 `apps/api` `tsc` → rsync `dist/` → `/app/dianjie-v4/apps/api/dist/`
  - web：`apps/web` build → rsync `.next/standalone/apps/` → `/app/dianjie-v4/apps/web/apps/`；`.next/static/` → `/app/dianjie-v4/apps/web/apps/web/.next/static/`；`public/` → `/app/dianjie-v4/apps/web/apps/web/public/`
  - **不要 rsync node_modules**（Mac 构建含 darwin 二进制，会搞坏服务器；源码机上 Linux 构建则无所谓，但仍建议排除）
- 生产 `.env`（`/app/dianjie-v4/apps/api/.env`）已配 `QWEN_API_KEY/QWEN_BASE_URL/QWEN_MODEL`；worker 环境不挂生产 .env，Qwen key 单独从受限配置读
- 仓库：`github.com:somnusyi/dianjie-V4.git`，main 分支，commit 规范见 git log（`feat(feedback): ...` 中文摘要）

## 5. 红线清单（必须实现为代码级 matcher，不能只写进提示词）

**硬拒绝路径**（diff 触碰即 ESCALATED 并报警）：
- `.env*`、`**/prisma/schema.prisma`、`**/prisma/migrations/**`
- `**/auth*.ts`、`**/authTokens.ts`、`**/auth-scope.ts`、登录/刷新/JWT 相关路由
- `apps/api/src/routes/{payments,finance,cashbook,reconciliations,approval}*.ts` 及对应 services
- 库存写路径：`storeInventory.ts`、`receiptSettlement.ts`、`receiptDerivatives.ts`、`inventoryCosting.ts`
- `package.json`、`pnpm-lock.yaml`、`scripts/deploy-*`、pm2/nginx 任何配置
- `apps/api/src/services/notify/**`（报警通道本身）
- 禁止：删除文件、force push、`prisma migrate`/`db push`、任何写 SQL（分析阶段只允许 SELECT）

**白名单**：
- `apps/web/src/app/**`、`apps/web/src/components/**`（排除 `AppLayout.tsx` 中权限判断函数段——用 diff hunk 级检查，碰到 `isVisible`/`MANAGER_HIDDEN`/`roles` 行即拒绝）
- `apps/api/src/routes/**` 中仅 GET 只读路由的输出整形（不含上面硬拒绝清单）

## 6. 验收标准（Codex 自测清单）

1. `AUTO_FIX_MODE=off` 时全链路零行为变化（回归：提交反馈分诊通知正常）
2. `suggest` 模式下提交一条测试 BUG_BLOCKING 反馈 → 5 分钟内 AutoFixRun 到 AWAITING_APPROVAL，企微收到方案卡片
3. 越红线 diff（人为构造改 auth 文件的 case）→ 直接 ESCALATED，无部署动作
4. 超管批准 → 部署成功 → 健康检查通过 → 反馈自动 RESOLVED + 提报人收通知 + 超管收通报
5. 健康检查失败场景（可构造坏 diff 但不越红线）→ 自动 revert + 生产恢复 + FAILED_ROLLBACK 报警
6. 一键回滚 → 生产回到修复前 commit
7. 每日上限与并发锁生效（并发提交 3+ 条反馈只串行处理）
8. 全部 OpLog/AutoFixRun 审计完整

## 7. 协作约定

- 在 main 分支小步提交，commit 中文摘要；不要动红线文件；不要改生产 .env
- 遇到与设计文档冲突的实现细节，在 PR 描述里说明取舍，不要静默偏离
- 有疑问的开放问题（回滚是否做企微回调、PC 管理页是否本期做）按本文档默认：回滚走审批中心页面按钮、PC tab 可二期
