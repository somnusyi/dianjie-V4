# 滇界 V4 发布记录：供应链加固整合 + 财务月结历史月份选择器

> 发布时间：2026-07-21 10:47（Asia/Shanghai）
> 发布提交：`96c490b0654e7ef14053be8d276c5709f08af477`（main）
> 上一生产提交：`0fabd1f4ecbfdada0fae829be4cd011489604583`
> 执行方式：`scripts/deploy-worktree.sh` 标准流程（部署锁、祖先检查、备份、迁移、构建、健康检查全部通过）

## 1. 本次发布内容

### 供应链加固移植（21 个提交，来源 release/20260715-p0）

按领域分五组移植到最新 main，未整分支覆盖：

| 组 | 内容 |
|---|---|
| 输入边界 | 商品价格/库存数值上限、订货数量金额上限、收货/配送/报损载荷校验（Prisma Decimal） |
| 分类并发 | 分类导入、排序、单商品归类的咨询锁串行化 |
| 收货状态机 | 拒收/作废状态抢占串行化；供应商入库批次编号并发 |
| 配送审计 | 发货/送达 opLog 入事务（日志失败业务事实整体回滚）、厨师验收与配送并发、发货重放 409 |
| 订货幂等 | 创建/改单同键同内容幂等、同键不同内容 409、并发创建可恢复 |
| 构建 | API 命令前置自动 regenerate Prisma 客户端（8 个 pre-hook） |

### 财务月结历史月份选择器（1 个提交 b0d6dd4 + 合并提交）

- 新增 `GET /api/profit/store/:storeId/closed-months`（仅 CONFIRMED 月结，倒序）
- 店长「营业 → 上月」可按月切换 4–6 月及以后任意已月结月份
- 不改变「月结不倒灌日报/实时营业额」边界

## 2. 发布前验证

- 生产备份副本（2026-07-21 10:29 导出）：62 条迁移全部在账、无 pending；整合后 schema 零漂移
- API 单元 121/121；PostgreSQL 集成 65/65；Web 16/16；API/Web tsc 通过
- 8 个专项 E2E（订货/配送/收货/报损/批次并发/分类并发）全绿
- 合并后 main 复测：API 121/121、Web tsc 通过

## 3. 发布过程要点

- 部署 worktree：`~/Desktop/dianjie-V4/dianjie-V4-deploy`
- 部署前自动备份：`/app/backups/dianjie_v4-deploy-bak-20260721-104707-96c490b.dump` 与同名 build tar.gz（回滚用）
- ECS migrate deploy：无 pending（迁移账本 62 条不变）
- warn-only 提示：ECS `.env` 缺 ALLOW_DEMO_SEED / MEITUAN_* 等 8 个 key，均属未启用功能（演示种子、美团），不阻断

## 4. 发布后核验（2026-07-21 10:51）

- `.deployed-commit` = `96c490b0654e7ef14053be8d276c5709f08af477` ✅
- `dianjie-v4-api` / `dianjie-v4-web` / `dianjie-v4-cmb` 全部 online ✅
- 迁移账本 62 条 ✅；API 近期日志 0 条 error ✅
- 外部访问 `/api/health` 200（db ok）、`/v2/login` 200 ✅
- GitHub `main` 已同步至 `96c490b`；Gitea 同步待凭证

## 5. 后续待办（不变）

- DJ002：账号创建绑定 → 初始盘点（模板已生成）→ 安全库存 → 小额采购跑通 → 首份日报
- 总厨按《INFERRED单位换算人工确认优先级_2026-07-21.xlsx》从高到低确认 274 个换算
- 在线盘点生产 UAT；连续 7 天日报对账；美团接入；Sentry/CI

## 6. 追加发布：会话续期修复（2026-07-21 13:20）

- 提交：`4aee0907b87397e74c255f848c10f97cd8d7e89e`（fix/auth-refresh-401-message 合入 main）
- 修复：apiFetch 过期判断未覆盖「未授权，请先登录」导致 30d refresh 从未生效（用户每 2h 被踢回登录）；旧 axios 封装 refresh 地址兜底 localhost:4000 改默认同源
- 验证：Web tsc + 16/16 单测；标准部署全部通过；`.deployed-commit` 已更新，三进程 online，`/v2/login` 200
- 该 bug 自初始导入即存在，与当日供应链加固发布无关
