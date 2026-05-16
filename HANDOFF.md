# 滇界 v4 · 上下文交接(2026-05-16)

> 写给下一个会话。用户在 auto mode 下连续工作多日,此文档 = 当前进度快照 + 待办 + 关键决策。
> **用中文回复**(用户偏好,见 `~/.claude/projects/-Users-somnusyi-Desktop/memory/MEMORY.md`)。
> Repo: `/Users/somnusyi/Projects/dianjie-local`

---

## 一句话定位

**滇界云管 v4** — 多角色连锁餐饮 SaaS,**南京云洱之境餐饮(20 家店)深度自用**,先合肥瑶海店试点,后续逐步全店迁移。

---

## 关键基础设施

```
ECS:        116.62.32.162 (root / weiyi9216!)
公网 URL:   http://116.62.32.162:8080  (备案后切 https://www.njdianjie.com)
PM2 进程:   dianjie-v4-api (port 4004) + dianjie-v4-web (port 3204) + dianjie-v4-cmb (5001)
DB:         dianjie_v4 @ 阿里云 RDS PostgreSQL
本地路径:    /Users/somnusyi/Projects/dianjie-local
GitHub:     git@github.com:somnusyi/dianjie-V4.git  (private, ssh key ~/.ssh/github_dianjie)
```

### 部署套路(踩坑后定稿)
```bash
# 1. 改 schema → migrate
cd packages/db && pnpm prisma generate
# 推 migration 到 ECS 同时去 pnpm 快照
PNPM_DB=/app/dianjie-v4/apps/api/node_modules/.pnpm/@dianjie+db@file+packages+db_prisma@5.22.0/node_modules/@dianjie/db
sshpass -p 'weiyi9216!' rsync -az packages/db/prisma/ root@116.62.32.162:/app/dianjie-v4/packages/db/prisma/
sshpass -p 'weiyi9216!' rsync -az packages/db/prisma/ root@116.62.32.162:$PNPM_DB/prisma/
sshpass -p 'weiyi9216!' ssh root@116.62.32.162 "cd /app/dianjie-v4/packages/db && DATABASE_URL=\$(grep ^DATABASE_URL /app/dianjie-v4/apps/api/.env | cut -d= -f2-) pnpm prisma migrate deploy"
sshpass -p 'weiyi9216!' ssh root@116.62.32.162 "cd /app/dianjie-v4/apps/api && set -a; . .env; set +a; npx --yes prisma@5.22.0 generate --schema=$PNPM_DB/prisma/schema.prisma"

# 2. 编译 + 推 dist + 重启
cd apps/api && npx tsc --skipLibCheck
cd apps/web && pnpm build
sshpass -p 'weiyi9216!' rsync -az --delete apps/api/dist/ root@116.62.32.162:/app/dianjie-v4/apps/api/dist/
sshpass -p 'weiyi9216!' rsync -az --delete apps/web/.next/ root@116.62.32.162:/app/dianjie-v4/apps/web/apps/web/.next/
sshpass -p 'weiyi9216!' ssh root@116.62.32.162 'pm2 restart dianjie-v4-api dianjie-v4-web'

# 3. 验证 (必跑)
bash scripts/deploy-verify.sh
```

⚠ **历史教训**:rsync 偶发漏传 / dist 没编译完 / migration 漏到 pnpm 快照 — **改 schema 后 PNPM_DB 那行必跑**。

---

## 测试账号

**dianjie tenant**(生产):17 真实员工(李伟/黄瑞/林城/刘蕾/武艺...);测试账号 `13900000005 / test1234` 厨师长 / 合肥瑶海店

**test tenant**(测试):短账号 `boss / fin / mgr / cd / chef / sup1 / sup2 / eng` + `test1234`(短账号自动落 test tenant)

---

## 当前关键阻塞(等待中)

| 阻塞项 | 原因 | 影响 |
|---|---|---|
| **企微 SSO 端到端** | 等 njdianjie.com **ICP 备案**(阿里云 ECS 不在腾讯,所以备案走阿里云;5-15 工作日) | 通知卡片按钮不能跳转,但 notify 层已写好,SSO 通即激活 |
| **美团 POS 营业额自动** | 等品牌商审核(2-3 周) | 营业额/菜品销量目前要手工录 |
| **DNSPod 域名解析** | 用户已加 A 记录但备案没过 | 同上 |

