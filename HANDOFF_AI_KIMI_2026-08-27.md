# 滇界 V4 · 开发交接文档（2026-08-27）

> 交接人：Kimi AI（2026-08-18 至 2026-08-27 期间的全部工作）
> 基线：交接时 生产 = 本地 main = GitHub origin/main = `7da8bff`，三方一致
> 读者：接手开发的同事（人或 AI 均可）。读完本文 + `CLAUDE.md` 即可开工
> 历史交接：`HANDOFF_AI_ZCODE_2026-08-18.md`（上一任）、`AI_HANDOFF_CURRENT_2026-08-14.md`（原始交接）

---

## 一、系统是什么

滇界餐饮（云南菌汤火锅连锁）的内部供应链/门店经营系统。核心角色：

| 角色 | 干什么 |
|---|---|
| 门店（店长/厨师长 CHEF） | 下单订货、收货、日报、盘点 |
| 供应链（SUPPLY_CHAIN，张怡等） | 商品/分类/供货关系/定价、总仓库存、入库出库、单据审核、对账 |
| 会计（FINANCE） | 单据审核、付款、账务 |
| 供应商 | 外部供应商门户（接单发货），另有**上游供应商**（给总仓供货） |

当前重点：供应链出入库和账目的准确性。系统处于「影子账观察期」（SHADOW），库存正式切换 STRICT 的前置条件见 §7。

## 二、技术架构

```
apps/api        Fastify + TypeScript + Prisma（端口 4004）
apps/web        Next.js（standalone 部署，端口 3204）
packages/db     Prisma schema + client（@dianjie/db，workspace 包）
```

- 数据库：PostgreSQL。Prisma schema 在 `packages/db/prisma/schema.prisma`，迁移在 `prisma/migrations/`
- 部署：阿里云华东 `root@116.62.32.162`（公钥免密），pm2 三进程：`dianjie-v4-api`、`dianjie-v4-web`、`dianjie-v4-cmb`（招行对账）
- 服务器路径：`/app/dianjie-v4/`；`.env` 里有 `DATABASE_URL`、`JWT_SECRET`（**不要外泄到任何文档**）
- 业务时区固定 Asia/Shanghai（`apps/api/src/lib/businessTime.ts` 是唯一权威来源）

## 三、本地开发

```bash
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"   # 必须！本机默认 node 25 不符 engines

# 测试
cd apps/api && npx vitest run          # 1037 个单测（集成测试 *.integration.test.ts 需 DB，默认排除）
cd apps/web && npx vitest run          # 615 个测试

# 构建（部署前必跑，web 的 build 自带验证）
cd apps/api && npm run build           # tsc → dist/
cd apps/web && npm run build           # next build → .next/standalone + .next/static
```

## 四、部署流程（本任期间定型，跑过 6+ 次）

### 4.1 前端（全量）

```bash
cd apps/web && npm run build
COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/web_deploy.tgz -C .next/standalone .
COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/web_static.tgz -C .next/static .
scp /tmp/web_deploy.tgz /tmp/web_static.tgz root@116.62.32.162:/tmp/
ssh root@116.62.32.162 '
  rm -rf /tmp/web_deploy_new /tmp/web_static_new && mkdir -p /tmp/web_deploy_new /tmp/web_static_new
  tar -xzf /tmp/web_deploy.tgz -C /tmp/web_deploy_new && tar -xzf /tmp/web_static.tgz -C /tmp/web_static_new
  cd /app/dianjie-v4/apps/web && rm -rf node_modules apps package.json && cp -R /tmp/web_deploy_new/. .
  cd apps/web && rm -rf .next/static && mkdir -p .next/static && cp -R /tmp/web_static_new/. .next/static
  pm2 restart dianjie-v4-web --update-env'
# 验证：curl -o /dev/null -w "%{http_code}" http://127.0.0.1:3204/v2/supply-chain/inventory → 200
# 注意：根路径 / 返回 307 是正常的登录跳转，别当成故障
```

### 4.2 API（按文件热替换，不用整包）

```bash
cd apps/api && npm run build
scp dist/routes/xxx.js root@116.62.32.162:/app/dianjie-v4/apps/api/dist/routes/xxx.js
ssh root@116.62.32.162 'pm2 restart dianjie-v4-api --update-env && sleep 5 && curl -s http://127.0.0.1:4004/health'
# pm2 restart 后 API 启动约需 5-10s，立刻 curl 会 000，等一下再验
```

### 4.3 数据库变更（加表/加列时）

