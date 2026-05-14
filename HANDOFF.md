# 滇界 v4 项目 · 上下文交接

> 写给下一个会话:用户在 auto mode 下连续工作好几天,这是当前进度快照。
> 你接手后请用中文回复(用户偏好,见 ~/.claude/.../MEMORY.md)。

---

## 一句话定位

**滇界云管** — 多角色连锁餐饮 SaaS,部署在阿里云 ECS,服务 1 个真实门店「合肥瑶海店」(品牌方:南京捌拾捌号餐饮),v4 重构后已上线小规模生产试用。

---

## 关键基础设施

```
ECS:        116.62.32.162 (root / weiyi9216!)
公网 URL:   http://116.62.32.162:8080  (备案后切 https://app.dianjie.cc)
PM2 进程:   dianjie-v4-api (port 4004)  +  dianjie-v4-web (port 3204)
DB:         dianjie_v4 @ 阿里云 RDS PostgreSQL
本地路径:    /Users/somnusyi/Projects/dianjie-local  (单一 main 分支, 不开 worktree)
GitHub:     git@github.com:somnusyi/dianjie-V4.git  (private, ssh key ~/.ssh/github_dianjie)
```

### 部署套路 (今天踩过 N 次坑后定下的)
```bash
# 1. 编译
cd apps/api && npx tsc --skipLibCheck
cd apps/web && pnpm build

# 2. 推 ECS
sshpass -p 'weiyi9216!' rsync -az --delete -e 'ssh -o StrictHostKeyChecking=no' \
  apps/api/dist/ root@116.62.32.162:/app/dianjie-v4/apps/api/dist/
sshpass -p 'weiyi9216!' rsync -az --delete -e 'ssh -o StrictHostKeyChecking=no' \
  apps/web/.next/ root@116.62.32.162:/app/dianjie-v4/apps/web/apps/web/.next/

# 3. 重启
sshpass -p 'weiyi9216!' ssh -o StrictHostKeyChecking=no root@116.62.32.162 \
  'pm2 restart dianjie-v4-api dianjie-v4-web'

# 4. 校验(必跑, 防止 rsync 偶发漏传)
bash scripts/deploy-verify.sh
```

⚠ **历史教训**:rsync 偶发会出 mkstemp 错,文件没真同步。今天发现 inventory.js / scheduler.js / supplier-orders chunk 各漏过一次。**改完代码必须用 deploy-verify.sh 验证 hash 一致**。

---

## 测试账号

**dianjie tenant**(默认,真实生产):
- 真实员工 17 个(李伟/黄瑞/林城/刘蕾/武艺...真名+真手机号)
- **测试账号** (我刚加的):`13900000005 / test1234` → 测试厨师长 / 合肥瑶海店

**test tenant**(独立测试库,8 个演示账号):
- 短账号:`boss / fin / mgr / cd / chef / sup1 / sup2 / eng` (任意 + `test1234`)
- 输短账号自动切到 test tenant(同事的智能识别,login 页面有逻辑)

---

## 当前业务状态(可以直接看)

订单 **PO202605000001** 是核心测试单:
- 13 项 ¥2194.6
- 状态 **PENDING_CONFIRM**(供应商 5/14 08:48 已点送达, 24h 自动收货倒计时中)
- 真实 SKU 数据(羊肚菌/冻青头/保乐肩 ¥122 等)
- 等厨师长 13900000005 进去验收

合肥瑶海店:
- Receipt: 0(还没真验收过)
- StockConsumption: 0
- 店内报损: 0
- 库存(/api/inventory): 空(干净)

---

## 状态机(刚定下的,5 步)

```
SUBMITTED → CONFIRMED → DELIVERING → PENDING_CONFIRM → RECEIVED/COMPLETED
 已发起      接单         在途           送达             验收

action mapping:
  POST /api/orders                        → SUBMITTED
  PATCH /:id/confirm  (供应商接单)         → CONFIRMED
  PATCH /:id/ship     (供应商发货, 出仓)   → DELIVERING (在途, 不计时)
  PATCH /:id/deliver  (供应商送达, 司机到店)→ PENDING_CONFIRM (写 deliveredAt, 启动 24h 倒计时)
  PATCH /:id/receive  (店长验收)          → RECEIVED → COMPLETED
  
ProgressDots 标签统一: 已发起 / 接单 / 在途 / 送达 / 验收
STATUS_TO_STEP 右移 1: SUBMITTED=1, CONFIRMED=2, DELIVERING=3, PENDING_CONFIRM=4, RECEIVED=5
(意思: 当前状态 = 已完成步骤数, ProgressDots 显示 step < currentIndex 为 ✓)
```

