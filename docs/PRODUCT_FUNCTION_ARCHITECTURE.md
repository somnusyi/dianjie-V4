# 滇界云管 V4 · 产品功能架构

> 整理依据：`README.md`、`TEAM_HANDOFF_2026-07-17.md`、`docs/releases/1.3.1~1.3.3.md`、
> `packages/db/prisma/schema.prisma`、`apps/api/src/routes/*`、`apps/web/src/app/v2/*`、
> 各角色 shell 导航配置与 `apps/api/src/lib/auth-scope.ts`。
> 本文是**代码与版本记录反推的功能架构**，不扩写未上线的需求。

## 1. 一句话定位

滇界 V4 是南京云洱之境餐饮集团自用的**多角色连锁餐饮经营管理系统**。
核心不是单一“进销存”，而是把「订货 → 配送 → 收货 → 库存 → 营业/BOM → 对账/付款/发票/资金/凭证」串成**可审计的业务闭环**，并为老板、财务、店长、厨师长、总厨、供应商、内部供应链、工程部提供各自工作台。

当前版本 **1.3.3**（2026-10-28）；正式 `https://dianjie.cc/v2/login`，测试 `https://www.dianjie.cc:8085/v2/login`，两环境库/会话/签名隔离。

---

## 2. 产品功能架构图（总览）

```mermaid
flowchart TD
    ROOT["滇界云管 · 连锁餐饮数字化管理平台"]

    subgraph PLAT["① 平台底座与入口"]
        direction LR
        P1["多端接入<br/>Web / PWA · Capacitor 移动容器 · PC 工作台 · 企微桥接"]
        P2["账号与权限<br/>登录与安全会话 · 账号申请审批 · 邀请激活 · 改密 · 角色数据隔离（租户/门店/供应商）· 多店范围"]
        P3["协同与运维<br/>通知中心 · 全员反馈 · 操作日志 · 自动修复 · 备份与版本管理"]
    end

    subgraph CORE["② 核心业务域（可审计闭环）"]
        direction LR
        D1["订货履约<br/>订货单 · 补货单（预占）· 配送单 · 收货入库 · 到货差异 · 报损 · 门店调拨 · 送货单打印"]
        D2["库存管理<br/>门店预计库存 · 供应商库存 · 总仓库存（批次/库位/台账/预占）· 出入库单据 · 盘点盈亏 · 上下限 · 批次多图质检"]
        D3["菜品与营业<br/>每日双表导入（预览→确认）· 菜品销量 · 菜品档案/BOM/配方 · BOM待办与历史回补 · 食材消耗 · 经营报表"]
        D4["上游供应链<br/>供应商合同 · 采购订单 · 发货与到货验收 · 到货索赔/退货 · 月结对账 · 毛利分析"]
        D5["财务会计<br/>应付与付款申请 · 对账 · 发票与待开票 · 资金与招行CMB · 凭证/模板/月结 · 资本支出 · 备用金/工资 · 成本核对 · 建店预算 · 财务报表"]
        D6["门店运营<br/>门店档案/生命周期/开店任务 · 日报经营 · 客户/团队/排班 · 费用与资本申请"]
        D7["工程开店<br/>开店任务看板（选址/装修/物料/证照）· 工程任务 · 门店工程详情"]
        D8["老板与集团<br/>集团指标 · 门店概览 · 多店大屏 · 审批 · 预算与利润中心 · 人员 · AI助手/自动修复"]
    end

    subgraph ROLES["③ 多角色工作台"]
        direction LR
        R1["老板 BOSS / BOSS-PC"]
        R2["财务 FINANCE / 财务PC"]
        R3["店长 MANAGER"]
        R4["厨师长 KITCHEN_LEAD"]
        R5["总厨 CHEF_DIRECTOR"]
        R6["供应商 SUPPLIER_OWNER/STAFF"]
        R7["内部供应链 SUPPLY_CHAIN"]
        R8["工程部 ENGINEERING"]
    end

    subgraph EXT["④ 外部系统集成"]
        direction LR
        E1["美团 POS<br/>营业/销量（生产未启用）"]
        E2["招行 CMB 国密微服务<br/>付款/流水（自动付款关闭）"]
        E3["企业微信<br/>SSO/通知（待端到端）"]
        E4["阿里云 OSS<br/>文件与图片"]
        E5["B2B 平台<br/>美菜/快驴 账单导入"]
    end

    ROOT --> PLAT
    ROOT --> CORE
    ROOT --> ROLES
    ROOT --> EXT
    ROLES -.->|按角色使用| CORE
    CORE -.->|数据/单据| EXT
```

---

## 3. 核心业务闭环图

```mermaid
flowchart LR
    A["厨师长/店长<br/>订货 · 补货预占"] --> B["供应商/总仓<br/>接单 · 改实发 · 发货"]
    B --> C["门店<br/>收货 · 差异 · 报损 · 调拨"]
    C --> D["库存<br/>预计库存滚动 · 盘点 · 批次质检"]
    D --> E["每日营业<br/>双表导入 → 确认"]
    E --> F["菜品 BOM<br/>食材消耗 · 缺配方回补"]
    F --> G["财务闭环<br/>对账 · 发票 · 付款 · 资金 · 凭证"]
    G --> H["报表<br/>利润/现金流/食材成本/账龄/报税"]
```