```bash
# 1. 改 packages/db/prisma/schema.prisma + 新建 migrations/<时间戳>_<名>/migration.sql
# 2. 服务器应用（注意：20260824000000_warehouse_docs 当时没走 migrate deploy，_prisma_migrations 有缺口，
#    所以目前用"手工执行 SQL + prisma generate"的方式，别用 migrate deploy 会炸）
scp packages/db/prisma/schema.prisma root@116.62.32.162:/app/dianjie-v4/packages/db/prisma/
scp <migration>.sql root@116.62.32.162:/tmp/ && ssh root@116.62.32.162 '
  export DATABASE_URL=$(pm2 env 2 | grep "^DATABASE_URL:" | sed "s/^DATABASE_URL: //" | cut -d"?" -f1)
  psql "$DATABASE_URL" -f /tmp/<migration>.sql
  cd /app/dianjie-v4/packages/db && npx prisma generate
  pm2 restart dianjie-v4-api --update-env'
```

### 4.4 服务器查库

```bash
ssh root@116.62.32.162
export DATABASE_URL=$(pm2 env 2 | grep "^DATABASE_URL:" | sed "s/^DATABASE_URL: //" | cut -d"?" -f1)
psql "$DATABASE_URL" -c "SELECT ..."
# 表名小写下划线（products/stores/warehouse_docs），列名 camelCase 需双引号："unitConversionStatus"
```

### 4.5 服务器实测 API（临时 JWT，2h 有效）

```bash
scp dianjie-imports/sign_jwt.js root@116.62.32.162:/tmp/   # 脚本在工作区仓库外，找不到就从 git 历史捞
ssh root@116.62.32.162 'cp /tmp/sign_jwt.js /app/dianjie-v4/apps/api/sign_jwt_tmp.js
  cd /app/dianjie-v4/apps/api && node sign_jwt_tmp.js && rm sign_jwt_tmp.js
  TOKEN=$(cat /tmp/v4jwt.txt) && curl -s http://127.0.0.1:4004/api/xxx -H "Authorization: Bearer $TOKEN"'
# 身份 SUPPLY_CHAIN；必须在 apps/api 目录跑（/tmp 下找不到 fast-jwt 模块）
```

## 五、本任期间（8.18-8.27）完成的工作

### 5.1 价格/单位体系修复（8.18 凌晨，紧急）

- **价格换算全线修复**：商品建档时"箱/150g*100"这类规格的换算错（应为 ¥217.60/包）。根因：规格解析与四单位合同不一致。修完后全品类复查
- 商品表单单位区简化为两问式 + 规格自动解析换算（`d1480de`）
- 商品页分类栏按 sortOrder 排序（`3717408`）
- 修两个 hotfix：活动门店注入钩子同步函数挂起请求链（`4249b07`）、改路由白名单（`02391fc`）

### 5.2 供应链结构化（P1/P2/P3，8.18-8.23）

- **P1 供货关系总表**（`4ae73d1`）：商品↔供应商关系页 `/v2/supply-chain/relations`，供应商维度批量绑定；新建商品页可直接绑供货关系；供应商新建时可绑定供货商品
- **P2 入库结构化**（`1e3ed93`）：台账挂供应商 + 别名认领 + 入库记录中心 `/v2/supply-chain/inbound`
- **比例加价定价**（`ab47e38`）：按总仓库存移动均价 ×(1+分类比例) 自动定卖价，`pricingMode=MARKUP`，比例可按分类设置——解决菌菇时价入库一次就要核对一次价格的问题
- **单据审核流**（`287e170`）：入库单/出库单（warehouse_docs）会计审核、反审核、改单留痕；入库行金额可编辑凑整（总金额反算单价）；单据审核页 `/v2/supply-chain/docs`
- **批量手工出库**（`d82219c`）：订单外总仓出库（拨补/报损/历史补录）

### 5.3 仓库数据补录（8.23-8.27，均经负责人确认）

- 以 **8.21 实盘库存**为库存基准（实盘表已导入）
- 补录出库：8.21、8.22、8.23（CK20260823-001）、8.24（CK20260824-001，148 行 ¥134,708.66）、8.25（CK20260825-001，121 行 ¥80,054.78）；每次补录前重新验库存缺口，挡下的品项列入阻断清单
- 焖饭汁等老档迁移按当时确认执行

### 5.4 8.27 一天的一批交互/效率改进（全部已上线）

