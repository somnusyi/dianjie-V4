# V5 入库 / 收货更正业务拆分设计报告

- 分支：`design/20260726-correction-split-kimi`
- 基准：`1875db2cbfa2d752465c11d2a658910bf7bd293d`
- 文件：`reports/V5_INBOUND_RECEIPT_CORRECTION_SPLIT_2026-07-26.md`
- 说明：上一版 `1d7c548` 已判定不可集成，本报告不复制其状态机、角色矩阵与回滚命令。

## 1. 结论：两条完全独立的业务链

### 1.1 供应链仓入库更正

- 触发条件：手工入库（`POST /api/supplier/stock/inbound`）或库存导入（`POST /api/supplier/stock/import-snapshot`）已落账后发现错误。
- 核心约束：原入库事实（`SupplierStockMovement`、`SupplierStockBatch` 源头批次）**不可覆盖**；只通过新增关联更正单 + 新的 WarehouseStock / movement / batch 流水来调整供应链仓库存。
- 当前现状：数据库尚无独立 `Warehouse` / `WarehouseStock` 表，供应链仓逻辑由 `Product.stock` + `SupplierStockMovement` + `SupplierStockBatch` 表达，且只有一个硬编码默认仓 `default`（`apps/api/src/services/defaultWarehouse.ts:3-8`）。未来该业务链要么复用现有供应商库存表并新增 `correctionOfId` 等审计字段，要么通过 migration 新建 warehouse 维度表。

### 1.2 门店收货更正

- 触发条件：`Receipt` 已确认（`CONFIRMED`/`ACCOUNTED`）后发现实收数量/金额错误。
- 核心约束：原 `Receipt` / `ReceiptItem` 和四单位/金额快照**不可覆盖**；只调整门店库存派生、配送差异、应付与审计。
- 关键隔离：**门店收货更正不得恢复供应链仓库存**。实际发货已按配送扣仓（`consumeSupplierStockForShipment`），少收可能是短缺、破损或记录错误，只形成门店侧库存 / 差异 / 应付更正。只有另一条经确认的配送/发货更正业务才能影响供应链仓，本报告不设计该业务。

## 2. 角色边界（已确认规则）

| 角色 | 可写领域 | 禁止事项 |
|------|----------|----------|
| `SUPPLY_CHAIN` | 商品主数据、供应链仓库存与跨店供应链只读 | 可发起供应链仓入库更正；不得改门店实收、应付或报损裁决 |
| `ADMIN` / `SUPER_ADMIN` | 系统治理与租户级排障 | 除非后续业务政策明确，不代替业务角色直接写更正流水 |
| `MANAGER` / `KITCHEN_LEAD` | 本店既有收货确认/报损/拒收/作废草稿 | 已确认 Receipt 更正的发起权仍待确认，默认阻断；不能发起仓库入库更正 |
| `CHEF` / `CHEF_DIRECTOR` | BOM、店内报损审核、跨店库存/消耗只读 | **不得发起仓库或收货更正** |
| `FINANCE` | 付款、对账、凭证 | 不能发起收货更正，只能审批/付款 |
| `SUPPLIER_OWNER` / `SUPPLIER_STAFF` | 现有供应商域的既有能力 | 不把当前 `inventory.manage` 复用成内部仓更正权限；未来外部供应商小程序不进入本实现 |

当前 `apps/api/src/lib/internal-supply-chain-access.ts` 只列出内部角色已经落地的五项只读
capability，这是实现缺口，不是最终业务权限定义。后续内部仓更正必须新增窄权限并只授予
`SUPPLY_CHAIN`，不能借用供应商域的 `inventory.manage`。

## 3. 当前链路逐文件审计

### 3.1 供应链仓入库 / 导入链

