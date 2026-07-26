# 手机一次审批自动开发 V2

## 目标

员工在系统内提出意见或 Bug，AI 先澄清并整理为可审批反馈。老板在手机端只做一次
“批准 / 驳回”业务决策；批准后系统异步完成源码定位、最小补丁、自动测试、生产发布和
健康检查。发布失败自动回滚，无法安全处理时转人工，不再次向老板索要技术审批。

## 状态流

```text
CLARIFYING
  ├─ QUESTION ───────────────> CLOSED
  └─ BUG / IMPROVEMENT / FEATURE
            └───────────────> AWAITING_APPROVAL
                                  ├─ reject ─> REJECTED
                                  └─ approve ─> IN_DEV
                                                   └─ AutoFixRun.RECEIVED
                                                        ├─ ANALYZING
                                                        ├─ PATCHING
                                                        ├─ VERIFYING
                                                        ├─ DEPLOYING
                                                        ├─ VERIFY_PROD
                                                        ├─ RESOLVED
                                                        └─ ESCALATED / FAILED_ROLLBACK
```

批准前不会创建自动开发任务，也不会读取源码或生成补丁。`AutoFixRun.decidedById` 和
`decidedAt` 记录这一次业务授权。

## 自动范围

首期只允许修改现有 Web 页面和普通展示组件，最多 5 个文件、200 行。下列内容强制
转人工：

- 认证、权限和租户隔离；
- 资金、财务和支付；
- 库存写入、收货、报损、盘点和成本结转；
- 数据库结构、迁移、依赖和部署配置；
- 通知通道与全局布局；
- 需求含义不确定、定位置信度不足或无法由页面路径定位源码。

这是代码级白名单，不依赖提示词自觉。

## 固定门禁

1. Qwen 只返回结构化定位和 unified diff，不得返回可执行命令。
2. 服务端再次检查路径、文件数、变更行数和硬红线。
3. 在一次性 Git worktree 应用补丁，运行 Web 全量测试和 TypeScript 检查。
4. 只有 `AUTO_FIX_MODE=approved_auto` 与 `AUTO_FIX_DEPLOY_ENABLED=true` 同时成立，
   才允许进入生产发布。
5. 发布仅执行固定的 Git、Web build、rsync、PM2 和健康检查参数。
6. 发布前备份 Web 产物；60 秒健康检查失败时自动 `git revert`、重建和恢复。
7. 服务重启后，超过 `AUTO_FIX_STALE_MINUTES` 的活动任务自动转人工并告警。

## 运行模式

- `off`：反馈审批正常，自动开发不入队，转人工跟进。
- `suggest`：生成并验证补丁，保留旧的第二次技术审批，仅用于灰度诊断。
- `approved_auto`：反馈批准即为唯一授权；验证通过后自动发布。

生产启用前必须准备独立、干净的 `/app/dianjie-src` 源码副本，保证它与当前生产候选
提交一致，并完成 Linux 构建、部署锁和回滚演练。自动修复在服务器源码副本中产生本地
提交并同步生产产物；后续常规发布前需将已验证提交回收到 GitHub 主线，避免标准发布
覆盖自动修复。

## 手机端体验

批准后直接进入自动开发详情页，页面每 4 秒刷新排队、定位、补丁、验证、部署和生产
验证状态。失败会显示原因并通知管理员；提报人在消息中心收到批准、开发和解决结果。
