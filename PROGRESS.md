# 滇界 · 开发进展(自最近 Sprint 起)

> 2026-09-24 字段口径复核：实时库存查询表继续使用“库存金额（不含税）/库存均价（不含税）”，与现有 netAmount/netPrice 计算口径和外部文件导入合同保持一致；本次不使用“库存金额/库存均价”模糊文案，避免被误解为含税或台账成本口径。

> 2026-09-24 本地大数据量验证：已通过真实接口保存 500 个模拟商品、100 张入库单、100 张出库单与 8,000 条流水，标记“性能测试 / LT20260924”，日期 9 月 22～24 日。余额与流水一致，原商品余额不变；分页、筛选、导出及每页 100 条横纵滚动验证通过。数据留存在本机测试库，远程未写入。详见 [测试数据说明](docs/development/local-volume-data-20260924.md)。

> 2026-09-24 UAT 发布准备：用户授权仅部署原测试端。刷新远端引用后基线无变化；重新完成前端 853 项、API 1,185 项、真实 PostgreSQL 集成 262 项测试、前端类型检查、API 构建和运行环境检查，最近一次前端生产构建也已通过。当前本机 SSH agent 无身份、无默认密钥、系统凭据库无服务器记录，root@116.62.32.162 非交互登录仍被拒绝；已请求用户配置可用登录方式。发布改动整理为本地提交，尚未上传/部署，测试及正式服务均未变更。恢复后按 scripts/deploy-uat.sh 发布，并验证外部登录、数据库、新接口与页面；不可宣称上线完成。

> 2026-09-24 10:09 连通复核：本机网页代理/API 健康检查均 db=ok，真实账号登录、PostgreSQL 95 个迁移记录和历史测试数据持久化正常，25kg/250元库存与流水一致；9 个管理接口直连/代理记录一致，8 张库存报表与 3 张财务报表查询均 200，Redis PING 正常。远程 UAT 登录及 UAT/正式站数据库健康检查通过，但 UAT 新版管理接口仍 404（未部署）。部署脚本按独立目录、数据库、服务和配置区分 UAT/正式；当前 SSH 非交互认证仍失败，部署需先解决服务器授权及提交未提交代码。本次未部署、未新增业务单据。

> 2026-09-24 导出按钮统一：移除库存/财务报表导出按钮左侧“报表明细”，四个模块统一使用白底“导出列表”按钮；保留导出当前查询全部记录的逻辑。财务页面现有测试、前端类型检查及生产构建通过；浏览器确认白底按钮及标题移除，本地 :3200 已更新，未部署远程。

> 2026-09-24 报表工具布局：库存报表与财务报表右上角统一为“专注表格 / 表格设置”；导出 Excel 移到筛选下方、表格左上角“报表明细”标题旁，记录数右对齐，移除原明细栏的行高切换和重复列设置入口。财务页面现有 2 项测试、前端类型检查、生产构建通过；浏览器验证两个模块设置弹窗及财务导出成功。本地 :3200 已更新，远程测试与正式环境未部署。

> 2026-09-24 专注表格：库存管理、盘点管理右上角“紧凑行高”替换为“专注表格”，铺满窗口并保留筛选和勾选记录，可用按钮或 Esc 退出；日历弹窗优先响应 Esc。相关 28 项测试、类型检查及生产构建通过，浏览器验证采购与盘点页面进入/退出正常，专注区铺满 1280×720 窗口。本机 :3200 已更新，未推送或部署远程。库存报表日期口径复核：出入库与调拨的 5 张期间报表提供日期范围，实时库存、呆滞品及库存预警按当前库存查询。

> 2026-09-24 搜索栏调整：在美团采购退货出库页只读试选日期、快捷范围和展开/收起筛选后，库存管理、盘点管理、库存报表、财务报表统一使用紧凑横排搜索栏和双月日期范围选择器；先选开始再选结束，自动收起，支持六个快捷范围、月份/年份切换及清空。移除右上角功能/报表切换下拉框，窄屏保留独立菜单入口。前端 851 项测试、类型检查、生产构建通过；实际采购、盘点、库存和财务页面查询及 390px 双月弹层验证通过。本机 :3200 已更新，服务器测试版与正式版未部署。详见 [搜索交互记录](docs/development/scm-search-reference-20260924.md)。