---

## 4. 功能域清单

### 4.1 订货履约域
| 功能 | 说明 | 主要入口 |
|---|---|---|
| 门店订货单 | 原始订购量不可无痕覆盖；修订需门店确认；编号、并发、幂等 | `/v2/manager/purchase`、`/v2/chef/purchase`、`/v2/chef-director/orders` |
| 独立补货单 | 提交后预占库存，撤回/取消释放，接单不重复占用 | `/v2/manager/replenishment-orders`、`/v2/supply-chain/replenishment-orders` |
| 配送单 | 一订单多配送；发货前调整实发量；`SHIPPED→DELIVERED→RECEIVED` | `/v2/supply-chain/deliveries`、`/v2/supply-chain/fulfillment` |
| 收货/入库 | 原子收货、短量报损、分批收货保留尾差 | `/v2/manager/purchase/[id]/receive`、`/v2/supply-chain/receipts` |
| 到货差异与报损 | 短缺/破损责任确认；报损争议仲裁 | `/v2/supply-chain/differences`、`/v2/chef-director/loss`、`/v2/loss-claims` |
| 门店调拨 | 按实发、实收、完好退回、损坏登记数量与成本 | `/v2/supply-chain/transfers` |
| 送货单打印 | 竖版表格、库位/分类排序、合并单号自动换行 | `delivery-note-paper.tsx`、`*/delivery-note` |

### 4.2 库存域
| 功能 | 说明 |
|---|---|
| 门店预计库存 | 最近盘点 + 确认收货 − BOM/人工/日报消耗 − 店内报损（页面统一带“预计”字样） |
| 供应商库存 | 独立流水账，与门店库存分账，不互相改写 |
| 总仓/仓库库存 | 批次、库位、台账流水、预占与分配 |
| 出入库单据 | 入库/出库/自损统一管理，审核后生效 |
| 盘点管理 | 多人盘点、盈亏单、总仓盘点 |
| 库存上下限 | 库存策略与修订记录、补货规则 |
| 库存报表 | 库存查询、管理与验收报表 |
| 批次质检 | 按商品进货批次维护多张图片、未保存关闭保护 |

### 4.3 菜品与营业域
| 功能 | 说明 |
|---|---|
| 每日双表导入 | 综合营业统计 + 菜品销售明细，先预览后确认，单事务原子写入 |
| 菜品销量 | `DishSale`，按日/菜品统计 |
| 菜品档案与 BOM | 规格配方、版本、损耗、排除策略（如“百家蘸料”不扣库存） |
| BOM 待办与回补 | 缺菜品/BOM 转 `DeferredBomTask`，总厨补档后幂等回补历史消耗 |
| 食材消耗 | `StockConsumption`，按 BOM 毛重口径计算 |
| 经营报表 | 营业额/收入/订单/优惠及时间对比 |

### 4.4 上游供应链域
供应商合同与合同行 → 采购订单（含修订/事件）→ 发货/到货验收（多图质检）→ 到货索赔/退货 → 月结对账单与发票分摊；配套上游供应商档案、资质证据、商品来源。

### 4.5 财务会计域
| 分组 | 功能 |
|---|---|
| 应付 | 应付管理、上游采购对账、付款申请、付款规则 |
| 发票 | 发票审核、待开票跟踪 |
| 资金 | 资金台账、现金/银行流水、招行 CMB 余款 |
| 成本 | 月度成本核对（门店→厨师长→供应商→财务四方）、B2B 平台导入、备用金、工资、建店成本台账 |
| 凭证 | 凭证管理、周期凭证模板、月结锁账 |
| 资本 | 资本支出申请/审批、合同 |
| 报表 | 月度对账、利润中心、现金流、食材成本、应付账龄、对账自检、报税报表 |

### 4.6 门店运营 / 工程 / 老板集团域
- **门店运营**：门店档案与生命周期、开店任务、日报上传、客户/团队/排班、费用与资本申请。
- **工程部**：开店看板（选址/装修/物料/证照）、工程任务、门店工程详情。
- **老板集团**：集团关键指标、门店概览、多店大屏（boss-pc）、审批、预算与利润、人员、AI 助手与自动修复。

---

## 5. 角色工作台矩阵

| 角色 | 工作区入口 | 主要功能 |
|---|---|---|
| 老板/管理员 `ADMIN/BOSS` | `/v2/boss`、`/v2/boss-pc` | 集团指标、门店概览、报表、审批、门店配置、人员、利润/预算、AI助手与自动修复 |
| 财务 `FINANCE` | `/v2/finance`、`/v2/finance-pc` | 初审、付款申请、应付、成本核对、凭证、资金、发票、月结、资本支出、财务报表 |
| 店长 `MANAGER` | `/v2/manager` | 待验收、日报上传、经营/客户/团队、库存、费用、资本、补货单 |
| 厨师长 `KITCHEN_LEAD` | `/v2/chef` | 预计库存、订货采购、验收、盘点、报损/检查 |
| 总厨 `CHEF_DIRECTOR` | `/v2/chef-director` | 审批、菜品/BOM/配方、报损争议仲裁、代店下单、各店报损排行 |
| 供应商 `SUPPLIER_OWNER/STAFF` | `/v2/supplier` | 商品与报价、门店订单履约/总仓采购、到货差异、履约库存、账单与发票、经营分析、操作记录 |
| 内部供应链 `SUPPLY_CHAIN` | `/v2/supply-chain` | 工作台、配送履约、到货差异、门店运营、配送班表、库存/盘点/商品、上游采购、调拨、上游供应商、财务与经营分析 |
| 工程部 `ENGINEERING` | `/v2/engineer` | 开店看板、工程任务、门店工程详情 |

