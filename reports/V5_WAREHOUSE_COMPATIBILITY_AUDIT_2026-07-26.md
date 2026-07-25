# V5 tenant 默认仓兼容性审计

审计日期：2026-07-26  
基线：`1875db2cbfa2d752465c11d2a658910bf7bd293d`  
范围：真实 `Warehouse` / `WarehouseStock` 落地前的库存写入、读取、切换门禁与测试矩阵。

## 结论

- 当前供应链公司是 tenant 内部团队。`Supplier` 是商品、订单和库存事实的业务 scope，
  不拥有仓库；当前每个 tenant 只启用一个默认仓，模型保留未来多仓接口。
- API 里的 `warehouseId=default` 只是当前稳定别名。真实仓应使用 tenant 内仓库 ID，
  `code=default` 解析到默认仓；不能把字符串 `default` 当成跨 tenant 共用外键。
- 当前物理余额权威写入点是 `Product.stock`（`Decimal(10,2)`）；批次、预占、流水继续按
  `tenantId + supplierId + productId` 归属。引入 `WarehouseStock` 后，所有事实需再带
  同 tenant 的真实 `warehouseId`。
- schema 基础可先用数据库触发器把 `Product.stock` 单向镜像到
  `WarehouseStock.physicalQty`，并为旧 writer 缺省的事实补 tenant 默认仓。运行时改造
  完成前不得反向同步，也不得停止 `Product.stock` 写入。
- 门店收货只增加门店库存，不恢复供应链仓库存；供应链手工入库更正和门店收货更正必须
  分成两条状态机，本审计不为二者授予写权限或执行真实数据修正。

## 当前事实与不变量

| 事实 | 当前含义 | 引入默认仓后的约束 |
| --- | --- | --- |
| `Product.stock` | 供应链物理余额 | 兼容期仍是写入口，并单向镜像到默认仓余额 |
| `SupplierStockMovement` | 增减流水与 `balanceAfter` | 保存真实 `warehouseId`，按 tenant 仓库外键校验 |
| `SupplierStockBatch` | 入库批次及 FEFO 余量 | 保存真实 `warehouseId`，消费只能在同仓发生 |
| `SupplierStockBatchAllocation` | 负流水到批次的分配 | warehouse 必须与 movement、batch 一致 |
| `SupplierStockReservation` | 接单预占/释放/核销 | 保存订单确认时的真实 `warehouseId` |
| `DeliveryOrder` | 实际发货事实 | 保存发货扣仓使用的真实 `warehouseId` |

兼容期逐商品应持续满足：

1. `WarehouseStock.physicalQty == Product.stock`；
2. STRICT 库存模式下，`Σ(batch.remainingQty) == Product.stock`；
3. 活跃预占不大于物理余额；
4. 同一流水的 allocation 数量、批次和仓库守恒；
5. 任一事实显式提交跨 tenant warehouseId 时由数据库拒绝，不能静默改写。

## 写路径逐文件审计

| 路径 | 事务、scope 与锁 | 当前写入 | 按仓运行时改造 |
| --- | --- | --- | --- |
| `POST /api/products`，`routes/products.ts` | 商品、期初流水、期初批次同一事务；tenant 来自认证；新行无并发锁 | 初始 `Product.stock`、`INITIAL` movement、`OPENING` batch | 解析 tenant 默认仓；事实带 `warehouseId`。兼容触发器负责余额镜像，避免再加第二套应用双写 |
| 手工/Excel 入库，`routes/supplierStock.ts` | 整批一个事务；`tenantId + supplierId`；商品 ID 排序后 `FOR UPDATE` | 设置新 `stock`、正 movement、`INBOUND` batch | 所有事实写默认仓；未来切换后锁 WarehouseStock 行并原子增加物理余额 |
| 盘点调整，`routes/supplierStock.ts` | 单商品事务；认证 scope；商品行锁；不得低于活跃预占 | 设置目标 `stock`、差额 movement、正建批次/负向 FEFO | 目标仓必须显式解析；预占、批次、流水和余额都限定同仓 |
| 报损，`routes/supplierStock.ts` | 单商品事务；认证 scope；商品行锁；校验可用量 | 减 `stock`、`LOSS` movement、FEFO 消耗 | 只扣目标仓；批次不足使整个事务回滚 |
| 库存快照导入，`routes/supplierStock.ts` | 每项独立事务；advisory lock 加商品行锁；相同目标跳过 | 设置 `stock`、差额 movement、批次增减 | advisory key 和所有查询增加 warehouse 维度；逐项部分成功语义保持 |
| 接单预占，`services/supplierStockReservation.ts` | 与订单 `SUBMITTED→CONFIRMED` CAS 同一事务；STRICT 才预占；商品行锁 | 不改物理余额；创建 ACTIVE reservation | 冻结默认仓 ID；可用量、其他订单预占与锁均按同仓计算 |
| 取消/拒单，`services/supplierStockReservation.ts` | 与订单状态变更同一事务 | ACTIVE → RELEASED，不改物理余额 | 只释放原 reservation 的仓库，不重新解析当前默认仓 |
| 发货，`services/supplierStockReservation.ts`、`routes/orders.ts` | 与配送单和订单状态同一事务；商品行锁；NOT_TRACKED 不扣仓 | 原子 decrement `stock`、`OUTBOUND_PO` movement、FEFO allocation、预占核销/释放 | 使用确认时冻结的仓；扣余额、批次、流水、allocation、reservation 必须同仓 |
| 审计，`services/supplyChainAudit.ts` | 只读 tenant/supplier scope | 比较 stock、批次、流水、预占 | 兼容期追加 WarehouseStock 对账；读切换后以按仓余额为权威 |