| 文件 | 入口 | 状态变更 | 快照/不可变 | 权限 | Scope | 幂等 / 并发 | 通知 / 审计 |
|------|------|----------|-------------|------|-------|-------------|-------------|
| `apps/api/src/routes/supplierStock.ts:418-496` | `POST /api/supplier/stock/inbound` | 对每行 `Product.stock += qty`；创建 `SupplierStockMovement`（`INBOUND_MANUAL`/`INBOUND_EXCEL`）；再创建正批次（`SupplierStockBatch.kind='INBOUND'`） | `SupplierStockMovement` / `SupplierStockBatchAllocation` append-only；`Product.stock` 可变 | `inventory.manage` | `tenantId + supplierId`，默认仓 `default` | `lockSupplierProducts` 按 id 排序 `FOR UPDATE`；同请求内 `batchNo` 去重；全局 `@@unique([tenantId, productId, batchNo])`；**无请求级 idempotencyKey** | `createdById`、reason；无额外通知 |
| `apps/api/src/routes/supplierStock.ts:589-709` | `POST /api/supplier/stock/import-snapshot` | 每 SKU 单独事务：`Product.stock = qty`；创建 `ADJUSTMENT` movement；调用 `applySupplierStockBatchDelta` 同步批次 | 同上；未建档 SKU 整批拒绝；同名 SKU 咨询锁串行 | `inventory.manage` | `tenantId + supplierId`，默认仓 | `pg_advisory_xact_lock(hashtext('supplier-stock-snapshot:' + tenantId + ':' + supplierId + ':' + name))`；**无 idempotencyKey** | `sourceType='Snapshot'`、reason；返回 adjusted/skipped/failed |
| `apps/api/src/routes/supplierStock.ts:498-540` | `POST /api/supplier/stock/adjust` | 直接设置 `Product.stock = newQty`；创建 `ADJUSTMENT` movement；批次按 delta 增减 | 同上 | `inventory.manage` | `tenantId + supplierId` | `FOR UPDATE`；校验 `newQty >= ACTIVE 预占` | reason 必填 |
| `apps/api/src/routes/supplierStock.ts:542-587` | `POST /api/supplier/stock/loss` | `Product.stock -= qty`；创建 `LOSS` movement；按 FEFO 消耗批次 | 同上 | `inventory.manage` | `tenantId + supplierId` | `FOR UPDATE`；校验不击穿预占 | reason 必填 |
| `apps/api/src/services/supplierStockBatch.ts:39-61` | `createSupplierStockBatchIncrease` | 新增 `SupplierStockBatch`，`initialQty = remainingQty = delta` | `sourceMovementId @unique` | 由上游调用者鉴权 | `tenantId + supplierId + productId` | 要求调用方已持有 `Product` 行锁 | - |
| `apps/api/src/services/supplierStockBatch.ts:68-130` | `consumeSupplierStockBatches` | 选中 `remainingQty > 0` 批次 `FOR UPDATE`，扣减并写 `SupplierStockBatchAllocation` | append-only allocation | - | - | 按 `OPENING` → FEFO → 时间排序加锁 | - |
| `apps/api/src/services/supplierStockReservation.ts:132-208` | `consumeSupplierStockForShipment` | 发货时 `Product.stock -= shippedQty`；创建 `OUTBOUND_PO` movement；消耗批次；更新预占状态 | `SupplierStockReservation` 可变（`ACTIVE/RELEASED/CONSUMED`） | 订货/配送流程 | `tenantId + supplierId` | `SELECT ... FOR UPDATE` 行锁；发货幂等见 `orders.ts:1149-1238` | - |
| `apps/api/src/services/defaultWarehouse.ts:3-8` | `DEFAULT_WAREHOUSE_META` | 硬编码 `id='default'`，`name='默认仓'` | 冻结对象 | - | - | `requireDefaultWarehouse` 拒绝非 `default` | - |

### 3.2 门店收货确认 / 派生链

