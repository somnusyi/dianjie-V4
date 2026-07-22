# 滇界 V4 发布记录：供应链加固整合 + 财务月结历史月份选择器

> 发布时间：2026-07-21 10:47（Asia/Shanghai）
> 发布提交：`96c490b0654e7ef14053be8d276c5709f08af477`（main）
> 上一生产提交：`0fabd1f4ecbfdada0fae829be4cd011489604583`
> 执行方式：`scripts/deploy-worktree.sh` 标准流程（部署锁、祖先检查、备份、迁移、构建、健康检查全部通过）

## 1. 本次发布内容

### 供应链加固移植（21 个提交，来源 release/20260715-p0）

按领域分五组移植到最新 main，未整分支覆盖：

| 组 | 内容 |
|---|---|
| 输入边界 | 商品价格/库存数值上限、订货数量金额上限、收货/配送/报损载荷校验（Prisma Decimal） |
| 分类并发 | 分类导入、排序、单商品归类的咨询锁串行化 |
| 收货状态机 | 拒收/作废状态抢占串行化；供应商入库批次编号并发 |
| 配送审计 | 发货/送达 opLog 入事务（日志失败业务事实整体回滚）、厨师验收与配送并发、发货重放 409 |
| 订货幂等 | 创建/改单同键同内容幂等、同键不同内容 409、并发创建可恢复 |
| 构建 | API 命令前置自动 regenerate Prisma 客户端（8 个 pre-hook） |

### 财务月结历史月份选择器（1 个提交 b0d6dd4 + 合并提交）

- 新增 `GET /api/profit/store/:storeId/closed-months`（仅 CONFIRMED 月结，倒序）
- 店长「营业 → 上月」可按月切换 4–6 月及以后任意已月结月份
- 不改变「月结不倒灌日报/实时营业额」边界

## 2. 发布前验证

- 生产备份副本（2026-07-21 10:29 导出）：62 条迁移全部在账、无 pending；整合后 schema 零漂移
- API 单元 121/121；PostgreSQL 集成 65/65；Web 16/16；API/Web tsc 通过
- 8 个专项 E2E（订货/配送/收货/报损/批次并发/分类并发）全绿
- 合并后 main 复测：API 121/121、Web tsc 通过

## 3. 发布过程要点

- 部署 worktree：`~/Desktop/dianjie-V4/dianjie-V4-deploy`
- 部署前自动备份：`/app/backups/dianjie_v4-deploy-bak-20260721-104707-96c490b.dump` 与同名 build tar.gz（回滚用）
- ECS migrate deploy：无 pending（迁移账本 62 条不变）
- warn-only 提示：ECS `.env` 缺 ALLOW_DEMO_SEED / MEITUAN_* 等 8 个 key，均属未启用功能（演示种子、美团），不阻断

## 4. 发布后核验（2026-07-21 10:51）

- `.deployed-commit` = `96c490b0654e7ef14053be8d276c5709f08af477` ✅
- `dianjie-v4-api` / `dianjie-v4-web` / `dianjie-v4-cmb` 全部 online ✅
- 迁移账本 62 条 ✅；API 近期日志 0 条 error ✅
- 外部访问 `/api/health` 200（db ok）、`/v2/login` 200 ✅
- GitHub `main` 已同步至 `96c490b`；Gitea 同步待凭证

## 5. 后续待办（不变）

- DJ002：账号创建绑定 → 初始盘点（模板已生成）→ 安全库存 → 小额采购跑通 → 首份日报
- 总厨按《INFERRED单位换算人工确认优先级_2026-07-21.xlsx》从高到低确认 274 个换算
- 在线盘点生产 UAT；连续 7 天日报对账；美团接入；Sentry/CI

## 6. 追加发布：会话续期修复（2026-07-21 13:20）

- 提交：`4aee0907b87397e74c255f848c10f97cd8d7e89e`（fix/auth-refresh-401-message 合入 main）
- 修复：apiFetch 过期判断未覆盖「未授权，请先登录」导致 30d refresh 从未生效（用户每 2h 被踢回登录）；旧 axios 封装 refresh 地址兜底 localhost:4000 改默认同源
- 验证：Web tsc + 16/16 单测；标准部署全部通过；`.deployed-commit` 已更新，三进程 online，`/v2/login` 200
- 该 bug 自初始导入即存在，与当日供应链加固发布无关

## 7. 追加发布：门店食材消耗视图 + 月份选择器改版（2026-07-21 14:50）

- 提交：`d1904b031843cf4aa408f13071bbf54ae6ac8a11`（feature/store-consumption-view 合入 main）
- 内容：① 营业页月份选择器改单行横滑（单选中态，月结月份绿点）② 厨师长库存页新增「每日消耗」Tab（日消耗/7日环比/菜品明细）③ 营业页新增「食材成本」卡（消耗金额/成本率/Top5）④ 新增 /api/stores/:id/consumption 三个聚合接口（门店角色限定）
- 验证：API 单测 127/127、集成 76/76、Web tsc + 16/16、干净 worktree 构建；生产备份核验 7-16~19 消耗成本快照金额正常；部署后 .deployed-commit 已更新、三进程 online、新接口 401（鉴权前置正常）

