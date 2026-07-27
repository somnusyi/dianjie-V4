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

## 第 10 次：供应商上新/调价企微通知总厨（8efc887，2026-07-22 下午发布）
- 新增 APPROVAL_PENDING（新品上架/涨价审批单 → 总厨卡片，直达审批页）与 PRICE_REDUCED（降价直接生效 → 文本知会总厨，首次定价不打扰）
- 触发点：products.ts 创建（供应商）、涨价审批分支、最终更新降价路径；测试 145/145 + tsc 通过
- 部署 DEPLOY_EXIT_CODE=0，.deployed-commit=8efc887…，pm2 全部 online

## 第 11 次：登录页有效会话自动进入（a6d64c9，2026-07-23 上午发布）
- 问题：非企微浏览器打开系统时，登录页每天都停在「检测到已有登录·继续/换号」选择页（会话本身 30 天有效，并非过期）
- 改动：检测到本地会话后先静默校验（/api/auth/me，含 2h access 自动续期），有效则直接进角色工作台；仅校验失败（撤销/停用/超 30 天）才落回继续/换号页
- 部署 DEPLOY_EXIT_CODE=0，.deployed-commit=a6d64c9…，pm2 全部 online

## 生产修正（2026-07-23 下午）：5 对重复商品档案合并
- 背景：瑶海 7.22 盘点差异分析定位「入库记错档案」——同一物料存在 2~3 个档案，入库/消耗分散，账面失真
- 脚本：apps/api/scripts/merge-duplicate-archives-0723.ts --apply（dry-run 经老板确认后执行）
- 原则：历史单据（入库/消耗/报损/盘点/采购/配送）一律冻结不动；只迁移主数据（dish_recipes、dish_bom_items、store_inventory_policies）+ 停用重复档案；账面偏差由 7.22 盘点新基线一次归零
- 合并明细：
  1. 胡萝卜汁三合一 → 存续「冷冻香橙胡萝卜汁（包）」：果汁包档案配方 1袋→1包 迁移；g 档案 90g 配方行与袋档案重复，删除（避免一杯扣两次）
  2. 清远鸡真空包装（无配方）→ 停用并入「清远鸡盒装」；1箱≈13盒换算待采购确认
  3. 竹荪件档案（无配方）→ 停用并入「竹荪（g）」（1件=500g spec）
  4. 羽衣甘蓝叶子 → 并入「羽衣甘蓝汁（果汁包）」；存续方库存单位 箱→袋（1箱=100袋、1袋=150g），账面 stock 49箱→4900袋，配方 15.5g→0.103333袋/杯
- 收尾修复：两个存续档案（冷冻香橙胡萝卜汁、竹荪）合并前即为 DISABLED 状态，已重新 ENABLED
- 验证：停用档案主数据残留全 0；受影响菜品配方唯一（超A醒目胡萝卜橙 1包、轻颜羽衣甘蓝 0.103333袋）；BOM 版本项同步

## 第 12 次：反馈系统 P0（20192881，2026-07-26 下午发布）
- 功能：App 内反馈入口（全局悬浮按钮+自动上下文快照+图片附件）→ Qwen(qwen3.8-max-preview) App 内多轮澄清对话 → 三类分诊（BUG_BLOCKING 紧急企微通报 / IMPROVEMENT+NEW_FEATURE 待审推送 / QUESTION 直接答闭环）→ 超管+老板手机审批中心 /v2/boss/feedback（批准/驳回+理由+OpLog+消息中心）
- 新增：Feedback/FeedbackMessage 模型（迁移 20260726131036_feedback_system，只增不改）；FEEDBACK_APPROVAL_PENDING/FEEDBACK_URGENT_BUG 企微事件；上传白名单加 feedback；routes/feedback.ts 6 端点（限流 10/hour + 30/5min）
- 配套：魏（17328852591）升级 SUPER_ADMIN 并绑定企微 ZuoYouDeZuo（从 592 供应商账号解绑迁移）；生产 .env 写入 QWEN_*（chmod 600，Key 不进 git）
- 热修：qwen3.8-max-preview 强制思考模式、真实 prompt 首响 30~60s，qwenChat 超时 30s→90s（env QWEN_TIMEOUT_MS 可调），否则稳定撞线兜底
- 测试：单测 172/172（新增 27）、集成 5/5、双端 tsc+build；生产真实 Qwen 冒烟通过（33.4s 首响，IMPROVEMENT 分诊+解析正确）
- 部署：分段执行标准流程（300s 限制），DEPLOY 备份 dianjie_v4-deploy-bak-20260726-1345-20192881.dump，md5 一致、api/cmb/web 健康、.deployed-commit=201928815de8…
- 注：notify-chef-data-tasks.ts 早于 92bdf2b 已入库，本次部署未受影响