> 数据隔离：门店级角色（MANAGER/KITCHEN_LEAD/SUPERVISOR/REGIONAL_MANAGER 等）按 `storeIds` 过滤；
> 供应商角色按 `supplierId` 过滤；内部供应链跨店只读；老板/财务为租户级。

---

## 6. 技术架构（支撑层）

```mermaid
flowchart LR
    U["多角色 Web / PWA / Capacitor"] --> N["Nginx"]
    N --> W["Next.js 14 : Web"]
    N --> A["Fastify + TypeScript : API"]
    A --> P["Prisma ORM"]
    P --> D["PostgreSQL（阿里云 RDS / 本地隔离库）"]
    A --> C["招行国密 Python 微服务"]
    A -.配置后启用.-> M["美团开放平台"]
    A -.配置后启用.-> Q["企业微信"]
    A -.文件能力.-> O["阿里云 OSS"]
```

Monorepo：`apps/web`（前端）、`apps/api`（业务 API）、`apps/cmb`（招行国密）、`packages/db`（Prisma）、`scripts`（测试/部署/回滚）。

---

## 7. 边界与未启用项（读代码时需注意）

- **税率口径**：合同税率与含税计算已在 1.3.1/1.3.2 存在，必须保留，不得删除或改口径；不得自行给测试合同指定税率。
- 美团：代码与测试存在，生产未启用，真实数据仍是每日双表上传。
- 招行 CMB：服务在线，但自动付款/同步开关关闭，不得开启。
- 企业微信：配置与代码存在，HTTPS/SSO 端到端未完成验收。
- 月度全量盘点、收货更正/冲销、补送与报损最终口径、负库存策略等仍属业务待确认项。
- 多店/20 店扩展为 P1/P2 目标，当前仅合肥瑶海店为真实试点；严格多租户隔离仍保留。

---

# 核心业务模块拆解与主流程

> 以下状态名、字段名、规则均来自当前代码（HEAD `d75290c`），非文档概述。
> 每条流程按「谁触发 → 经过什么状态 → 产生什么副作用 → 关键规则」组织。

## 流程 A：每日营业导入 → BOM → 预计库存

涉及角色：**店长/厨师长（上传与确认）**、**总厨（补档与回补）**。
入口：`POST /api/daily-business-imports/preview`、`/:id/confirm`、`/bom-tasks/*`、`/bom-recalculation`。

### A1 日报从上传到确认

```mermaid
flowchart TD
    S1["店长上传两份 XLSX<br/>businessFile 综合营业统计 + salesFile 菜品销售明细<br/>仅 .xlsx，单文件≤5MB"]
    S2["解析校验 parseDailyFiles<br/>门店精确匹配(别名/后缀归一) · 单店单日 · 金额勾稽(容差¥0.05)<br/>退菜只识别不补库存(RETURNS_NOT_RESTOCKED)"]
    S3["生成预览 buildPreview<br/>菜名+别名匹配(仅 ACTIVE 菜品) → 选 PUBLISHED BOM<br/>(POS规格精确优先，默认 BOM 兜底，按版本/生效日倒序)<br/>消耗量 = 销量 × BOM用量 ×(1+损耗率) 毛重口径<br/>单位换算(PENDING 暂缓整道菜) · EXCLUDE 不扣"]
    S4["写入 DailyBusinessImport<br/>status=PREVIEWED · revision+1 · calculationFingerprint<br/>advisory lock + 唯一键去重；同哈希旧版→SUPERSEDED"]
    S5{"POST /:id/confirm<br/>deferBomIssues 可暂缓三类问题?"}
    S6["409 PREVIEW_REFRESHED<br/>预览后 BOM/规则已变，刷新后重新核对"]
    S7["双扣闸门 assertNoManualDishSales<br/>同日有手工 DishSale → 409 要求先删除"]
    S8["Serializable 单事务原子写入"]
    S9["旧 CONFIRMED 版清理<br/>删旧消耗 · 待办 SUPERSEDED · 旧版 SUPERSEDED"]
    S10["RevenueRecord 净收入 upsert<br/>DishSale(source=daily_pos_upload)<br/>StockConsumption(source=daily_pos, quantity=毛重, inventoryQuantity=换算值)<br/>DeferredBomTask(PENDING)"]
    S11["写回 CONFIRMED + warning BOM_DEFERRED"]
    S12["事务外：成本快照重算 + BOM_TASK_PENDING 通知<br/>跳转 /v2/chef-director/bom"]

    S1 --> S2 --> S3 --> S4 --> S5
    S5 -->|指纹已变| S6 --> S4
    S5 -->|允许| S7
    S7 --> S8 --> S9 --> S10 --> S11 --> S12
```