| 文件 | 入口 | 状态变更 | 快照/不可变 | 权限 | Scope | 幂等 / 并发 | 通知 / 审计 |
|------|------|----------|-------------|------|-------|-------------|-------------|
| `apps/api/src/routes/receipts.ts:385-449` | `PATCH /api/receipts/:id/confirm` | 写 `ReceiptItem` 四单位/库存快照（`ensureReceiptInventoryUnitSnapshots`）；状态 `CONFIRMED` + `confirmedAt`；事务外生成凭证 + 对账单 + 账期（`ACCOUNTED`） | `ReceiptItem` 各种 `*Snapshot` 冻结；`Receipt.totalAmount` 为确认事实 | `MANAGER/KITCHEN_LEAD/ADMIN/SUPER_ADMIN`；门店角色限本店 | `tenantId + storeId + supplierId` | `updateMany` + `claimed.count !== 1` 判定；`deliveryOrderId @unique`；财务派生用 `pg_advisory_xact_lock(hashtext('receipt-finance:' + receiptId))`；重复确认返回 `duplicated: true` 并重新 `ensureReceiptDerivatives` | `OpLog`；`notifyReceiptConfirmed`；刷新 dashboard cache；`revalueStoreConsumptionCosts` |
| `apps/api/src/routes/receipts.ts:452-592` | `PATCH /api/receipts/:id/confirm-with-loss` | 逐行更新 `ReceiptItem.quantity/amount` 为实收；创建 `LossClaim`（`ARRIVAL_SHORTAGE`、`NET_AT_RECEIPT`、`APPROVED`）；再生成凭证/账期 | 同上；`LossClaimItem` 含 ordered/received/loss Qty 与快照 | 同上 | 同上 | 同上 + `LossClaim.no` 串行生成 | `OpLog`；`notifyReceiptConfirmed` 带 loss 金额 |
| `apps/api/src/routes/receipts.ts:595-621` | `PATCH /api/receipts/:id/reject` | 状态 `REJECTED` + `rejectReason` | - | 同上 | 同上 | `updateMany` 乐观锁 | `OpLog` |
| `apps/api/src/routes/receipts.ts:624-646` | `PATCH /api/receipts/:id/void` | 仅 `DRAFT/PENDING/PENDING_CONFIRM` 可作废；取消 `PENDING/NOTIFIED` 的 `PaymentSchedule` | **已确认（CONFIRMED/ACCOUNTED）不可作废** | 同上 | 同上 | `updateMany` 乐观锁 | `OpLog` |
| `apps/api/src/services/receiptDerivatives.ts:16-64` | `ensureReceiptDerivatives` | 生成 `Voucher`（借 1405 / 贷 2202，非 HEADQ 仓）；调用 `autoProcessAfterConfirm` 创建 `PaymentSchedule` + `Reconciliation` + `ReconciliationItem`；Receipt 推进 `ACCOUNTED` | `Voucher` 通过 `@@unique([tenantId, sourceType, sourceId])` 防重 | - | `tenantId` | `receipt-finance` advisory lock；凭证/对账/账期幂等 | `OpLog`（自动补全） |
| `apps/api/src/services/receiptSettlement.ts:20-61` | `setReceiptSettlementAmountInTransaction` | 调整 `PaymentSchedule.amount` 与 `ReconciliationItem.amount`，重聚合对账单总额 | `Receipt.totalAmount` 不变；下游 settlement 可变 | 报损仲裁/差异处理 | `tenantId` | 若对账单已 `PAYING/PAID` 则抛错 | - |
| `apps/api/src/services/storeInventory.ts:162-357` | `estimatedStoreInventory` | 从最近盘点快照滚动：加 `ReceiptItem.inventoryQuantity`（`CONFIRMED`/`ACCOUNTED`），减 `StockConsumption`（`voidedAt=null`），减店内报损 | 门店库存是**计算值**，无实时流水 | 读路径 | `tenantId + storeId` | - | - |
| `apps/api/src/services/paymentSchedule.ts:28-184` | `autoProcessAfterConfirm` | HEADQ 仓短路；否则创建 `PaymentSchedule` + `Reconciliation`，`Receipt.status='ACCOUNTED'` | `PaymentSchedule.receiptId @unique`、`ReconciliationItem.receiptId @unique` | 自动 | `tenantId + supplierId + storeId?` | `receipt-finance` advisory lock；>¥2000 需审批 | `notifyApprovalPending`；`PAYMENT_LARGE` 企微事件 |
| `apps/api/src/services/lossClaimResolution.ts` + `lossClaims.ts:483-747` | 供应商处理 / 总厨仲裁 | 调整 `PaymentSchedule` 状态与金额；`LossClaim.status` 流转 `PENDING→APPROVED/REJECTED/RESOLVED` | `LossClaim` 事实不可改，状态可变 | 供应商处理/总厨/老板 | `tenantId + storeId + supplierId?` | `pg_advisory_xact_lock(hashtext('loss-handle:' + claimId))` | `notifyLossClaimResult`；`LOSS_AGREED`/`LOSS_REJECTED` 事件 |

## 4. 状态机与原单关系

### 4.1 供应链仓入库 / 调整

```
Product.stock ──(+qty)──► SupplierStockMovement(INBOUND_MANUAL/EXCEL/ADJUSTMENT)
                                │
                                ▼
                        SupplierStockBatch(INBOUND/ADJUSTMENT/OPENING)
                                │
                                ▼
                        SupplierStockBatchAllocation(出库/报损/负调整)
```

- 原单关系：`SupplierStockBatch.sourceMovementId` 指向产生它的 movement；allocation 指向消耗它的 movement。
- 当前无冲销：写错只能再发 `ADJUSTMENT` 或 `LOSS` 做反向调整。
- 预占约束：任何负向修正必须保证 `Product.stock - 修正量 ≥ ACTIVE 预占`。

### 4.2 门店收货

```
DRAFT ──► PENDING / PENDING_CONFIRM ──► CONFIRMED ──► ACCOUNTED
  │            │                        ▲   │
  └────────────┴─ VOID / REJECTED       └───┘ (确认后不可 void，只可通过更正单修正)
```

- 原单关系：`Receipt.deliveryOrderId @unique`、`PaymentSchedule.receiptId @unique`、`ReconciliationItem.receiptId @unique`、`Voucher(sourceType='Receipt', sourceId=receiptId) @@unique`。
- `ReceiptItem` 没有独立状态；确认后不可原地修改 `quantity/amount`。
- 报损确认会原地覆盖 `ReceiptItem.quantity/amount` 并生成 `LossClaim`；这是**确认前**的调整入口，不是确认后的更正。

