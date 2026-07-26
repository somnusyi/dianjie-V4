# P1a AI 自动修复运行手册

## 安全开关

生产默认：

```dotenv
AUTO_FIX_MODE=off
AUTO_FIX_DEPLOY_ENABLED=false
```

只有同时满足以下条件，才允许灰度为 `suggest + true`：

1. `/app/dianjie-src` 是干净的 Linux 源码副本，HEAD 与生产基线一致。
2. 已安装 Node 20、pnpm 及 Linux 原生依赖，Web build 在低峰验证通过。
3. `/app/dianjie-v4/.deploy-lock` 可由固定部署器原子创建和释放。
4. 超管审批页能显示完整定位结论、文件摘要和 diff。
5. 红线、每日上限、租户隔离、失败回滚测试全部通过。

`AUTO_FIX_MODE=off` 时，阻断反馈仍按原 P0 流程通知超管，不创建 `AutoFixRun`，
不读取源码、不调用第二轮 Qwen、不执行任何 Git、构建或部署动作。

## P1a 边界

- 自动补丁仅允许 `apps/web/src/app/**` 与 `apps/web/src/components/**` 的展示代码。
- `AppLayout.tsx` 整文件拒绝，避免权限判断 hunk 漏检。
- API 自动修复推迟到 P1c；P1a 不依靠提示词判断 GET/SQL 语义。
- 补丁最多 5 个文件、200 行，禁止二进制、删除、重命名和目录穿越。
- AI 只产 JSON 定位结论和 unified diff；不接受、拼接或执行 AI 命令。

## 部署与回滚

批准后固定流程：

1. 获取生产 `.deploy-lock`。
2. 校验源码副本干净且 HEAD 等于方案冻结的 `baseCommitSha`。
3. 再跑红线校验和 `git apply --check`。
4. 生成本地提交与 `autofix-<runId>` 标签。
5. 备份当前 Web 产物，执行固定 Web build/rsync/PM2 restart。
6. 验证 `/api/health` 与反馈页面，最多 60 秒。
7. 成功后更新 `.deployed-commit`、反馈闭环并通知；失败固定 `git revert` 后重建恢复。

自动修复提交当前保留在服务器源码副本，不直接推 GitHub。标准人工部署看到生产提交
不在远端历史中时会停止，需先人工复核并把补丁纳入 `main`，避免静默覆盖。