**状态机**：`PREVIEWED → CONFIRMING → CONFIRMED`；更正触发 `CONFIRMED → SUPERSEDED`。
- `PREVIEWED→CONFIRMING` 用 `updateMany(status:PREVIEWED)` 做乐观锁，count≠1 即 409。
- `CONFIRMING` 是事务内瞬时态；整段确认在 `Serializable` 单事务内，失败整体回滚。
- 可暂缓三类：`DISH_UNMATCHED` / `BOM_MISSING` / `INVENTORY_UNIT_PENDING`。
- 时间闸门：北京时间计算，只能导入**已结束营业日**（默认前一天，11:00 截止）。
- 幂等：`GET /:id/confirm` 已 CONFIRMED 直接返回；唯一键 `(storeId,businessDate,业务哈希,销量哈希,fingerprint)` 去重。

**关键业务规则**
- **退菜不补回库存**：退菜只进 `RevenueRecord.rawData.posReturns` 并产生警告，不生成反向消耗。
- **BOM 毛重口径**：`数量 × BOM用量 × (1+损耗率)`，`quantity` 存毛重，`inventoryQuantity` 才是库存/成本准绳。
- **EXCLUDE 策略**：`百家蘸料/纸巾` 等 `Dish.inventoryPolicy=EXCLUDE` 跳过扣减；**赠品是正常销售行按 BOM 扣减**（两条规则不同）。
- **双扣闸门**：同日若存在手工销量则拒绝确认，不静默删除。

### A2 缺菜品/BOM 的回补闭环

```mermaid
flowchart LR
    T1["日报确认产生 DeferredBomTask<br/>reasonCode: DISH_UNMATCHED / BOM_MISSING / INVENTORY_UNIT_PENDING<br/>status=PENDING"]
    T2["总厨工作台 /v2/chef-director/bom<br/>关联菜品写 DishAlias(source=daily_pos)"]
    T3["补配方 /v2/chef-director/dishes<br/>DishBomVersion: DRAFT → PUBLISHED<br/>(HISTORICAL_CORRECTION 类型需显式确认)"]
    T4["POST /bom-tasks/:id/backfill<br/>PENDING → BACKFILLED(updateMany 乐观锁)"]
    T5["写 StockConsumption(source=daily_bom_backfill,<br/>sourceId=task.id, sourceLineKey=bomVersion.id)<br/>未记销量则补 DishSale"]
    T6["整日重算 /bom-recalculation<br/>按原日报快照重建全部消耗与销量<br/>(HISTORICAL_CORRECTION 专用)"]

    T1 --> T2 --> T3 --> T4 --> T5
    T3 -.大范围配方变更.-> T6
```

- 幂等三重保护：状态机 `PENDING→BACKFILLED`（count≠1 抛 409）+ 唯一键 `(sourceType,sourceId,sourceLineKey,productId)` + `BACKFILLED` 直接返回。
- `saleRecorded=false`（菜品未匹配）时回补同时补记 `DishSale`；`true` 时只补消耗。
- 单位换算仍为 PENDING 时禁止回补（fail-closed）。
- ⚠️ 易混淆：`consumptionCorrection.ts` 是**单条错误扣减的冲销审计**（保留原行、插入 `correction` 补记），不是日报回补机制。

### A3 门店预计库存滚动

```mermaid
flowchart TD
    B1["InventorySnapshot 可信实物基准<br/>最近一次盘点的 normalizedQuantity<br/>openingDate = 盘点日+1"]
    B2["+ 已确认收货<br/>Receipt CONFIRMED/ACCOUNTED<br/>deliveryDate≥期初，取 inventoryQuantity"]
    B3["+ 门店调拨<br/>storeTransferMovement.quantityDelta"]
    B4["− 库存消耗 StockConsumption<br/>voidedAt=null，取 inventoryQuantity??quantity<br/>含 daily_pos / daily_bom_backfill / manual / correction"]
    B5["− 店内报损<br/>人工报损 APPROVED/AUTO_APPROVED/RESOLVED<br/>+ 收货后待索赔 GROSS_PENDING_CLAIM"]
    B6["estimatedStoreInventory()<br/>basis=ESTIMATED_FROM_PHYSICAL_COUNT<br/>isRealtime=true → 页面显示“预计库存”"]
    B7["下次盘点 → 重建 InventorySnapshot 基准"]

    B1 --> B2 --> B3 --> B4 --> B5 --> B6 --> B7
```

- **同日顺序**：先入库、后按闭店销量扣理论消耗；IN 先于 OUT。
- **供应商库存独立分账**：不用 `Product.minStock`（那是供应商口径），门店用 `StoreInventoryPolicy.minStock/targetStock`；供应商 `Product.stock` 绝不被门店消耗改写。
- `inventoryQuantity` 为空/单位待核验的收货行**排除滚动**并计入 `normalizationPendingCount`（防箱/件当 g/kg）。
- 盘点单 `InventoryCountStatus = DRAFT→COUNTING→REVIEWING→CONFIRMED`，确认后衍生 `InventorySnapshot`；冲销只能对最新基准执行。盘点差异只属门店内部，不产生供应商报损/应付。

---

## 流程 B：上游采购全链路（总仓向外部供应商采购）

入口域：`/v2/supply-chain/procurement`、`/v2/supply-chain/suppliers`，API `routes/upstreamProcurement.ts`。
状态转移由 `domain/upstreamProcurement.ts` 的 `assert*` 转移表强制，非法跳转直接报错。

