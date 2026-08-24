# Kimi 工作互查文档（2026-07-21 接手 → 2026-07-24）

> 用途：交给 Codex 交叉审查。本文档由 Kimi（生产运维+开发 AI）自述，所有结论均可通过 Git 历史、生产数据库、服务器文件验证。
> 仓库：/Users/somnusyi/Documents/Codex/dianjie-V4-rebuilt（GitHub: somnusyi/dianjie-V4，分支 main）
> 生产：ECS 116.62.32.162 /app/dianjie-v4，RDS PostgreSQL dianjie_v4
> 详细发布记录见仓库 DEPLOYMENT_RECORD_2026-07-21.md（本文是其索引+补充）

---

## 0. 工作方式声明（请审查是否被遵守）

- **历史单据冻结铁律**：receiptItems / stockConsumptions / lossClaimItems / inventorySnapshotItems / 采购单 / 配送单的历史行一律不改不删；数据修正只走「作废+补记」（voidedAt 软删）或主数据迁移。
- **生产数据修正一律 dry-run → 老板确认 → --apply**，脚本先上传跑 dry-run，输出给老板过目后才执行。
- 每次发布走 scripts/deploy-worktree.sh 标准流程（部署锁、祖先检查、备份、迁移、构建、健康检查），部署后核验 .deployed-commit 与 pm2 状态。

## 1. 功能开发与发布（main 分支，共 11 次发布）

| # | 提交 | 内容 | 测试 |
|---|---|---|---|
| 1 | 96c490b | 供应链加固移植 21 提交（来自 release/20260715-p0，按领域 cherry-pick 而非整分支合并）+ 财务月结历史月份选择器 | API 121/121、集成 65/65、Web 16/16 |
| 2 | 4aee090 | 会话续期修复：apiFetch 未识别「未授权，请先登录」导致 30 天 refresh 从未生效，用户每 2h 被踢 | Web 16/16 |
| 3 | d1904b0 | 门店食材消耗视图（厨师长每日消耗 Tab、店长食材成本卡）+ 营业页月份选择器改版；新增 3 个 /api/stores/:id/consumption 聚合接口 | 127/127、集成 76/76 |
| 4 | ebff897 | formatQuantity 数量可读化（g→kg 进位、千分位、去尾零） | — |
| 5 | dd6384f | 菜品分类 chips 固定快照修复 + BOM 变更生效默认改当天 | — |
| 6 | 9b2f339 | 企微待办通知第一批：账号申请→老板、日报缺 BOM→总厨（聚合）、盘点提交→厨师长+店长、日报缺传每日 11:00 提醒店长 | 136/136、集成 81/81 |
| 7 | 92b4db5 | 门店实时库存+盘点单数量统一 formatQuantity | — |
| 8 | 0889834 | DATA_QUALITY_TASK 企微通知事件（主数据待确认→总厨，聚合一条） | — |
| 9 | e8957d6 | **消耗冲销/补记机制**：stock_consumptions 加 voidedAt/voidedReason/voidedById/correctionOfId（迁移 20260722014111），所有读路径排除作废行，POST /api/consumption/:id/void（总厨/管理员，opLog 审计）+ 消耗×营业额双折线共振图（/api/consumption/daily-series + 店长营业页 SVG 图） | 142/142、集成 90/90 |
| 10 | 8efc887 | 供应商上新/涨价审批→总厨企微卡片（APPROVAL_PENDING）、降价→文本知会（PRICE_REDUCED，首次定价不打扰） | 145/145 |
| 11 | a6d64c9 | 登录页检测有效会话自动进工作台（不再每天停在继续/换号页；会话本身 30 天有效，2h access 自动续期） | — |