| 提交 | 内容 |
|---|---|
| `b33d73b` | 入库供应商选择器改可搜索（编号/名称模糊匹配，回车选第一项） |
| `79cbc5d` | 库存页「单位待核验」加一键核验按钮（修掉 INFERRED 商品永远进不了入库的死路）；同时把 69 个 1:1 同单位商品批量置为 VERIFIED |
| `4bbe7ee` | 批量入库改勾选面板（分类分组/全选/多选一次添加）+ 行内键盘 ↑↓←→/Enter 跳格 + 全站数字框去步进箭头 |
| `298ae89` | **配送班表**：`/v2/supply-chain/delivery-rules`，线路/每周送货日/到货期/订货时段/适用门店/强制开关 + 月历视图；门店下单页自动预填最快到货日；enforce=true 时下单接口硬拦截 |
| `7da8bff` | 修复 287e170 引入的 5 个 API 测试失败（mock 缺 product.findFirst/aggregate/warehouseDocLine/ensureWarehouseDoc） |

### 5.5 打印修复（8.27 早些时候）

- `78f42b2` 送货单 PDF 切点按行对齐 + 页码；`69ddb1f` 系统打印改手工分页（14/20 行）+ 打印宽度自适应——根治分页丢行漏货。无头 Edge 实测 38 行=3 页无丢行

## 六、当前系统状态（2026-08-27 晚）

- 生产三进程 online，`/health` ok；API 1037/1037、Web 615/615 测试全绿
- 商品：495 个启用商品四单位换算全部 VERIFIED
- 库存：8.21 实盘基准 + 补录到 8.25 出库；**8.24/8.25 采购入库未补**（等采购文件，约 ¥12.5万+¥6.6万）
- 配送班表：功能上线但 **0 条规则**——供应链自己配；不配不影响任何下单

## 七、悬而未决（按优先级）

1. **8.24/8.25 采购入库补录**：等负责人给采购文件。注意清远鸡 8.24 美团入库 37 箱 ¥15,540 + 8.25 6 箱 ¥2,520 在 V4 无记录，已请仓库核实；入完后我还欠 57 箱出库（¥23,940）要补
2. **DISABLED 阻断品项处置**（出库验库存时挡下）：黑豆花（两天 ¥519）/包浆豆腐（¥360）/鸡翅木筷子（¥300）/小票纸（¥140）/光明冰淇淋（¥50）；嘴碗换算 INFERRED 待确认；酸角汁箱→瓶缺换算
3. **缺货耗品**：农夫山泉（双档）/玻璃杯/深碗/手工缸/四件套/电子秤/调和油
4. **等确认老问题**：见手青啤酒 40 箱 ¥6,440、保拉纳白 -1 箱
5. **代码债**：出库互斥闸口未覆盖 WarehouseManualOutbound/WarehouseBatchManualInbound 手工补录通道（双扣风险理论上存在，补录时靠人工验库存兜底）
6. **库位功能**（负责人已提需求，等编码规则确认）：商品加 location 字段，送货单按库位排序方便分拣。方案已定：products 加 varchar(32) 字段 + 商品表单/列表维护 + 送货单按库位排序空值高亮
7. 打印手工分页若实物验证 OK，可推广到拣货单/盘点单

## 八、常见坑（血泪教训）

1. **截图行动前必须文字确认**——上一任两次误读截图做了错误改造又回滚
2. **时区**：DB timestamp 无时区存 UTC 墙钟；北京时间过滤写 `'2026-08-23 16:00'` 这种偏移量；单号月份必须走 `businessTime.ts`
3. **出库双轨**：美团包出库行按 商品×对方门店 拆分，自动跳过已切 V4 的门店行，别乱动这段逻辑
4. **四单位合同**：采购/库存/订货/成本四单位 + `unitConversionStatus`（PENDING→INFERRED→VERIFIED）；入库候选只放 VERIFIED；PATCH 单传 `unitConversionStatus:'VERIFIED'` 即可核验（UNIT_ALLOW 白名单内）
5. **打印分页**：永远按行边界切，切点落在行中间 = 拣货漏货
6. **幂等**：所有写操作有 idempotencyKey；补录历史数据用批量端点而不是逐条
7. **SSH 到服务器跑 psql 时**，SQL 里的单引号会被多层 shell 吃掉——写 .sql 文件 scp 上去再 `psql -f`

## 九、开工速查

```bash
# 拉代码
git clone git@github.com:somnusyi/dianjie-V4.git
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
# 看一眼导航结构就知道页面在哪
ls apps/web/src/app/v2/supply-chain/
ls apps/api/src/routes/
```

供应链端页面 ↔ API 路由对照：`inventory→warehouseInventory.ts`、`inbound→warehouseInventory.ts(/inbound-records)`、`docs→warehouseDocs.ts`、`relations→productUpstreamSources.ts`、`delivery-rules→deliveryRules.ts`、`products→products.ts`。