```mermaid
flowchart TD
    U1["① 供应商合同 UpstreamContractStatus<br/>DRAFT → ACTIVE / EXPIRED / TERMINATED<br/>固化单价·税率·账期·起订量·包装倍数·采购/库存单位换算"]
    U2["② 采购订单 UpstreamPurchaseOrderStatus<br/>DRAFT → PENDING_APPROVAL → SUBMITTED_TO_SUPPLIER<br/>→ SUPPLIER_ACCEPTED / CHANGE_PROPOSED<br/>→ PARTIALLY_SHIPPED / SHIPPED<br/>→ PARTIALLY_RECEIVED → RECEIVED → SETTLEMENT_PENDING → CLOSED"]
    U3["改单 CHANGE_PROPOSED<br/>UpstreamPurchaseOrderRevision<br/>PENDING / ACCEPTED / REJECTED / SUPERSEDED<br/>⚠ 任一行 shippedQty>0 或 receivedQty>0 禁止改单<br/>只改本单，不改合同价与历史收货"]
    U4["③ 发货 UpstreamShipmentStatus<br/>DRAFT → SHIPPED → PARTIALLY_RECEIVED / RECEIVED<br/>累计发货量 ≤ 订单确认量"]
    U5["④ 到货验收 UpstreamReceiptStatus<br/>DRAFT → INSPECTING → PENDING_REVIEW → POSTED → REVERSED<br/>逐行记到货/合格/破损/拒收/短缺/超量 + 质检结果<br/>FAIL 必须: 合格数0 + 拒收数 + 证据 + 处置"]
    U6["过账副作用（单一原子事务）<br/>总仓台账流水 UPSTREAM_RECEIPT + 移动均价<br/>累加 receivedQty · 自动生成到货差异单<br/>推进发货单/采购单状态 → POSTED"]
    U7["⑤ 到货索赔/退货<br/>ArrivalClaim: PENDING_SUPPLIER → SUPPLIER_ACCEPTED → RESOLVED<br/>(拒绝→ARBITRATION; 超时→AUTO_ACCEPTED)<br/>退货: DRAFT→PENDING_APPROVAL→APPROVED→RECEIVED"]
    U8["⑥ 月结 UpstreamSettlementStatus<br/>DRAFT → SENT_TO_SUPPLIER → CONFIRMED → LOCKED(财务)<br/>→ INVOICED → PAID；DISPUTED 可往返<br/>订单 RECEIVED → SETTLEMENT_PENDING → CLOSED"]

    U1 --> U2 --> U4 --> U5 --> U6 --> U7 --> U8
    U2 -.需改价/改量.-> U3 -.批准/拒绝.-> U2
```

### B1 到货验收的审核与复审闸门

```mermaid
flowchart TD
    V1["confirm 验收提交"] --> V2{"实际单价 > 标准价?"}
    V2 -->|是| V3["409 禁止验收入库"]
    V2 -->|否| V4{"命中复审原因?<br/>AMOUNT_THRESHOLD 金额阈值<br/>OVER_RECEIPT 超量<br/>TEMPORARY_PRICE 临时价<br/>ABOVE_STANDARD_PRICE<br/>SENSITIVE_CATEGORY 敏感品类"}
    V4 -->|命中| V5["PENDING_REVIEW"]
    V5 --> V6["review-and-post 复审<br/>⚠ 复核人必须与验收人不同<br/>通过后 → POSTED 真正过账"]
    V4 -->|未命中| V7["直接 POSTED 过账"]
```

- **改单硬边界**：只要任一行 `shippedQty>0 || receivedQty>0` 就拒绝 409；价格改动标记 `hasTemporaryPrice`。
- **双人复核**：`assertDifferentReceiptReviewer` 防止同一人验收又复审。
- **多图质检**：每行 `qualityEvidence` ≤20 项（jpeg/png/webp/gif/pdf，单张≤10MB），整组质检图 ≤50 张；新模式下按“商品本次进货批次”维护。
- **税率/含税计算**（必须保留）：含税 `lineWithoutTax = 金额/(1+税率)`、`lineTax = 金额 − 不含税额`；不含税 `lineTax = 不含税额×税率`、`lineTotal = 不含税额+税额`；发票要求 `不含税 + 税额 == 价税合计`（±0.01）。

---

## 流程 C：财务闭环（应付 → 对账 → 发票 → 付款 → 凭证）

⚠️ 两个同名“收货”要分清：**① `UpstreamReceipt`（总仓上游采购，流程 B）**；**② `Receipt`（门店/供应商履约收货）**。账期、对账、发票、付款挂在 **②** 上；总仓来源（`sourceType='HEADQ_WAREHOUSE'`）**不生成外部应付**。