未发现收货路由写供应链 `Product.stock`：配送收货写门店库存与实收事实。因此门店实收
更正不得通过上述发货反向路径增加供应链仓余额。

## 读取路径与切换影响

| 文件/入口 | 当前来源 | 切换要求 |
| --- | --- | --- |
| `routes/supplierStock.ts` 列表/summary | `Product.stock` | 先做新旧余额核对，再按已解析仓读取 WarehouseStock |
| 同文件 batches/movements/reservations | supplier facts | 强制追加同 tenant `warehouseId` 条件 |
| `routes/products.ts` `withAvailability` | stock - active reservations | 物理余额与预占必须取同仓 |
| `routes/dashboard.ts`、`routes/financeReports.ts` | `Product.stock` | 最后切换，避免经营/估值口径提前漂移 |
| `routes/documents.ts` | 当前商品库存快照 | 明确单据用途后按仓读取，不改历史冻结事实 |
| `services/supplyChainAudit.ts` | stock/batch/movement/reservation | 在主读路径切换前先支持双源核对 |

## 安全切换门禁

### G0：schema 候选

- tenant 范围 `Warehouse`，无 `supplierId`；数据库保证每 tenant 至多一个启用默认仓。
- `WarehouseStock` 以 `tenantId + warehouseId + productId` 唯一，含物理余额、行版本、
  启停状态。
- 五类库存/配送事实增加 nullable 兼容字段、同 tenant 复合外键和按仓索引；历史事实绑定
  tenant 默认仓。
- migration 确定性创建历史 tenant 的默认仓，并从所有 `Product.stock` 初始化余额，
  不能只处理有 supplierId 的商品。
- 在隔离临时空库和历史样本库完成 `migrate deploy`、`status`、migrations-to-schema
  `diff`、约束验证与 rollback 演练；禁止 `db push/reset`。

### G1：兼容写

- 新建 tenant 自动得到一个默认仓；旧 writer 省略 warehouseId 时只补 NULL，显式伪造
  值交由复合外键拒绝。
- `Product.stock` INSERT/UPDATE 单向 upsert 默认仓余额；warehouse 不反写 Product。
- 对每个库存事务做故障注入：镜像/事实任一步失败时业务事务整体回滚。
- 兼容桥只用于当前单默认仓阶段；运行时开始支持非默认仓写入前必须先移除该假设。

### G2：事实显式化

- 依次改商品期初、入库、调整、报损、快照、预占、发货；每个 writer 显式选择仓库，
  批次 helper 与 reservation helper 必须接收 warehouseId，不能在深层重新猜默认仓。
- 发货使用订单确认时冻结的仓库；部分发货关闭余量只释放同仓预占。
- 每批通过 tenant/supplier 隔离、未知仓拒绝、并发和事务回滚后才进入下一 writer。

### G3：连续核对

- 对每 tenant/warehouse/product 比较 Product、WarehouseStock、批次、流水末余额和预占。
- 差异只记录可追踪告警并阻断切换，不自动修正真实数据。
- 连续核对窗口和告警阈值需由发布负责人确定；本报告不虚构天数或生产规模。

### G4：读切换

- 先切内部审计，再切批次/流水/预占，随后库存列表与 summary，最后切商品可用量、看板和
  财务估值。
- 每一读入口只有在同一隔离数据集的新旧结果一致后才能切换；回退只回代码读源，不执行
  数据删除或一次性修正脚本。

### G5：停止旧写

- 所有 writer 已显式按仓、数据库合同和浏览器 E2E 通过、连续核对无差异后，才把
  WarehouseStock 设为物理余额权威。
- 先停止应用写 `Product.stock`，再移除单向桥；列删除属于后续独立 migration，不与
  运行时切换同批。

## 测试矩阵

| 类别 | 必测场景 |
| --- | --- |
| 迁移 | 空库；历史 tenant/product；无 supplier 商品；有/无批次与流水；重复 deploy；status/diff；rollback |
| 默认仓 | 新 tenant 自动创建；同 tenant 第二默认仓失败；supplier 变化不创建仓；禁用默认仓约束 |
| 跨界 | 跨 tenant warehouseId；同 tenant 不同 supplier；未知/空/非字符串 alias；ID 与 code 解析 |
| 余额桥 | Product 新建、增、减、值不变、事务回滚；单向同步；行版本递增；重复执行不重复余额行 |
| 并发 | 双入库；入库/发货；调整/入库；快照/入库；逆序批量；双发货；锁超时/序列化重试 |
| 预占 | 确认预占；取消/拒绝释放；部分发货核销已发并释放余量；其他订单预占隔离；重复请求幂等 |
| 批次 | 正向建批；FEFO；allocation 与 movement 同仓；批次不足全回滚；批次和物理余额守恒 |
| NOT_TRACKED | 不创建预占/批次扣减；既有 Product 与 WarehouseStock 镜像语义一致且有明确审计标记 |
| 读切换 | 列表、summary、可用量、看板、财务与单据在同一测试数据集新旧结果一致 |
| 更正边界 | 供应链入库更正只改仓侧事实；门店收货更正只改门店库存/差异/应付，不恢复仓存 |

## 当前阻断

- 本机没有可用的隔离 `_test/_ci` PostgreSQL，Docker 守护进程不可用；因此真实 migration、
  外键、触发器、并发与 rollback 证据均未形成。
- 在上述数据库门禁完成前，仓库 schema 只能保留为 feature 候选，不得进入统一 RC。
- 不连接普通本地库或生产库补证据，不运行真实数据回填/修正脚本。
