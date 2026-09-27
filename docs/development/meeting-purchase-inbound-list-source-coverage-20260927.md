# 采购入库列表来源覆盖（2026-09-27）

## 目标

`采购入库` 管理列表同时覆盖两类已有事实：

- `UpstreamReceipt`：现有采购收货单。
- `WarehouseDoc(type=MANUAL_INBOUND)`：仅纳入已关联 `supplierId` 的手工入库单。

不变更数据库结构、路由合同或前端。

## 合并规则

- 两类根查询均强制 `tenantId`；仓库和创建人名称也仅在当前租户内批量查询。
- 手工入库单没有 Prisma 仓库 relation，因此仓库筛选先解析为当前租户的仓库 ID，再同时应用于两类来源。
- 物品筛选对收货单使用产品名称/编码，对手工入库单使用行上的 `productName` 历史快照。
- 合并后按入库业务时间倒序（收货单 `postedAt`，手工入库单 `effectiveAt`），同时间先收货单、后手工入库单，最后按原始 ID 倒序打破平局。
- 响应 ID 使用 `receipt:<id>` 和 `warehouse-doc:<id>` 命名空间，防止异源原始 ID 冲突。
- 每个来源单独拒绝超过 10,000 条，合并数组再次拒绝超过 10,000 条，避免两个未超限来源绕过总上限。
- 选项、后置筛选、金额汇总、分页和导出继续共用同一个已排序合并集合。
- 该服务只读取业务事实，不创建仓库单或台账流水；集成测试在读取前后比对两类记录数量。
- 关联供应商的手工入库单暂时会同时出现在既有“其他入库”和“采购入库”视图。这是两个列表对同一单据事实的分类展示，不会重复入账；集成测试同时验证该单据仍在未改动的“其他入库”查询中可见，且查询前后仓库单、单据行、台账流水和台账余额数量均不变。

## 字段语义

| 字段 | 采购收货单 | 手工入库单 |
| --- | --- | --- |
| 供应商 | 关联供应商名称 | `supplierName` 历史快照，为空时保持空，不用当前供应商名覆盖 |
| 上游单号 | 采购订单号 | 空 |
| 状态 | 保留现有收货状态映射 | `已入库` |
| 复审 | 空 | `REVIEWED` → `已复审`，`UNREVIEWED` → `未复审` |
| 附件 | 保留 `evidence` 数组的现有数量展示，不改写历史凭证 | 空 |

## 验证覆盖

新增服务集成测试覆盖：

- 两来源字段映射、命名空间 ID、同时间稳定排序。
- 历史供应商快照为空时不回填当前名称。
- 收货凭证计数与手工入库附件为空。
- 仓库、物品、供应商、复审、上游单号和两种日期字段筛选。
- 合并后分页、金额汇总、选项和导出集合。
- 跨租户隔离和合并后 10,000 条上限。

## 本地验证结果

- Node `20.20.2`：`pnpm --filter @dianjie/api exec tsc --noEmit` 通过。
- 单元回归：`pnpm --filter @dianjie/api exec vitest run tests/routes/inventoryManagement.test.ts --reporter=verbose` ，17 项通过。
- 专用 `_ci` 数据库：`pnpm --filter @dianjie/api exec vitest run --config vitest.integration.config.ts tests/services/inventoryManagementPurchaseIn.integration.test.ts --pool=forks --maxWorkers=1 --reporter=verbose` ，4 项通过。
- 现有路由集成回归：`pnpm --filter @dianjie/api exec vitest run --config vitest.integration.config.ts tests/routes/inventoryManagement.integration.test.ts --pool=forks --maxWorkers=1 --reporter=verbose` ，6 项通过。
- 主控复跑新旧两份数据库集成：2 文件、10 项通过；API TypeScript（`--noEmit --incremental false`）通过。
- 完整 API 单元回归：119 文件、1194 项通过。
- 完整隔离数据库集成回归：41 文件、277 项通过；使用 `dianjie_meeting_noon_20260924_ci`，未连接生产数据库。
- `git diff --check` 通过。该改动没有前端视觉变化，不以浏览器截图代替服务与数据库验收。