**关键策略**:阻塞期内做**不依赖这两个**的所有工作(还有 13+ 项可做,见下面 Week 1)。

---

## 系统当前状态(2026-05-16)

### 已上线的核心模块

```
角色完整:
  ADMIN (老板) / FINANCE / CHEF_DIRECTOR (总厨) / MANAGER (店长)
  KITCHEN_LEAD (厨师长) / SUPPLIER_OWNER / SUPPLIER_STAFF / ENGINEERING
  + SUPERVISOR (主管) + STAFF (一线员工,未开账号,后放)

业务核心:
  ✓ 订单状态机 5 段 (已发起/接单/在途/送达/验收)
  ✓ 收货验收 + 报损流程 (供应商同意/拒绝, 总厨仲裁)
  ✓ 库存(供应商端 + 门店端推算)
  ✓ 双轨 SKU 已修(327 真实 + 旧 seed)
  ✓ 厨师长采购 (购物车 + 起订量 + 断货软提醒)
  ✓ 总厨代下单 (选店 + opLog 标「总厨代」)

财务模块(本次会话核心交付, Day 1-5 + P0 修复):
  ✓ 凭证体系 (用户好会计 294 科目 import + 自动生成 + Excel 导出)
  ✓ 4 个业务事件触发凭证: 收货/付款/报损/营业额
  ✓ 周期模板 (房租/折旧/摊销 月度自动)
  ✓ 4 张管理报表: 利润中心/账龄/食材成本/现金流瀑布
  ✓ 对账自检 (凭证 vs CashTransaction)
  ✓ 凭证多选批审 + 导出 Excel 给好会计
  ✓ 付款申请 (PAYMENT_REQUEST, 复用 Document 引擎, ≤¥1000 自审/>¥1000 老板批)

菜品 BOM(本次会话最后一轮, Week 1 P0):
  ✓ Dish + DishRecipe + DishSale 三表
  ✓ /api/dishes/* 全部 CRUD + 销量榜 + 食材消耗推算
  ✓ /v2/chef-director/dishes 列表+详情+配方编辑
  ✓ **销量录入 → 自动 StockConsumption** (按 BOM × 损耗率, 幂等)
  ✓ 美团对接预留 source='meituan'

招行 CMB 集成:
  ✓ 实时账户 + 流水 + 转账 + 回单 + prewarm 缓存

企微集成:
  ✓ M0 数据基础 (Role + STAFF/SUPERVISOR, storeIds[], NotificationPref/Log)
  ✓ M2 通知层完整 (notify(), 6 事件接通)
  ⚠ M1 SSO 代码完成等 DNS 备案
  ⚠ 配置已写入 DB (CorpId/AgentId/Secret)
  ⚠ access_token 验证通 (errcode=0)
```

### Tenant 主体确认

- **南京云洱之境餐饮管理有限公司**(用户企业)
- 域名: njdianjie.com(已购,DNS 加好,**备案中**)
- 好会计科目体系: **小企业会计准则 2013**(294 个真实科目已导入两个 tenant)

---

## Week 1 路线图(基于"等 DNS+美团,资源不变,20 店深度自用,一线员工后放")

### ✅ 已完成
1. 菜品 BOM 基础设施 (`1e576ae`)
2. 销量 × BOM 自动扣库存 (`099ac21`)

### 🔜 接下来按优先级
3. **老板跨店大屏 + 危机告警**(20 店主诉,P0)
   - 实时各店 GMV/净利/食材占比/异常红圈
   - 危机告警:food%>40% / loss%>5% / 现金流偏离均值