> 2026-09-24 环境复核：原服务器测试入口为 `http://116.62.32.162:8085/v2/login?tenant=supply-chain-uat`，与本机 `127.0.0.1:3200` 独立；服务器测试与正式站健康检查正常。服务器 UAT 八个 `13970000001`～`13970000008` 账号已可使用用户指定测试密码，本机对应账号已同步并逐一验证。服务器新管理接口仍为 404，新版尚未部署。部署脚本现在显式区分正式/测试构建的默认租户和 API 代理，避免本地 `.env.local` 预览设置进入正式产物；脚本语法及 Next 环境加载优先级验证通过，未执行远程部署。

> 2026-09-24：库存管理、盘点管理、库存报表、财务报表统一为两列悬停菜单卡片。库存/盘点仅显示已打开的标签，各标签右上角可关闭，跨两模块保留标签；关闭当前页切换相邻页，全部关闭返回工作台。压缩搜索区并让表格填充剩余高度；1440×900 实测搜索区约 106px、表格区约 589px，390px 窄屏无整体横向溢出。前端 840 项测试、类型检查及生产构建通过，本地 :3200 已更新，未推送。

> 2026-09-23 本地真实联调：前端 → API → PostgreSQL 已实测连通，Redis 读写正常。95 个迁移全部应用且无结构差异；采购审批/发货/验收入库、其他出入库、单据审核、盘点确认、权限隔离及 Excel 导出通过。修复 PostgreSQL DATE 日期筛选漏查当天盘点的问题。后端 1,185 项、真实数据库集成 262 项、前端 839 项测试全部通过，后端构建及前端类型检查通过；编译后的后端重启后页面仍能读取记录和 25kg 库存。测试使用本机隔离库，不涉及生产数据、外部业务调用或远程推送。详见 [真实联通验证记录](docs/development/local-management-verification-20260923.md)。

> 2026-09-23：只读核对美团 9 个功能页，新增平级“库存管理 / 盘点管理”导航与表格；采购入库排除指定 4 项，其余逐页保留字段及顺序。支持筛选、分页、金额合计、字段设置和 Excel 导出，接入已有采购收货/仓库单据/门店盘点/库存台账。采购退货、多人盘点及独立盘盈/盘亏单缺少业务来源，页面明确提示，不伪造记录。43 项针对性测试、前后端类型检查和本地桌面/窄屏布局验证通过；接口测试使用模拟数据库，未连接生产数据、未部署。详见 [核对与实现说明](docs/inventory-management-ui-audit-20260923.md)。

> 2026-09-22：按新附件统一 8 张库存报表、3 张财务报表的菜单、211 个字段及列顺序，页面/API/Excel 一致；新增其他出入库汇总、呆滞品和库存预警查询。33 项测试及本地浏览器验证通过；缺少业务来源的字段保留为空，未部署。详见 [字段调整交接](docs/development/report-fields-2026-09-22.md)。

> 2026-09-22：财务报表 UI 已获批准并接入本地 API/PostgreSQL。三张总部配送毛利报表共用出库/冲回投影与 Excel 导出，已验证订单发货及减量联动、权限隔离和缺成本处理；未部署。详见 [财务联调记录](docs/development/finance-reports-2026-09-22.md)。

> 2026-09-21：库存报表本地联调：5 张报表接入真实 API；门店调拨登记持久化；悬浮导航与可关闭标签整合到供应链工作区。调拨登记不改写门店盘点库存，尚未部署。详见 [联调记录](docs/development/inventory-reports-2026-09-21.md)。

> 2026-07-25：内部供应链 `SUPPLY_CHAIN` 角色完成安全收口（租户内跨店只读订单/配送/收货/库存/纯消耗，独立只读工作台；营业额、成本率、收货财务对象及业务写操作均拒绝）。仅本地修复与验证，未部署。

> 更新日期:2026-04-30 (本机时间)
> 局域网访问: http://192.168.1.70:3200/v2/login

## 已完成的产品模块

### A. 6 角色 home + 路由 ✅
- BOSS / FINANCE / MANAGER / KITCHEN_LEAD / CHEF_DIRECTOR / SUPPLIER_OWNER
- 6 个测试账号(密码 dj123456)
  - admin@dianjie.com (老板·王总)
  - finance@dianjie.com (财务·刘)
  - dqg@dianjie.com (店长·大行宫)
  - chef@dianjie.com (厨师长·王凯)— 程序新建
  - zc001@dianjie.com (总厨·黄辉)
  - supplier@dianjie.com (供应商·武胖子)
- 首登 onboarding 2 屏教学(每角色一套)
- BottomNav 全部连线