```mermaid
flowchart TD
    F1["门店/供应商收货确认 Receipt<br/>CONFIRMED → ACCOUNTED<br/>(HEADQ_WAREHOUSE 总仓来源不建应付)"]
    F2["生成衍生 receiptDerivatives<br/>借 1405 库存商品 / 贷 2202 应付账款<br/>+ PaymentSchedule 账期"]
    F3["ScheduleStatus<br/>PENDING → PENDING_APPROVAL(金额>2000) → APPROVED<br/>→ PROCESSING → PAID / OVERDUE<br/>未结 NET_AT_RECEIPT 差异 → ON_HOLD"]
    F4["Reconciliation 对账<br/>DRAFT → APPROVED → PAYMENT_GENERATED → DONE<br/>(自动建单直接 APPROVED)"]
    F5["Invoice 发票<br/>PENDING(供应商上传) → VERIFIED(财务通过，可付)<br/>/ REJECTED(驳回重传)"]
    F6["InvoicePayment 发票付款<br/>PENDING → SUCCESS / FAILED / CANCELED<br/>仅 VERIFIED 发票 · 累计≤发票金额 · requestId 幂等"]
    F7["CashTransaction 资金流水<br/>锁资金账户行 · 更新 balance · 记 balanceAfter<br/>账期自动付/资本支出/发票付款/内部转账 四 sink 共用"]
    F8["Voucher 凭证<br/>DRAFT → POSTED → VOIDED<br/>事务外补建，失败留 voucherWarning"]
    F9["AccountingPeriod 月结<br/>OPEN → CLOSED → REOPENED(必填原因)<br/>CLOSED 阻断凭证编辑/审核/作废"]

    F1 --> F2 --> F3 --> F4 --> F5 --> F6 --> F7 --> F8 --> F9
```

**关键规则**
- **防重付互斥**（`paymentMutex.ts`）：账期路径与发票付款路径二选一——发票已有 `PENDING/SUCCESS` 付款时取消账期（CANCELLED）；发票付款创建时若账期 `PAID/PROCESSING` 则 409，否则批量取消。
- **账期到期规则**（`CreditType`）：`FIXED_DAYS` 到货+N 天、`MONTHLY` 月末+1 月、`WEEKLY` 周结、`ON_DELIVERY` 到货即付。
- **招行 CMB 自动付款默认关闭**（fail-closed）：不满足 `NODE_ENV=production && PREVIEW_MODE!=true && CMB_AUTOPAY_ENABLED=true` 就拒绝调用银行；`test` 租户直接取消，仅保留余额查询等只读能力。
- **月度成本核对（四方）**：`store(createdAt) → chef(confirmedAt) → supplier(supplierVerifiedAt) → finance(financeVerifiedAt)`，四方齐备才入账。
- 其他模块状态：备用金 `REQUESTED→APPROVED→PAID→RECONCILING→CLOSED`；工资 `DRAFT→APPROVED→PAID`；资本支出 `PENDING_APPROVAL→APPROVED→PAID`；付款申请 `PENDING/AUTO_APPROVED/APPROVED/REJECTED/CANCELED`。

---

## 流程 D：库存域（单据复审生效 · 盘点 · 调拨 · 净成本）

```mermaid
flowchart TD
    I1["出入库单据 WarehouseDoc<br/>POSTED(制单未审) → CONFIRMED(已审·会计锁定)<br/>→ REVIEWED(复审时才真正过账)<br/>反审核 CONFIRMED→POSTED(需原因)；已 REVIEWED 不可取消"]
    I2["总仓盘点 WarehouseStocktake<br/>DRAFT → COUNTING → REVIEWING → CONFIRMED → REVIEWED(复审生效)<br/>多人分区录入：仅本人录入自己分区，差异必填原因<br/>复审时按 PROFIT/LOSS 一次性过账"]
    I3["门店盘点 InventoryCount<br/>DRAFT → COUNTING → REVIEWING → CONFIRMED<br/>确认后生成 InventorySnapshot 可信基准<br/>差异只属门店内部，不产生供应商报损/应付"]
    I4["调拨 StoreTransfer<br/>PENDING → SHIPPED → PARTIALLY_RECEIVED → RECEIVED<br/>四动作：SHIP 实发 / RECEIVE 实收 / RETURN 完好退回 / DAMAGE 损坏<br/>剩余量 = 数量 − 实收 − 完好退回 − 损坏"]
    I5["库存净成本 inventoryNetCost<br/>按不可变台账顺序投影；净额来自来源单冻结值(不含税)<br/>NET_DOCUMENT / ALREADY_NET / POOL_DOCUMENT<br/>核定 append-only 带版本与指纹；TAX_RATE 核定已停用"]

    I1 --> I5
    I2 --> I5
    I3 --> I5
    I4 --> I5
```

- **复审才生效**：新单据 `postingPolicy='REVIEW'`——制单和审核都不动库存，只有**复审**步骤才调用台账过账并回填 `movementId/postedAt`。
- **库存模式**：`WarehouseInventoryMode = OFF / SHADOW / STRICT`（影子模式补记、严格模式库存不足报错）。
- **调拨成本**：以可信 `InventorySnapshot` 为基准重放流水；SHIP 按调出门店移动均价定价，库存/金额不足则拒绝；`DAMAGE` 的 `quantityDelta/valueDelta` 均为 0，只累加 `damagedQuantity`。
- **净成本边界**：`TAX_RATE` 材料核定方式已停用（改用直接填写成本金额），与“合同税率/发票税额必须保留”是**不同口径**，不要混淆。

---

## 流程 E：订货 → 补货 → 配送 → 收货 → 报损（门店履约主链）

主要角色：**厨师长/店长（下单、收货）**、**供应商（接单、发货、送达）**、**总厨（代下单、仲裁）**、**内部供应链（直接改单、配送调整）**。

### E1 订货单主状态机

