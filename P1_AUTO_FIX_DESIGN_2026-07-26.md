# P1 设计：AI 自动修复流水线 + 红线清单

> 2026-07-26 · 状态：待老板拍板
> 前置事实：反馈系统 P0 已上线（Qwen 分诊 BUG_BLOCKING → 企微紧急卡 → 超管审批中心 → resolve 闭环）。
> 7/26 演练证明「反馈→分诊→通知→修复→部署→闭环」链路只剩「修复」一环是人工（Kimi 手动扮演）。

---

## 1. 目标

员工提交阻断性反馈后，**无需等人类开发者在线**，系统由 AI 自动完成：

```
反馈(BUG_BLOCKING) → AI 定位 → AI 出补丁 → 自动验证 → 自动部署 → 生产健康检查
→ 企微通报(含一键回滚) → 反馈自动闭环+通知提报人
```

非目标：新功能开发（仍走 AWAITING_APPROVAL → 老板拍板 → 人类/多 AI 排期开发）。

## 2. 触发范围（什么能进自动修复）

| 进入条件 | 说明 |
|---|---|
| category = BUG_BLOCKING | Qwen 分诊为阻断性故障 |
| context.path 可定位到具体页面 | 无页面线索的直接转人工 |
| AI 分析结论：改动落在白名单区域 | 见红线清单 |
| diff ≤ 5 个文件 且 ≤ 200 行 | 超过转人工 |

任何一条不满足 → 状态 ESCALATED，企微通知超管附 AI 分析，走人工。

## 3. 红线清单（AI 永远不许碰）

**硬红线（触碰即拒绝并报警）：**

1. `.env*`、任何凭证/密钥文件
2. `prisma/schema.prisma`、`prisma/migrations/**` —— 禁止任何数据库结构变更；AI 只允许 SELECT，禁止一切写 SQL
3. 认证与权限：`auth*.ts`、`authTokens.ts`、`auth-scope.ts`、JWT 签发/校验、登录/刷新路由、RBAC 判断
4. 资金链路：`payments / finance / cashbook / reconciliations / approval` 相关路由与金额计算
5. 库存核心事务：库存扣减/入库确认的跨表事务代码（`inventory` 写路径、`receipts` 确认逻辑）
6. 依赖与构建：`package.json`、`pnpm-lock.yaml`、任何依赖增删改
7. 运维面：pm2 / nginx / 部署脚本 / `scripts/deploy-*`
8. 破坏性操作：删除文件、`git push --force`、历史改写、删数据
9. 通知路由逻辑本身（防止 AI 把自己的报警通道改坏）

**白名单（允许自动改）：**

- `apps/web/src/app/**` 页面层：文案、链接、样式、空值兜底、格式化显示、组件属性错误
- `apps/web/src/components/**` 展示组件（不动 AppLayout 的权限判断段）
- API 仅 **只读型 GET** 路由的输出字段/排序/空值修复，且不改 SQL 语义
- 测试文件与文案常量

## 4. 流水线状态机

新表 `AutoFixRun`（每次自动修复一条完整审计记录）：

```
RECEIVED            收到 BUG_BLOCKING 反馈，建 run
ANALYZING           AI 读反馈+上下文页面+相关源码+近期 OpLog，输出定位结论
PLAN_READY          产出修复方案+预期 diff 摘要
AWAITING_APPROVAL   【P1a 阶段】超管手机一键批准后才继续
PATCHING            AI 生成 unified diff，应用到工作副本
VERIFYING           tsc 类型检查 + 目标构建 + 相关单测（有则跑）
DEPLOYING           构建产物 → 替换 → pm2 restart（先打 git tag 快照）
VERIFY_PROD         生产健康检查 + 目标页面 200 + 关键 API 抽样
RESOLVED            反馈自动 resolve + 通知提报人 + 企微通报超管
FAILED_ROLLBACK     任一验证失败 → 自动 git revert + 重部署 + 企微报警
ESCALATED           超范围/无法定位 → 转人工，附 AI 分析报告
```

并发与限额：全局 advisory lock **同时只跑一个**；`AUTO_FIX_DAILY_CAP`（建议 3）；同一反馈 24h 内不重复尝试。

## 5. 关键组件

