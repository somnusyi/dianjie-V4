# 库存报表前后端联调记录

日期：2026-09-21；分支：`DianJie_v1.1.0`；起点：`release/supply-chain-uat-20260917` 的 `9f75e1f`。

## 本轮范围

5 张报表整合到 `/v2/supply-chain/reports?report=...`，从真实 API 和 PostgreSQL 读取数据；原 `docs/ui-previews/inventory-reports` 继续保留为设计参考。左侧库存报表悬浮菜单、顶部可关闭标签、查询/重置、数值范围、排序、分页、列设置、紧凑布局、专注表格、Excel 导出均已接入。工作台、订单中心以及库存作业、入库记录、单据审核保留原路由。

用户明确：机构间调拨是**门店之间调拨**，不是总仓配送到门店。原调拨页只用 sessionStorage 保存演示单，本轮增加 `StoreTransfer`、`StoreTransferItem` 和迁移 `20260921100000_store_transfer_reports`，前端改读写 `/api/store-transfers`。原浏览器临时单不会自动导入，以免把演示数据当真实业务记录。

## 数据口径

| 报表 | 数据来源与口径 |
| --- | --- |
| 实时库存 | WarehouseLedgerBalance；预计出库=reservedQty；预计入库=已提交且未终结采购行 max(确认数量或订货数量−合格验收数量,0)×冻结采购换算系数。尚无余额但有在途采购的商品也显示。 |
| 出入库明细 | WarehouseLedgerMovement，排除预占/释放；冲销保留反向记录。关联单据和采购/配送上游信息。只对有采购冻结税率依据的收货记录给出不含税金额，其余为空，不假定零税率。 |
| 出入库汇总 | 期初为所选开始日前全部流水增量；期间纳入所有实物/金额调整；期末=期初+入库−出库。金额是库存账面成本，不是不含税口径。类型筛选选择期间有该类型的物品，但不剔除其其他流水，以维持余额勾稽。 |
| 门店调拨明细 | StoreTransferItem 的冻结名称、单位、数量、人工确认成本价/结算价和金额；仅 SHIPPED、RECEIVED。按业务调拨日期统计。 |
| 门店调拨汇总 | 按商品、单位、调出店、调入店聚合；成本价=总调出金额/数量，结算价=总调入金额/数量。先汇总后应用数量/金额范围筛选。 |

日期边界为 Asia/Shanghai。所有读取在 RepeatableRead 事务内完成，列表和 Excel 使用同一服务和筛选参数。Excel 包含全部匹配行及口径说明，不限于当前页。单次源明细超过 20,000 条明确报错要求缩小范围，不静默截断。调拨管理列表当前最多 1,000 单；超过后提示通过报表查询。

**边界：本轮完成报表和调拨登记持久化，没有改变门店库存核算方式。** 调拨登记不写入盘点快照，也不自动扣减/增加门店预计库存；上线业务库存过账前还需要定义门店库存计价、在途、验收差异和撤销规则。门店没有独立仓库主数据，调出/调入仓库字段显示“—”。成本价、结算价按所选商品库存单位录入并冻结，不套用商品当前报价或总部均价。

## 调拨状态机与权限

| 转换 | 角色 | API | 数据变化/受影响视图 |
| --- | --- | --- | --- |
| 新建 → PENDING | SUPPLY_CHAIN、SUPER_ADMIN、ADMIN、PURCHASER | POST /api/store-transfers | 创建头、明细与价格快照，记录创建人；调拨管理可见 |
| PENDING → SHIPPED | 同上 | PATCH /api/store-transfers/:id/status | 记录发货人及时间；两张调拨报表可见 |
| SHIPPED → RECEIVED | 同上 | 同上 | 记录收货人及时间；报表数量金额不重复增加 |
| PENDING → REVOKED | 同上 | 同上 | 记录撤回人及时间；报表不纳入 |

RECEIVED、REVOKED 是终态。状态更新用条件更新防并发覆盖；相同状态重试不重复写入。创建使用 requestKey 幂等。门店和商品均按登录租户校验，不接受前端传 tenantId。FINANCE 可读不可写；供应商、门店角色不能访问总仓报表或调拨登记端点。本轮未新增对外通知。

## 本地运行与数据库

- 使用 Node 20、pnpm 10.32.1；本次工具缓存安装在 `/tmp/dianjie-runtime`，不改系统 Node。
- PostgreSQL 16 独立容器 `dianjie-reports-postgres`，本地端口 55434，数据库 `dianjie_reports_test`，持久卷 `dianjie_reports_pgdata`。
- Redis 独立容器 `dianjie-reports-redis`，本地端口 56379。
- API 本地端口 4444，Web 3210。`apps/api/.env`、`apps/web/.env.local` 被 Git 忽略；不提交账号密钥。
- Web 同源 `/api/*` 通过 `NEXT_PUBLIC_API_BASE=http://127.0.0.1:4444` 代理，避免前后端端口不一致。
- 按完整 Prisma 迁移链 `prisma migrate deploy` 创建隔离库，没有使用 db push；未操作远程测试库或生产库。
- `seed-upstream-uat.ts` 创建隔离测试租户/账号；`REPORT_PREVIEW_SEED=LOCAL_REPORTS pnpm --filter @dianjie/api exec tsx scripts/seed-inventory-report-preview.ts` 添加本地报表测试门店 B 和幂等测试入库 100kg/1000元。后者强制 localhost + _test 数据库，禁止生产运行。
- 启动 API：`pnpm --filter @dianjie/api dev`；启动 Web：`WEB_PORT=3210 pnpm --filter @dianjie/web dev`。项目启动脚本通过 WEB_PORT 配置端口，不接收透传 `--port`。
- 预览入口：`http://127.0.0.1:3210/v2/login?tenant=supply-chain-uat`。本地账号密码与远程测试环境独立。

## 验证

- API TypeScript 构建、Web TypeScript 检查及 Next.js 生产构建通过，新增报表路由已生成。

- API 原单元测试：109 文件、1123 用例通过。
- Web 原测试：62 文件、792 用例通过；随后新增悬浮菜单事件测试，导航文件 10 用例通过（原 9 个 + 新 1 个）。
- 新 PostgreSQL 集成测试：6 组通过，覆盖身份认证、3 种权限、跨租户读取/写入阻断、北京时间边界、期初期末勾稽、未知税额、日期/范围验证、创建幂等、全部调拨状态转换、刷新重读、加权汇总和完整 Excel 导出。
- 实际服务登录 token 验证：SUPPLY_CHAIN 200、FINANCE 200、SUPPLIER_OWNER 403。
- 浏览器实际操作：登录 → 工作台 → 库存报表 → 订单中心 → 调拨建单 → 发货 → 收货 → 刷新保留 → 明细/汇总同时显示 5kg、50元/60元；查询空结果、重置、库存汇总、关闭非当前标签及关闭最后标签正常。
- 悬浮菜单的移入、跨越浮层、150ms 移出收起通过 DOM 事件测试；浏览器工具无独立 hover 操作，真实指针体验仍可由用户验收。

没有推送远程、创建 PR 或部署。本记录用于后续 UI/业务验收及最终交接文档的素材。