```mermaid
flowchart TD
    O1["DRAFT 草稿 → SUBMITTED 已提交<br/>店长/厨师长/总厨代下单创建<br/>写入不可变 submittedSnapshot + SHA256 快照哈希"]
    O2{"供应商接单前<br/>有 PENDING 改单?"}
    O3["409 阻塞：先处理改单"]
    O4["CONFIRMED 已接单<br/>STRICT 供应商预占库存 ORDER_RESERVED"]
    O5["DELIVERING 配送中<br/>ship: 调整实发量(上限110%或+5)<br/>关闭未发余量 CLOSE_UNSHIPPED_REMAINDER"]
    O6["PENDING_CONFIRM 已到货待验收<br/>deliver 或 24h 自动送达(autoDelivered)<br/>⚠ 自动送达 ≠ 自动收货"]
    O7["RECEIVED 已收货<br/>门店原子收货 PATCH /receive<br/>生成 CONFIRMED Receipt + 报损 + 凭证/账期/对账<br/>Receipt → ACCOUNTED"]
    O8["COMPLETED 完成<br/>关联报损全部结案"]
    O9["CANCELLED 取消<br/>发货前可撤回 / 供应商拒单<br/>释放预占 ORDER_RELEASED"]

    O1 --> O2
    O2 -->|是| O3 --> O2
    O2 -->|否| O4 --> O5 --> O6 --> O7 --> O8
    O1 -.发货前撤回.-> O9
    O4 -.拒单/撤回.-> O9
```

- **单点履约**：首次有效发货即关闭履约余量；存在任一 `SHIPPED/DELIVERED/RECEIVED` 配送单时拒绝再建第二张。未发余量按 `CLOSE_UNSHIPPED_REMAINDER` 关闭并通知，**不补送**。
- **不可变原始单据**：`submittedSnapshot/hash`、`originalQuantity/Price/Amount`、`lineOrigin`、`isActive=false` 软停用 + 事件表 + `opLog`；改单**不覆写**原始行。
- **三层幂等**：请求键（内存+DB 唯一）→ 事件表不可变记录 → `rowVersion` CAS + `Serializable` 事务。
- **预占三段式**：提交 `ORDER_RESERVED` → 接单转交 `TRANSFERRED` → 发货核销 `ORDER_OUTBOUND` / 取消 `ORDER_RELEASED`。STRICT 库存不足整事务回滚，SHADOW 异步补记。
- **暂无自动收货**：24h 只自动送达（`autoDelivered:true` 解锁状态），收货事实永远来自门店人工 `PATCH /receive`；自动送达单的 `deliveryDate` 回退到 `expectedDate`。

### E2 改单（Revision）双通道

```mermaid
flowchart LR
    R1["申请改单 → Revision(PENDING)<br/>before/after 快照 + changeSet + type<br/>供应商只能改商品/数量，不可改日期/备注"]
    R2["门店批准 / 驳回<br/>PATCH /revisions/:id/approve|reject<br/>批准才落明细，revision→APPROVED，通知供应商接单"]
    R3["内部供应链直接改单<br/>requestKey + Serializable<br/>revision 直接 APPROVED<br/>写 REVISION_REQUESTED + REVISION_APPROVED 双事件"]
    R4["生效：旧行 isActive=false 留审计<br/>新建 lineOrigin=APPROVED_REVISION 行<br/>原始 submittedSnapshot 不变"]

    R1 --> R2 --> R4
    R1 -.内部供应链.-> R3 --> R4
```

- 接单前必须先处理完所有 `PENDING` 改单；一单只允许一个 `PENDING` 改单。
- 旧入口 `/add-items` 已封口（409）：接单后不能直接改原始订货单。

### E3 独立补货单与预占转交

```mermaid
flowchart TD
    N1["补货单 DRAFT（仅内部供应链）<br/>冻结单价 / 四单位"]
    N2["SUBMITTED 提交 → 预占库存<br/>reserveReplenishmentStock<br/>ReplenishmentStockHold + ORDER_RESERVED<br/>物理量 − 已占量 ≥ 库存量"]
    N3["ACCEPTED 接单<br/>acceptReplenishmentInTransaction<br/>同事务生成正式 PurchaseOrder(状态直接 CONFIRMED)<br/>+ FulfillmentLink + 事件"]
    N4["转交预占所有权<br/>HOLD: ACTIVE→TRANSFERRED<br/>→ WarehouseLedgerReservation(ACTIVE)<br/>⚠ 转移所有权，不重复占用"]
    N5["履约事实下推正式订单<br/>展示态 FULFILLING / COMPLETED / EXCEPTION<br/>DELIVERY_CREATED 仅预留事件，当前未写入"]
    N6["CANCELLED 取消 → 释放预占 ORDER_RELEASED<br/>任一 HOLD=TRANSFERRED 则禁止取消"]

    N1 --> N2 --> N3 --> N4 --> N5
    N2 -.取消.-> N6
```

- 提交预占重复请求返回 409（不静默重建）；目录变价返回 `REPLENISHMENT_PRICE_CHANGED` 要求回草稿确认。
- 并发接单只有一单成功，其余凭 `FulfillmentLink` 唯一键 replay 返回同一结果。

### E4 收货与财务派生