**① 服务器源码副本（前置条件）**
当前 `/app/dianjie-v4` 不是 git 仓库且无 web 源码（只有 standalone 产物）。需：
- 服务器新增 `/app/dianjie-src`：GitHub 克隆（只读 deploy key）
- `pnpm install`（Linux 依赖；注意 sharp 平台差异，本地 Mac 构建的 node_modules 不可复用）
- 构建内存：全机 3.5G，常驻进程占 ~1.3G，Next build 峰值 ~1.5-2G → **加 2G swap** 或限定 `NODE_OPTIONS=--max-old-space-size=1536`，首次需在低峰实测

**② 修复执行器 worker**
新 pm2 进程 `dianjie-autofix`（或与 api 同进程的队列消费者）：
- 触发：`applyTriage` 判定 BUG_BLOCKING 后 enqueue（复用 NotificationLog 事件或新队列表）
- AI 引擎：Qwen（`qwen3.8-max-preview`，已配 key）。输入=反馈+对话+context+候选文件内容；输出=定位结论+unified diff。diff 应用失败/越红线即拒绝重试（最多 2 次）后 ESCALATED
- 执行环境隔离：worker 以独立系统用户跑，只挂 `/app/dianjie-src`，**不挂生产 `.env`**；部署动作由受控部署脚本（白名单内固定逻辑，非 AI 生成）执行

**③ 部署与回滚（固定脚本，AI 不生成）**
```
git tag autofix-<runId> → pnpm build → 产物 rsync 到 /app/dianjie-v4
→ pm2 restart → 60s 健康检查(health 200 + 反馈涉及页面 200)
→ 失败: git revert + 重新构建恢复 + 企微 🚨
```

**④ 通报与一键回滚**
企微卡片（textcard → 审批中心 run 详情页）：定位结论 / 改动文件列表 / diff 行数 / 部署结果 / **「一键回滚」按钮**（调 `POST /api/autofix/:runId/rollback`，仅 SUPER_ADMIN，触发固定回滚脚本）。

**⑤ 审计**
`AutoFixRun` 全字段落库 + OpLog `isAi=true` 记录每步；diff 全文存档（对象存储或 DB text 字段）。

## 6. 分阶段放开（强烈建议）

| 阶段 | 模式 | 内容 | 周期估计 |
|---|---|---|---|
| **P1a** | `suggest` | AI 到 PLAN_READY 停住，超管手机看方案+diff 摘要，**一键批准**才走验证部署 | 1.5~2 天 |
| **P1b** | `auto` 限白名单 | 纯 web 页面层修复全自动，跑 2 周看误修率 | +2 天 |
| **P1c** | 扩大 | 只读 GET 类 API 修复纳入 | 视 P1b 数据 |

环境开关：`AUTO_FIX_MODE=off|suggest|auto`（默认 off），改配置即全局急停。

## 7. 失败与兜底

- Qwen 超时/乱输出 → 重试 2 次 → ESCALATED（不影响反馈本身的紧急通知，超管照样第一时间知道有故障）
- 构建失败 → 不部署，ESCALATED，生产零影响
- 部署后健康检查失败 → 自动回滚 + 报警
- 误修（AI 修错但没挂）→ 超管一键回滚；`AutoFixRun` 复盘样本累积用于收紧提示词
- worker 崩溃 → pm2 自启；队列任务超时 30min 自动标记 FAILED 并报警

## 8. 工作量拆解（P1a）

1. 服务器 git clone + Linux 依赖安装 + swap + 首次构建实测（半天）
2. `AutoFixRun` 表 + prisma migration（这是流程内唯一的人工 migration）（0.5h）
3. 分析+补丁提示词与 diff 应用器（1 天，含单测）
4. 固定部署/回滚脚本 + 健康检查（半天）
5. 审批中心「自动修复」页 + 一键批准/回滚 + 企微卡片（半天）
6. 灰度：先对「测试反馈」跑通全流程，再上真实流量（半天）

## 9. 待老板确认的开放问题

1. P1a（人工一键批准）先行，还是直接上 P1b 全自动？（我的建议：P1a，误修成本不可控时先有人闸门）
2. 每日自动修复上限 3 次是否合适？
3. 服务器加 2G swap 是否接受？（不加的话 web 自动构建有 OOM 风险，P1a 前期可限定只自动修 API 层）
4. 一键回滚按钮需要企微交互回调，企微应用是否已配置可信回调域名？没有的话第一版回滚走审批中心页面按钮