## 第 13 次附记：域名与证书现状定案（2026-07-27 上午，Kimi 执行）
- **正式入口定案：`https://www.njdianjie.com`**（企微 OAuth 跳转 WECOM_REDIRECT_BASE、企微通知卡片链接均指向它；反代 v4 web 3204 + api 4004）
- njdianjie.com 资质：ICP 备案 2026-05-22 通过 + 公安备案（江苏公网安备 32010202012330号）；证书 Let's Encrypt（certbot 管理，webroot /var/www/letsencrypt 自动续期，当前到 2026-08-13）
- **dianjie.cc 系列（app/api/www/主域）冷处理**：同一套 v4 的备用入口，无 ICP 备案（80 端口被阿里云 ICP 拦截劫持，443 暂通），日常无人使用；不再投入维护、不出现在对外物料
- dianjie.cc 证书事故处置：DigiCert 四张证书 2026-07-21 过期（6 天无人察觉，佐证无人使用）；因 ICP 拦截走不了 HTTP-01，改用 acme.sh TLS-ALPN-01（停 nginx ~20s）签发 LE ECC SAN 证书（覆盖四域，2026-07-27→10-25），nginx 四对 server 块统一指向 /etc/ssl/dianjie/le/；自动续期=acme.sh cron + pre-hook 停 nginx + ReloadCmd 兜底拉起，全链路实测通过；旧证书与 nginx 配置备份 /root/cert-backup-20260727-094437
- 残留依赖清理：生产 .env/pm2 零引用；CORS 白名单保留兼容；部署/回滚/冒烟脚本健康检查 app.dianjie.cc → www.njdianjie.com（33bfeebe）
- 代码外待人工确认：① CMB 招行商户后台支付回调地址配的域名（如为 dianjie.cc 需改）；② 企微后台可信域名/应用主页核对
- 风险备忘：未备案域名（dianjie.cc）443 存在被阿里云 SNI 阻断扩大的政策风险，只当备用不依赖
- acme.sh 装于 /root/.acme.sh（Gitee 镜像安装），cron 每日 15:38 检查；nginx 80 块已加 /.well-known/acme-challenge/ 直通 location（备案若补齐可回切 HTTP-01）

## 第 14 次：反馈自动修复点火测试全链路打通（10de6f93，2026-07-27 中午）
- 点火用例：e2d1221b 在消息中心「全部已读」按钮埋入错别字「全部已渎」；模拟李欢提交反馈，Qwen 分诊 IMPROVEMENT，超管批准后自动入队
- 最终结果：AutoFixRun `cms2qefvk0007yrsll166z9bq` → RESOLVED；AI 自动提交 `10de6f935f1b86e5f25db69a27b8c140d62a7edb`（1 文件 2 行）；生产健康检查 api=200、page=200；反馈自动 RESOLVED 并通知提报人
- 过程中补齐 4 个管线短板：c8f29e99 校正 AI diff hunk 行数并在生成阶段试应用；c94043af 隔离验证固定 NODE_ENV=test；80649051 node_modules 链接延后到候选提交干净校验之后；89897ccf Web 重启不再 --update-env，避免 API PORT=4004 污染 Web 3204
- 收尾：/app/dianjie-src 与生产 .deployed-commit 均为 `10de6f935f1b86e5f25db69a27b8c140d62a7edb`；该修复已同步 GitHub main（本记录提交后 main 为 2268c14d）；dianjie-v4-api / dianjie-v4-web online，`/v2/notifications` 200