### B. 核心闭环 · 食材采购 ✅
1. 厨师长下单(/v2/chef/purchase/new) — 已修 BUG1 storeId 缺失
2. 供应商接单 + 发货(/v2/supplier/orders)
3. 厨师长收货 + 短量自动报损(/v2/chef/purchase/[id]/receive)
4. 总厨审批(/v2/chef-director/approvals) — PA / NS / ND 三类文档
5. 报损链(/api/loss-claims) — BUG2/3 已修但未部署

### C. 营业额 + 报表 ✅
- 4 渠道分录(微信小程序/支付宝/现金/平台券+实际到账)
- 平台抽成自动算 → 销售费用
- P&L 显示 GMV / 净到账 / 平台抽成
- 报表柱状图前端 cutoff 过滤 seed 异常(2026-04 起)

### D. 通知 + 我的 ✅
- 铃铛 30s 轮询未读
- /v2/notifications 完整列表
- /v2/me 通用我的页 + 重置 onboarding

### E. 收款方案设计 ✅
- 门店收款配置(/v2/boss/stores/:id/settings) — 4 圈聚合平台选择
- 收款上线追踪(/v2/boss/payment-onboarding) — 16 项 BD/技术/上线 checklist
- 平台券核销日记(/v2/manager/voucher-todo)
- CSV 上传(/v2/manager/upload-platform)
- 已确定方案:**收钱吧服务商模式 0.31% 全场景**(店内扫码 + 自营小程序)

### F. 发票链路(月度开票 + 部分付款)✅ 待部署
- Schema:Invoice / InvoicePayment(累计 paidAmount + fullyPaidAt)
- 路由:/api/invoices, /api/invoice-payments
- 页面:供应商上传发票(勾订单)/ 财务发票审核 / 财务应付管理(部分付款)
- 关键:Invoice → Receipt 1:N(月度统一开票),InvoicePayment 累加 ≤ amount
- 校验:发票金额 ≈ 关联订单合计;付款 ≤ 剩余可付

### G. 总部代付 + 门店还款 ✅ 待部署
- Schema:CapitalProject / Contract / Expense / StoreRepayment
- 状态机:店长申请 PENDING_APPROVAL → 老板/财务批 APPROVED → 财务付 PAID
- 店长端入口:⊕ 中央抽屉 → 「筹建/代付」
- 老板/财务:我的 → 代付项目总览 / 代付申请审批
- 关键:`PAID` 时才累加 `contract.paidAmount` + `project.spent`
- 业务收益:门店真实经营 = 营收 - 成本 - **总部还款**

### H. 已知 Bug 修复 ✅(待部署)
- BUG1 `routes/orders.ts:90` KITCHEN_LEAD storeId 漏在白名单,改用 `isStoreScoped()`
- BUG2 `routes/lossClaims.ts:122` SUPPLIER_OWNER 不能处理报损 → 加 `isSupplierRole()` helper
- BUG3 `routes/orders.ts` ship + list 同样 role 白名单问题
- 前端 fallback:chef 下单显式传 storeId(已生效)

## 待部署清单(这是您出门后我无法做的)

```bash
# ECS 上 dianjie-api 项目
prisma migrate dev   # 加新表: invoices / invoice_payments / capital_projects /
                      #         capital_contracts / capital_expenses / store_repayments
                      # 加字段: receipts.invoiceId, invoices.paidAmount/fullyPaidAt,
                      #         stores.aggregatorVendor / wechatMerchantId 等(共 9 个)
                      # 加 enum: InvoiceStatus / PaymentStatus / CapitalProjectType /
                      #         CapitalProjectStatus / CapitalCategory / ContractStatus /
                      #         CapitalExpenseStatus
pm2 restart dianjie-api

# 部署 web(可选,前端已 LAN 跑)
cd apps/web && pnpm build && scp .next ECS:/app/dianjie-web/
pm2 restart dianjie-web

# 资质相关(同时进行,不阻塞代码)
- ICP 备案 (域名)
- 微信支付商户号申请
- 美团开放平台 服务商申请
- 抖音生活服务 服务商申请
```

## 下次开发可以从这开始

### 优先级 P0
1. **部署后端** - 让发票 / 代付 / role 修复 全部激活
2. **OSS 接入** - invoices.ts 和 capital.ts 都有 file upload TODO,需要接 ali-oss 写入
3. **真实跑通** 一笔月度发票流程:厨师长下 N 单 → 月底供应商上传总票 → 财务审 → 部分付款

### P1(产品差异化)
1. **AI 异常洞察** - 老板首页加智能提示:"朝阳店报损率连续 3 周 > 集团均值 0.7pp,建议..."
2. **每月自动周报** - 老板周日晚收到 PDF 报告
3. **储值卡 schema** - 为未来微信会员储值预埋
4. **小程序点单** - 自营生态(等收钱吧上线后再启动)