---

## 报损流程(完整闭环)

```
店长收货时实收 < 应到 → 强制上传 ≥1 张图 → 自动建 LossClaim PENDING
                              ↓
                  供应商在订单详情看到 → 同意 / 拒绝
                              ↓
            ┌─ 同意/24h 自动 → APPROVED → schedule 扣账期
            └─ 拒绝(必填理由) → REJECTED → 总厨争议仲裁页
                              ↓
                       总厨判 finalDeductAmount → RESOLVED
```

**应到量 = shippedQty (供应商发货时议定的量)** —— 如果供应商在 ship 时已经调减(5→4.9),门店实收 4.9 = 不算报损(金额已按实发算清,没未付的钱)。只有实收 < 实发才走报损流程。

---

## 今天最后几个 fix(还没全测)

1. ✅ **24h 自动收货基准** 改为 `deliveredAt` (不是 `shippedAt`),没送达不会自动收货
2. ✅ **window.prompt/confirm/alert 全替换** 成 ConfirmSheet / state-driven modal(WebView 不弹 prompt)
3. ✅ **图片放大** 全用 state-driven lightbox(`<a target=_blank>` 在 WebView 不工作)
4. ✅ **报损单可点击进详情** + **报损证据图可全屏放大**
5. ✅ **chef hero 标签** 「本月食材消耗」→「本月食材入库」(receipt ≠ consumption)
6. ✅ **库存分类卡可展开** 显示该类下 SKU 列表
7. ✅ **历史订单 section** 加在采购页(之前没地方看完成单)
8. ✅ **修了「在途订单跟待处理订单重复」**, 供应商 home 只显示真需要动作的(SUBMITTED/CONFIRMED)
9. ✅ **同事的 PR 已合并**:CMB 招行集成 / Sentry / 短账号 tenant 智能识别 / 部署运维脚本
10. ✅ **GitHub 已同步**:最后 commit `a61a46c` (ProgressDots 5 段统一)

---

## 重大开放问题(用户在思考)

### A. 美团 POS 对接
- 已建议走「品牌商」路径(不是 ISV)— 用「南京捌拾捌号」公司主体申请
- 用户在等申请审核(2-3 周)
- Phase 1 兜底:Excel 导入(等用户给真实美团 Excel 样本)
- Phase 2:开放平台 API 拉数据
- 同事已在 docs/superpowers/plans/ 有美团 webhook 接入设计稿

### B. 菜品 BOM(食材 → 菜品配方)
- 用户认可方案,但还没启动开发
- Phase 1: Dish + DishRecipe 模型 + 手动录销量 + 自动扣库存
- 等用户拍板节奏

### C. 餐饮 OA 系统
- 用户决定走「**重度集成企微**」路线(不脱企微做 IM)
- 等用户拿企微自建应用 corpid + agentid + secret
- M1: 企微 SSO + 通讯录同步 + 工作台入口
- 详细架构在我之前回复里(15 个审批模板 / 排班 / 巡店 / 任务 / 客诉)

---

## CLAUDE.md 质量门禁(必看)

`/Users/somnusyi/Projects/dianjie-local/CLAUDE.md` 有 15 条规则,关键:
- 加链接 → 必须建对应 page.tsx(否则 404 + 401 踢登录连环 bug)
- 改 DB → 必须刷 cache(`invalidatePattern`)
- 改权限 → 多角色验证(供应商应 403)
- 改 schema → 验证 ECS 真同步(rsync 0 字节不报错)
- apiFetch 没 body 不要传 Content-Type
- 报价表 ≠ 库存(/api/products 不接受 stock)
- 部署后必跑 `node scripts/e2e-full-flow.js`(28 项,含 tenantSlug='test')
- 触发审批的回调要可逆(APPROVED 应用 + REJECTED 回滚)
- 危险操作 3 重确认
- 状态机必须画转换表 + 状态机覆盖测试

---

## 当前未做的小尾巴

1. **UI smoke 测试** 因 test tenant 路由问题暂未通过(login 页有 tenant 参数,但 ui-smoke.js 没传)
2. **CMB 微服务** 在 ECS 上没运行,所有付款 schedule 都会失败但 safe-fail(不会假装付款)
3. **OSS 上传链接 1h 过期** — 已有 `/api/upload/signed-url` 端点重新签,但前端图片渲染没整体接上
4. **HarmonyOS app** 1.0(11) iOS TestFlight 还在审核中(已 8 天?可能挂了)