每次发布均有：部署前自动备份（/app/backups/*.dump + build tar.gz）、部署后 .deployed-commit 核验、三进程（api/web/cmb）online、/api/health 200。

## 2. 生产数据修正操作（重点互查对象）

### 2.1 异常消耗冲销（scripts/correct-anomalous-consumptions.ts --apply，2026-07-22 上午）
- 背景：老表 dish_recipes 多个 BOM 克数/单位错误，POS 日报导入按错误 BOM 扣减，7 月消耗成本虚高。
- 操作：28 行作废（voidedAt）+ 27 行按修正后数量补记（sourceType=correction，correctionOfId 关联）。
- 结果：7 月有效消耗成本 ¥36,383.57 → ¥19,929.78（净降 ¥16,453.79）。
- **请审查**：冲销行的选择规则（倍率异常阈值）、补记数量的依据、金额口径（unitCostSnapshot 快照价）。

### 2.2 鲜花饼三次修正（2026-07-22 下午）
- 配方依据：总厨 7-22 发布云南鲜花饼 BOM v2（1份=1枚，当天生效），v1 错误版（1441.09231枚/份）7-21 止效。
- correct-flower-cake.ts：7-21 错误行（4323.28枚/¥6905.05）冲销 + 按 3份×1枚 补记 ¥4.79；7-19 已作废行按 5份×1枚 补记 ¥7.99。
- correct-flower-0720.ts：7-20 漏网行（1441.09枚/¥2301.68）冲销 + 1份×1枚 补记 ¥1.60。
- 修正后：鲜花饼 7 月有效消耗 1473 枚 → 32.99 枚（¥52.69）；7 月有效总成本 ≈ ¥18,479。
- **遗留地雷（未处理）**：老表 dish_recipes 里「云南鲜花饼」1441.09231枚/份 的错误行可能仍在（新 DishBomVersion 已是 1枚，但若系统仍读老表则还会错扣）。**请审查哪张表实际生效，并评估清理方案。**

### 2.3 盘点差异分析与三柱对账（2026-07-23，纯只读分析）
- 瑶海 DJ001：7.13 基线滚动到 7.22 vs 实盘，136 个已匹配品项。
- 结论：账面 ¥33,373.74 vs 实盘 ¥27,627.86，净差 **-¥5,748.65**（实物<账面 103 项 -¥10,118 / 实物>账面 33 项 +¥4,370）。
- 根因三分：①入库记错档案（5 对重复档案）②BOM 错误（脆爽黄喉 1396g/份 应为 139.6g 多扣10倍；汤底调味粉 4.8倍/大米龙 2.4倍/白葱紫葱 1.9倍/腊火腿 1.5倍，克数系统性偏小）③鲜花饼去向漏记（9 天 338 枚，老板已确认是**赠品**，非盘亏）。
- 已排除：无外卖消耗；POS 日报每天正常导入。
- 产出：/Users/somnusyi/Documents/kimi/workspace/瑶海7.22盘点差异分析.xlsx（差异明细/未匹配与未覆盖/汇总/根因分析/三柱对账 5 sheet）。

### 2.4 五对重复商品档案合并（scripts/merge-duplicate-archives-0723.ts --apply，2026-07-23，dry-run 经老板确认后执行）
- 原则：只迁主数据（dish_recipes / dish_bom_items / store_inventory_policies）+ 停用重复档案（status=DISABLED、name+' [已并入]'、stock=0）；历史单据零改动；账面偏差由 7.22 盘点新基线一次归零。
- 明细：
  1. 胡萝卜汁三合一 → 存续「冷冻香橙胡萝卜汁 cmp2dylcq007bdjcn1vm2a4es（包）」：果汁包档案 cmp2dylef008rdjcniavcai11 配方 1袋→1包 迁移（**1袋=1包 为实盘互证推断，未经采购确认**）；g 档案 cmrocnofo002spapyven68x76 的 90g 配方行与袋档案重复，**删除**（否则一杯扣两次）。
  2. 清远鸡真空 cmp2dyl78001xdjcnmx51yafq（无配方）→ 停用并入盒装 cmpwjeqbd000w10o6wui0o0xy；**1箱≈13盒为四柱推算，未经采购确认**。
  3. 竹荪件 cmrlri26x008g133216dhvven（无配方）→ 停用并入竹荪g cmp2dyl5m000ddjcnj9r93n0o（1件=500g，spec 依据）。
  4. 羽衣甘蓝叶子 cmrocnoga003epapy2zh767h6 → 并入羽衣甘蓝汁 cmp2dyleh008tdjcn847umea7；**存续方库存单位 箱→袋**（1箱=100袋、1袋=150g，spec 已验证），账面 stock 49箱→4900袋，配方 15.5g→0.103333袋/杯。
- 合并后修复：两个存续档案（冷冻香橙胡萝卜汁、竹荪）合并前即为 DISABLED，已重新 ENABLED。
- 验证：停用档案主数据残留全 0；受影响菜品配方唯一；BOM 版本项同步。
- **请审查**：①换算系数可靠性（特别是两个「未经采购确认」的）②g 档案配方行删除是否误伤（该档案入库 0、消耗 3、无盘点行）③羽衣甘蓝 stock 字段直接 ×100 是否影响在读路径 ④被停用档案的历史单据（如清远鸡真空 23 行入库）今后报表口径。

### 2.5 企微通知类操作
- 2026-07-21：notify-chef-data-tasks.ts 推送缺 BOM 菜品 + 6 项主数据待办 → 总厨。
- 2026-07-24：notify-chef-confirm-0724.ts 推送「盘点差异根因 11 项确认单」→ 总厨（梁厨 LiangGuiZhou 已送达；黄瑞/生产测试总厨未绑企微未送达）。
- 供应商上新/调价通知已在 7-22 发布（第 10 次）。

## 3. 分支状态与 Codex 侧的关系

- Codex 夜间自动化产物在 release/20260715-p0（7/19~7/24，95 轮自审）；main 是生产分支。
- 7-21 第 1 次发布已把 release 的 21 个加固提交按领域移植到 main（非整分支合并）。
- 2026-07-24 Kimi 完成 release 全量审查：49 个 `+` 提交中 28 个已被 main 覆盖、13 个值得合（A 桶）、8 个有风险需先审计 web 调用方（C 桶）。
- **A 桶待 cherry-pick（未执行）**：916d4e0 移除登录页硬编码口令（**main 登录页至今有 admin@dianjie.com/admin123 三组口令，最高优先级**）、f589337 上传签名结构化租户校验（main 现仅 key.includes(tenantId) 子串判断）、080c927 PWA manifest/icon（main 引用的 icon-192.webp 不存在）、fc35f6c 移动端登录溢出、门店权限簇 9af381c→f8373ee→e265583→1825966、133105c/bbccc2d/f0af96d 并发剩余项、db0ba2d/ba801dd 小修。
- ⚠️ Codex 第九轮自审披露：HANDOFF.md / deploy-verify.sh 曾有明文生产凭证进入 Git 历史，**需轮换凭证**（DB 密码、企微 secret 等），仅删文件不够。

## 4. 悬而未决（等外部输入）

| 事项 | 等谁 |
|---|---|
| 梁厨确认单 11 项回复（黄喉克数、4 项克数复核、奇异果果茸/果酱去重、5 项主数据） | 梁厨（企微已送达） |
| 7.22 盘点导入为新基线（30 行缺换算清单在分析报告；鲜花饼差异按赠品标注；4 个实盘非零未匹配品项：米布丁1.2袋/腐乳酱7袋/生抽2桶/牛肉酱专用5袋） | 等梁厨回复后执行 |
| 清远鸡 1箱≈13盒、胡萝卜汁 1袋=1包 换算确认 | 采购 |
| 凭证轮换 | 老板 |
| Gitea 推送凭证 | 老板 |
| DJ002 新店：孟奥宇/周春华建号、实盘导入 | 老板/门店 |
| 张琪 FINANCE 角色审批 | 老板 |

## 5. 请 Codex 重点互查的问题

1. **消耗冲销读路径是否全覆盖**：voidedAt 排除是否漏了某个报表/聚合接口（营业页、财务月结、食材成本卡、每日-series 各自独立查询）。
2. **冲销+补记的金额口径**：补记行用 unitCostSnapshot（移动平均快照），与月结成本口径是否一致。
3. **老表 dish_recipes vs 新表 DishBomVersion 的实际生效优先级**：鲜花饼老表错误行是否还会被消费；整个系统何时完成切表。
4. **档案合并的换算系数**：两个「实盘互证/四柱推算」的系数找什么证据可以闭环。
5. **羽衣甘蓝 stock ×100**：Product.stock 字段的读写方有哪些，直接改值是否有副作用。
6. **A 桶 cherry-pick 顺序与冲突**：orders.ts/receipts.ts/products.ts 解冲突时应以 main 新语义为准，请复核计划。
7. **凭证轮换清单**：哪些凭证进过 Git 历史、轮换顺序（先 DB 后企微？）、轮换时的服务不中断方案。
8. **部署记录真实性**：抽查 DEPLOYMENT_RECORD 中声称的测试数与备份文件是否真实存在（服务器 /app/backups/）。

---

*本文档生成于 2026-07-24，对应 main 分支 f5a4192。*