## 5. 测试矩阵

### 5.1 供应链仓入库更正

| 场景 | 预期 |
|------|------|
| 原入库后无后续出库/预占 | 新增 correction movement + 反向/补差 batch；原 movement/batch 不变 |
| 原入库批次已被 FEFO 消耗 | 默认阻断，需业务确认（真实历史修正 / 已消耗批次） |
| 负向修正导致库存 < 0 | 默认阻断，需业务确认 |
| 负向修正导致库存 < ACTIVE 预占 | 阻断，提示先释放预占 |
| 重复提交同一 correction | 应返回 `duplicated: true` 或幂等键冲突，不重复记账 |
| 并发修正同一 SKU | `FOR UPDATE` 串行，后提交收到 409 |
| `SUPPLY_CHAIN` 发起、供应商/门店角色尝试发起 | 内部角色按 tenant+warehouse 写入；供应商/门店角色 403 |
| 已关账月份 | 默认阻断，需财务 reopen 或挂下月调整 |

### 5.2 门店收货更正

| 场景 | 预期 |
|------|------|
| Receipt `CONFIRMED` 未付款 / 未关账 | 新增 correction document；反向/补差门店库存、差异、应付；原 Receipt 不变 |
| Receipt `ACCOUNTED` 且 `PaymentSchedule` 已 `PAID`/`PROCESSING` | 默认阻断 |
| 原收货含 `LossClaim`（`PENDING`） | 撤销或重建差异；不得改原 claim |
| 原收货含 `LossClaim`（`APPROVED/RESOLVED`）且已调应付 | 需反向调回 `PaymentSchedule`/`Reconciliation`，已付款则阻断 |
| 更正日期后已有该商品消耗 | 门店没有收货批次可恢复；需重放门店库存/成本派生，不能触碰供应链仓批次 |
| 重复提交同一 correction | 幂等返回已有 correction |
| 并发同一 Receipt | `receipt-finance` advisory lock 串行 |
| `CHEF` / `SUPPLY_CHAIN` / 供应商尝试发起 | 403；门店发起角色未确认前也默认阻断 |
| 已关账月份 | 默认阻断 |

## 6. 业务阻断清单（默认阻断，待产品/财务确认）

1. **已付款**：`PaymentSchedule` / `Payment` 进入 `PAID`/`PROCESSING`/`PAYING`。
2. **已关账**：`AccountingPeriod.status = CLOSED`（`apps/api/src/services/accountingPeriod.ts:22-29`）。
3. **真实历史修正**：跨月、跨年、已出具报表/发票的原始单据。
4. **负库存**：修正后 `Product.stock` 或门店估算库存 < 0。
5. **已消耗供应链仓批次**：只阻断供应链仓入库更正；门店后续消费则要求重放门店库存与成本派生，不恢复或改写供应链仓批次。

## 7. 幂等与并发

- 供应链仓入库更正使用 tenant+warehouse+原 movement+请求键的业务唯一约束，并在同仓
  同商品上持有行锁；同键同内容返回原结果，同键异内容 409。
- 门店收货更正使用 tenant+receipt+请求键唯一约束，并与 `receipt-finance` 锁保持固定
  顺序；任何一次更正只新增更正事实，不更新原 `Receipt` / `ReceiptItem`。
- 两条状态机的锁、幂等键和 sourceType 均不得复用，防止一条重放触发另一条库存链。

## 8. Schema / 部署约束

- 当前 Schema 无独立 Warehouse / WarehouseStock / WarehouseMovement / WarehouseBatch 表；只有 `Supplier` / `Product` / `SupplierStockMovement` / `SupplierStockBatch`。
- 已有关键唯一约束：`Receipt.deliveryOrderId @unique`、`PaymentSchedule.receiptId @unique`、`ReconciliationItem.receiptId @unique`、`Voucher @@unique([tenantId, sourceType, sourceId])`。
- 本报告**不修改 schema / API / Web / 旧报告 / main / 统一 RC 或生产**。
- 后续如需改 schema，只允许：
  - `prisma migrate deploy` / `prisma migrate status` / `prisma migrate diff`
  - 手工 rollback SQL（与 migration 同目录 `rollback.sql`）

## 9. 提交检查记录

- 仅新增 `reports/V5_INBOUND_RECEIPT_CORRECTION_SPLIT_2026-07-26.md`。
- 行数：≤ 280（见 `wc -l` 结果）。
- 高置信敏感信息检查：未发现需遮蔽的敏感字符串（密码、令牌、密钥、AK、私钥、银行账号等均未以凭证形式出现）。
- `git diff --check` 无尾随空白或冲突标记。