4. **集团合并报表**(20 店利润/对比/合并三大表草稿,P0)
5. **智能订货建议**(BOM × 销量预测 = 未来 3 天用量,P1)
6. **跨店调拨 UI**(schema 已有 STORE_TRANSFER,P1)
7. **菜品销量榜前端**(后端 endpoint 已就绪,P1)
8. **预算 vs 实际**(店长拍预算,月底比对,P1)
9. **客诉上报 → 店长**(P1)
10. **电子发票 OCR**(供应商上传 → 自动凭证关联,P2)
11. **数据迁移工具**(其他 19 家批量导入,P2)
12. **新店 onboarding**(P2)
13. **错误信息中文化 + 监控告警通道(SMS,绕过企微)**(P2)
14. **多店性能压测**(克隆 20 店数据,验证 P95 < 500ms,P2)

### 阻塞解锁后(等 DNS 和美团审核)
- 企微 M1 SSO 端到端验证 → 200+ 人触达激活
- 美团 POS 接通 → DishSale 自动 ingest

---

## 决策/上下文要点(用户偏好)

1. **目标**:深度自用,**不做 SaaS 卖给别家**
2. **资源**:1 人(用户) + 1 个 AI (Claude),每周 5-7 个中型任务
3. **20 家店**:都是直营(假设,但用户没明确选 A/B/C 主体结构,需进一步确认)
4. **其他 19 家店现在用什么**:未确认(用户没回 A/B/C/D)
5. **一线员工(STAFF)**:**后放**,先做管理层
6. **凭证体系**:用户好会计 = 小企业准则 5xx(已 import 294 真实科目)
7. **付款申请阈值**:¥1000(≤ 自审 / > 老板批)
8. **WebView 兼容**:用 ConfirmSheet 不用 native alert/prompt/confirm
9. **图片放大**:用 state-driven lightbox 不用 target=_blank
10. **JWT 365 天**:除非主动登出
11. **deploy-verify.sh 必跑**:防 rsync 偶发漏

---

## 已有 P1 / P2 尾巴(记着,但不紧急)

- 6 条 audit movement 回填(我合并 SKU 时改 stock 没写流水,数据对得上但审计断流)
- fire-and-forget 凭证错误静默吞(应加 voucher_generation_failures 表)
- Excel 导出 exportedAt 写在 send 之前(网络断时误标)
- recon-check ±3 天首笔贪心匹配(同金额多笔会错配)
- 模板 entriesJson 应校验 accountCode ∈ CoA
- idempotency 内存 Map 集群下不共享
- ship shippedQty=0 + refund 凭空 +stock 的边角
- supplierInsights 缺 tenantId 防御性 where(目前单租户没事)
- 招行账户在好会计里还没加(用户加完告诉末四位,改 voucherForPayment 映射)

---

## 关键 spec 文档

- [docs/2026-05-15-企微集成-Spec.md](docs/2026-05-15-企微集成-Spec.md) — 顶层架构 + 决策记录
- [docs/2026-05-14-双人协作部署规范.md](docs/2026-05-14-双人协作部署规范.md) — 同事协作规则
- [docs/2026-05-14-本地与部署隔离-SOP.md](docs/2026-05-14-本地与部署隔离-SOP.md)

---

## 接手建议(给下一个 Claude)

1. **打开第一件事**:`git log --oneline -10` 看近期 commit 节奏
2. **不要重新整理这份文档** — 用户烦
3. **业务问题先看 schema.prisma + 相关 route**,代码已经覆盖大部分
4. **改 schema 后 PNPM_DB 那行必跑** (踩过多次坑)
5. **部署完必跑 deploy-verify.sh**
6. **用户给凭证/钱**,他都贴这里,**用完建议放 .env**
7. **API curl 测试用 fin/test1234 (test tenant)** 最快
8. **TS 错忽略** `invites|cashbook|paymentSchedule` 三个文件的历史错(不影响 emit)
9. **改用 prisma updateMany + tenant scope**,不要 update by id only(跨租户风险)
10. **fire-and-forget 调用**:`apps/api/src/services/voucher/index.ts createVoucherAsync` 模式 — 业务流不被凭证拖死

---

**最后状态**:
- 远端 main HEAD = `099ac21`
- 本地无未提交改动(刚 commit + push 完)
- API + Web 在线
- Migration 截至 `20260516060000_stock_consumption_source` 全部 applied
- 下一项推荐:**老板跨店大屏 + 危机告警**(20 店主诉的最高 ROI)