---

## 用户偏好 / 性格特征

- **用中文回答**(已在 ~/.claude/.../MEMORY.md)
- 喜欢直接行动,不爱过度规划
- 真懂 PM 视角,经常用「顶尖产品视角」检验
- 对部署/数据细节敏感,发现问题会立刻指出(几次说"这数字哪来的")
- 不太懂技术细节(开关 git push 等需要解释)
- 截图反馈很多,经常需要快速 diagnose
- Auto mode 一直开着,期望"开干"而不是"问问题"
- 重视成本,不愿意投入巨大资源做不该做的(比如脱企微做 IM)

---

## 文件结构核心点

```
/Users/somnusyi/Projects/dianjie-local/
├── apps/api/              # Fastify + Prisma 后端
│   ├── src/routes/       # 30+ 路由文件
│   │   ├── auth.ts       # JWT 365d (用户主动登出才下线)
│   │   ├── orders.ts     # 状态机 + ship/deliver/receive
│   │   ├── lossClaims.ts # 报损 + manual review + resolve
│   │   ├── inventory.ts  # 门店库存 = sum(receipt) - sum(consume) - sum(loss), Math.max(0, ...) 兜底
│   │   ├── v2Dashboard.ts # 各角色 hero 数据 (KITCHEN_LEAD 已改"入库"标签)
│   │   ├── cmb.ts        # 同事的招行集成
│   │   └── financeReconcile.ts # 月度对账 (我加的)
│   └── src/services/scheduler.ts # 24h 自动收货 (用 deliveredAt!)
│
├── apps/web/              # Next.js 14 前端
│   └── src/app/v2/       # 6 角色 home + 各功能页
│       ├── login/        # tenant 智能识别 (短账号→test, 长手机→dianjie)
│       ├── supplier/     # 含 home / orders / orders/[id] / inventory / billing / 等
│       ├── chef/         # 厨师长 (KITCHEN_LEAD)
│       ├── chef-director/ # 总厨 (CHEF_DIRECTOR) - 含 disputes 仲裁页
│       ├── manager/      # 店长 (MANAGER)
│       ├── boss/         # 老板 (ADMIN)
│       └── finance/      # 财务 (FINANCE) - 含 reconcile 月度对账
│
├── packages/db/prisma/schema.prisma  # 30+ models, 含 PurchaseOrder.deliveredAt 等
└── scripts/
    ├── deploy-verify.sh  # 部署后必跑
    ├── e2e-full-flow.js  # 28 项 API 测试 (tenantSlug='test')
    └── ui-smoke.js       # 21 项 UI 测试 (login tenant 暂未修)
```

---

## 给下一个 Claude 的建议

1. **接手前**:看 GitHub `git log --oneline -20` 了解近期改动
2. **截图问题**:先 `grep -n` 找代码位置,直接查源 + DB 数据双向校验
3. **改完务必部署 + verify**:今天发现 N 次"代码改了 ECS 没生效",一定要跑 `bash scripts/deploy-verify.sh`
4. **WebView 兼容**:不用 `window.prompt/confirm/alert/open()`,统一用 ConfirmSheet 或 state-driven modal
5. **图片放大**:不用 `<a target=_blank>`,用 lightbox state pattern(已统一到 3 处)
6. **数据修改**:写脚本到 `apps/api/scripts/`,通过 ssh+node 执行(env 用 dotenv 加载 apps/api/.env)
7. **接手对话**:不要重复整理本文档内容,直接根据用户当前提问继续工作

---

**最后一次 commit**: `a61a46c` (ProgressDots 5 段统一)
**未 commit 的本地改动** (本次会话末了):
- 厨师长 hero 标签「入库」+ StockConsumption 真消耗值
- 厨师长 po-success 报损section 完整(明细 + 图 + 备注)+ 图片 lightbox
- 厨师长库存分类可展开 SKU
- 厨师长采购页加历史订单 section
- 供应商订单详情报损 section 增强 + 拒绝 modal + 图片 lightbox
- 供应商订单列表「报损」tab 卡片可点跳详情(LossClaim purchaseOrder.id 后端 select 加了)
- 总厨争议页图片 lightbox

**记得 commit + push** 这些改动!