## 第 15 次：反馈附件过期打不开修复（4f3c691d，2026-07-27 下午）
- 问题：反馈详情里历史截图打开报 OSS `AccessDenied / Request has expired`——上传时存的是 1 小时临时签名 URL，反馈模块读取时未像 lossClaims/orders/invoices 一样重签
- 改动：routes/feedback.ts 管理端列表 `/admin/inbox` 与详情 `/:id` 返回前统一 `resignOssUrls()`；不改上传逻辑、不迁移数据库，旧附件读取时动态重签即可恢复
- 验证：双端 tsc 通过、feedbackTriage 19/19；生产用两条已过期反馈（cms2o6jke…「分类管理移至最左侧」、cms2o1e7z…「修改分类支持其他类目」）实测：API 返回新签名 URL（Expires=当前+3600s），图片 GET 200 image/png
- 部署：git bundle（main ^10de6f93）→ /app/dianjie-src reset --hard 4f3c691d，rsync api/dist，仅重启 dianjie-v4-api（未动 Web），.deployed-commit=4f3c691ddf7f…；health db=ok、/v2/login 200
- 注意：已打开的旧反馈页面需刷新一次才能拿到新 URL；长期可考虑反馈附件改存 OSS key 再 signOssKey，本次不动数据结构

## 第 16 次：自动修复第二单真实跑通（caec9f4f，2026-07-27 下午）
- 反馈：张怡「商品管理默认只显示供应中」（cms2pb3x7…），超管 04:52 批准 → AutoFixRun cms2r3ote… 全程约 12 分钟：PATCHING→DEPLOYING→RESOLVED，无人工介入
- AI 修复内容：供应链商品页 filters 默认值与 clearFilters 均加 `status: 'ENABLED'`（products/page.tsx 2 行），提交 caec9f4f 已部署生产，.deployed-commit 一致，api/web 健康
- 闭环：反馈自动 RESOLVED 并通知提报人
- 发现短板：AutoFix 引擎只提交到服务器本地 main，不会自动推 GitHub——本次已手动 merge 同步（41960476）；后续每单自动修复后都需回同步，或给引擎加 push 步骤

## 第 17 次：自动修复门槛文案校正 + GitHub 自动同步（7cf4084a，2026-07-27 下午）
- 背景：「修改分类支持其他类目」批准后 ESCALATED，报错笼统写「置信度门槛 (0.80)」——实际置信度 0.80 达标，真正拦截原因是 inWhitelist=false（需后端分类持久化，AI 判断正确）；张怡反馈线程已手动补发转人工说明
- 改动：engine.ts 白名单拒绝与置信度不足分开报错，白名单拒绝时自动在反馈对话留言说明；deployment.ts 部署/回滚成功后 git push 服务器 main 回 GitHub（仅快进，分叉记 OpLog 待人工对齐，绝不影响部署；默认 remote=git@github-dianjie 别名，env AUTO_FIX_GIT_REMOTE 可覆盖）
- 待办（老板 30 秒操作）：GitHub 仓库 Settings → Deploy keys，把 server-deploy@dianjie 公钥（/root/.ssh/dianjie_github_deploy.pub，ed25519 ...Ce80Y）删了重加并勾选 Allow write access——当前只读，push 会失败但仅记日志不伤部署；服务器走 HTTPS 推 GitHub 不通（HTTP2 被拦），SSH 22 端口正常
- 部署：bundle（main ^caec9f4f）→ reset --hard 7cf4084a，rsync api/dist，仅重启 API，.deployed-commit=7cf4084a…，三方（GitHub/服务器源/生产基线）对齐，health db=ok、web=200