### P2(体验)
1. **SSE 推送** Hero 实时数字 — 收钱吧 webhook 来了立刻显示
2. **Capacitor APK / iOS** 真机包
3. **Sentry DSN** 配生产
4. **多租户 onboarding** - 注册即上线流程

## 6 角色入口图

```
(每个角色登录后默认跳到自己 home)

BOSS 老板    /v2/boss/home + 5 Tab + ⊕ 我的(代付总览/审批 入口)
MANAGER 店长 /v2/manager/home + 5 Tab + ⊕ 中央抽屉:
              ¥ 录入营业额
              ✓ 券核销待办
              ⇪ 平台对账
              ◧ 月度杂费
              ⊞ 筹建/代付  ← 本店项目入口
              🍲 食材采购单
              ⎙ 备用金 / 报销 / 非食材
KITCHEN_LEAD 厨师长 /v2/chef/home (4 Tab + 食材采购流)
CHEF_DIRECTOR 总厨  /v2/chef-director/home (审批 4 类 + 报损二审)
FINANCE 财务  /v2/finance/home + 5 卡:初审/发票/应付/代付审批/资金
SUPPLIER 供应商 /v2/supplier/home + 4 Tab + 上传发票入口
```

## 完整文件改动汇总(本 Sprint)

```
新建:
  apps/api/src/routes/invoices.ts            发票 API
  apps/api/src/routes/invoicePayments.ts     发票部分付款
  apps/api/src/routes/capital.ts             代付项目(状态机)
  apps/pay-puller/                           收款拉单微服务骨架(:5002)
  apps/web/src/app/v2/supplier/invoices/     供应商上传发票
  apps/web/src/app/v2/finance/invoices/      财务发票审核
  apps/web/src/app/v2/finance/payable/       财务应付管理(部分付款)
  apps/web/src/app/v2/finance/capital-review/ 财务代付审批
  apps/web/src/app/v2/manager/capital/       店长代付项目
  apps/web/src/app/v2/manager/capital/[id]/  店长代付详情
  apps/web/src/app/v2/boss/capital/          老板代付总览
  apps/web/src/app/v2/boss/capital/[id]/     老板代付详情
  apps/web/src/app/v2/boss/stores/[id]/settings/  门店收款配置
  apps/web/src/app/v2/boss/payment-config/   选店配置入口
  apps/web/src/app/v2/boss/payment-onboarding/    收款上线追踪
  apps/web/src/app/v2/manager/voucher-todo/  券核销日记
  apps/web/src/app/v2/manager/upload-platform/ 平台 CSV 上传
  apps/web/src/app/v2/manager/revenue/       营业额录入(4 渠道升级)
  apps/web/src/app/v2/manager/expenses/      杂费录入

修改:
  packages/db/prisma/schema.prisma           Invoice/InvoicePayment/Capital* 6 表
  apps/api/src/routes/orders.ts              isStoreScoped + isSupplierRole
  apps/api/src/routes/lossClaims.ts          isSupplierRole
  apps/api/src/lib/auth-scope.ts             加 KITCHEN_LEAD + isSupplierRole helper
  apps/api/src/routes/auth.ts                login 返回顶层 storeId
  apps/api/src/routes/stores.ts              payment-config GET/PATCH
  apps/api/src/routes/profit.ts              platformFee 拆解
  apps/api/src/routes/schedules.ts           include receipt.invoice
  apps/api/src/index.ts                      注册新路由
  apps/web/src/app/v2/manager/_drawer.tsx    新增 5 个抽屉项
  apps/web/src/app/v2/me/page.tsx            老板/财务 加多入口
  apps/web/src/app/v2/manager/ops/page.tsx   接真 P&L
  apps/web/src/app/v2/finance/funds/page.tsx 加发票状态警示
  apps/web/src/app/v2/supplier/billing/page.tsx 改发票视角 + 付款进度
  apps/web/src/app/v2/finance/home/page.tsx  5 卡入口
  apps/web/src/app/v2/boss/reports/page.tsx  柱状图修 + 真数据
  apps/web/src/app/v2/login/page.tsx         加 chef 测试账号
```

---

下次启动:
1. 局域网测试: web 已在 :3200 跑(pnpm dev), 手机扫码访问 http://192.168.1.70:3200/v2/login
2. 部署:用户授权 SCP/SSH 后,1 次部署激活全部新功能