## 8. 追加发布：消耗数量可读化（2026-07-21 15:10）

- 提交：`ebff8973fca5cc4f3d38b93e7cb6e413d98fb033`
- 内容：新增 formatQuantity（g→kg/ml→L 进位、千分位、按量级保留 0–4 位小数），接入厨师长每日消耗视图与店长食材成本卡
- 另查明：云南鲜花饼 BOM 数据错误（1 份=1441.092310 枚，7-19 卖 5 份扣 7,205 枚 ¥11,508），致 7 月食材成本高估约 31.6%、鲜花饼预估库存异常；需总厨修正 BOM 后发布新版本，库存以下次盘点重建基准（历史消耗按规则不倒改）

## 9. 追加发布：菜品分类筛选 + BOM 默认生效当天（2026-07-21 15:35）

- 提交：`dd6384f`（fix/dish-category-and-bom-default 合入 main）
- 修复①：菜品/配方页分类 chips 原从已过滤列表推导，点一次分类后其余分类消失且布局左移导致误点；改为「全部」快照固定，状态切换时重置分类
- 修复②：BOM 变更生效日期默认由明天改为当天（可手改）
- 数据审计：431 行已发布 BOM 全量扫描，唯一硬伤为云南鲜花饼（1441 枚/份）；29 行使用 INFERRED 换算食材（已在 INFERRED 清单中）；详见 BOM合理性审计_2026-07-21.xlsx

## 10. 追加发布：企微待办通知第一批（2026-07-21 16:15）

- 提交：`9b2f339`（feature/wecom-todo-notifications 合入 main，实现提交 426dc70）
- 新事件：USER_APPLICATION_PENDING（账号申请→老板/管理员）、BOM_TASK_PENDING（日报缺BOM→总厨，聚合一条）、COUNT_PENDING_CONFIRM（盘点提交→厨师长+店长）；到货差异仲裁经核查已由 LOSS_REJECTED 覆盖不重复加
- 定时任务：DAILY_REPORT_MISSING 每日 11:00–11:05（Asia/Shanghai）检查前一营业日日报，未确认提醒店长；每店每天一条持久去重；未开业/从未传过日报的店不提醒
- 测试：API 单测 136/136（新增 9）、集成 81/81（新增 5）

## 第 7 次：库存数量格式化（92b4db5）
- 内容：门店实时预估库存 + 盘点单账面/实盘数量统一 formatQuantity 可读化（自动 kg 进位、去尾零）
- 部署：DEPLOY_EXIT_CODE=0，.deployed-commit=92b4db552e43…，pm2 全部 online

## 第 8 次：数据质量待办通知事件（690d63d）
- 内容：新增 DATA_QUALITY_TASK 企微通知事件（主数据/规格待确认 → 总厨，聚合成一条卡片）；附一次性触发脚本 scripts/notify-chef-data-tasks.ts
- 部署：DEPLOY_EXIT_CODE=0，.deployed-commit=690d63d9dd3c…，pm2 全部 online

## 第 9 次：消耗冲销/补记机制 + 消耗×营业额共振折线图（e8957d6，2026-07-22 上午发布）
- 机制：stock_consumptions 增加 voidedAt/voidedReason/voidedById/correctionOfId（迁移 20260722014111）；所有读路径排除作废行；新增 POST /api/consumption/:id/void（总厨/管理员，冲销+可选补记，opLog 审计）
- 图表：GET /api/consumption/daily-series + 店长营业页「食材成本」卡下新增 SVG 双折线（营业额/食材成本）+ 成本率虚线右轴，点按看当日明细
- 生产修正：scripts/correct-anomalous-consumptions.ts --apply 执行，28 行作废 + 27 行补记；7 月有效消耗成本 ¥36,383.57 → ¥19,929.78（净降 ¥16,453.79）；鲜花饼行仅冲销，待总厨确认配方后补记
- 测试：单元 142/142、集成 90/90，两端 tsc 通过；部署 DEPLOY_EXIT_CODE=0，.deployed-commit=e8957d674e92…，pm2 全部 online

## 生产修正（2026-07-22 下午）：鲜花饼 7-21 错误行 + 配方闭环
- 总厨 7-22 发布云南鲜花饼 BOM v2（1份=1枚，当天生效），v1 错误版已于 7-21 止效
- scripts/correct-flower-cake.ts --apply：7-21 错误行（4323.28枚/¥6905.05）冲销+按 3份×1枚 补记 ¥4.79；7-19 已作废行按 5份×1枚 补记 ¥7.99
- 修正后 7-21 消耗 ¥842.66（成本率 19.6%），7 月有效消耗 ¥20,779.42
- 总厨确认单进度：鲜花饼配方✓、虎掌菌 BOM✓；百家蘸料/打包盒 BOM 与 6 项主数据仍待处理

## 生产修正（2026-07-22 下午·补）：鲜花饼 7-20 漏网错误行
- scripts/correct-flower-0720.ts --apply：7-20 错误行（1441.09枚/¥2301.68）冲销 + 按 1份×1枚 补记 ¥1.60
- 鲜花饼 7 月有效消耗：1473 枚 → 32.99 枚（¥52.69）；7-20 日消耗 → ¥1,574.37；7 月有效总成本 ≈ ¥18,479
