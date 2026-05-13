# 滇界 · 开发进展(自最近 Sprint 起)

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