```mermaid
flowchart TD
    G1["订单原子收货 PATCH /orders/:id/receive<br/>仅门店角色，PO=PENDING_CONFIRM"]
    G2["Serializable 事务<br/>配送单 DELIVERED→RECEIVED (rowVersion CAS)<br/>Receipt 直接 CONFIRMED + confirmedAt<br/>回写 receivedQty + RECEIVED 事件"]
    G3["事务外派生 ensureReceiptDerivatives<br/>凭证 借1405/贷2202（总仓跳过）<br/>PaymentSchedule + Reconciliation → Receipt ACCOUNTED<br/>成本重估 + 通知（失败由 repairReceiptDerivatives 补偿）"]
    G4["独立入库单路径 Receipt<br/>DRAFT→PENDING_CONFIRM→CONFIRMED<br/>confirm-with-loss 部分收货+短量报损<br/>REJECTED 拒收 / VOID 作废 / 金额更正审批"]
    G5["截止 12:00（北京时间）<br/>超时只标记 requiresAction，不自动确认收货"]

    G1 --> G2 --> G3
    G4 --> G3
    G1 -.时间闸门.-> G5
```

- `Receipt.totalAmount = Σ(receivedQty × unitPriceSnapshot)`，不用 PO 总额；`deliveryOrderId` 唯一约束兜底重复收货。
- 短量/破损按 **kind 分组**建报损单（按 reason 分组会影响两位小数舍入边界）；`payableBasis='NET_AT_RECEIPT'`。

### E5 报损/到货差异闭环

```mermaid
flowchart TD
    L1["创建 LossClaim(PENDING)<br/>kind: ARRIVAL_SHORTAGE / ARRIVAL_DAMAGE / WRONG_ITEM / INTERNAL_WASTE<br/>payableBasis: NET_AT_RECEIPT / GROSS_PENDING_CLAIM / NOT_APPLICABLE"]
    L2["24h 自动同意（未逾期且非 manual）<br/>PENDING → AUTO_APPROVED"]
    L3["供应商 handle: approve / reject<br/>APPROVED / REJECTED → 通知总厨仲裁"]
    L4["总厨仲裁 resolve<br/>REJECTED → RESOLVED<br/>按 finalDeductAmount 结算"]
    L5["应付调整<br/>NET_AT_RECEIPT: 不重复扣，仅解冻 ON_HOLD<br/>GROSS_PENDING_CLAIM: amount − 差异<br/>PAYING/PAID 禁止改金额"]
    L6["结案 tryCompleteOrder<br/>无 PENDING/REJECTED 报损 → RECEIVED → COMPLETED"]

    L1 --> L2 --> L5
    L1 --> L3 --> L4 --> L5
    L5 --> L6
```

- **应付基准二选一**：验收净额（`NET_AT_RECEIPT`）确认差异不再扣款；事后补报（`GROSS_PENDING_CLAIM`）确认后才从全额中扣。
- 任何未决差异 → `PaymentSchedule.status='ON_HOLD'`；逾期补报必须人工审批，不走 24h 自动同意。
- 店内报损 `<¥500 → AUTO_APPROVED`，`≥¥500 → PENDING`（`≥¥3000` 通知老板）；`INTERNAL_WASTE` 不进供应商应付。
- `ARRIVAL_SHORTAGE` 结案按行冲回 `ORDER_OUTBOUND`；`ARRIVAL_DAMAGE` 不自动冲回。

---

## 五大主流程总览

| 流程 | 触发角色 | 核心状态链 | 关键产出 | 安全/不变量 |
|---|---|---|---|---|
| A 日报→BOM→库存 | 店长 / 总厨 | PREVIEWED→CONFIRMING→CONFIRMED→SUPERSEDED | 营业/销量/消耗、DeferredBomTask、预计库存 | 单事务原子、指纹刷新、幂等回补 |
| B 上游采购 | 供应链 / 供应商 / 财务 | 合同→订单(MULTI)→发货→验收(复审)→索赔→月结 | 总仓台账流水、差异单、结算单 | 转移表强校验、高于标准价禁入、双人复核 |
| C 财务闭环 | 财务 / 系统 | PaymentSchedule→Reconciliation→Invoice→Payment→Voucher | 账期、对账单、付款、资金流水、凭证 | 防重付互斥、CMB默认关、月结锁账 |
| D 库存域 | 供应链 / 店长 | 单据 POSTED→CONFIRMED→REVIEWED；盘点/调拨 | 台账流水、盘点基准、调拨双账 | 复审才过账、快照基准、净成本冻结 |
| E 门店履约 | 厨师长/店长 / 供应商 / 总厨 | SUBMITTED→CONFIRMED→DELIVERING→PENDING_CONFIRM→RECEIVED→COMPLETED | 配送单、收货单、报损、账期 | 不可变快照、预占转交、无自动收货 |

**一句话总链路**：

> 门店下单（预占）→ 供应商接单（转交预占）→ 发货（关余量）→ 送达（仅解锁）→ 门店人工收货（生成 Receipt + 短量报损 + 凭证/账期/对账，入库应付按实收净额）→ 报损结案（24h 自动同意或总厨仲裁，冻结账期解冻）→ 订单 COMPLETED → 财务按账期付款 → 凭证与月结。日报每日把销量按 BOM 扣成食材消耗，在盘点基准上滚动出“预计库存”；总仓采购则走合同、订单、验收复审、月结的独立闭环。
