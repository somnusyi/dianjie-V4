# Worktree 与分支审计（2026-07-29）

## 结论

接管时发现：

- 74 个 Git worktree；
- 89 个本地分支；
- 59 个分支未被 Git 判断为已合并到 `main`；
- 正式部署 worktree `/Users/somnusyi/Desktop/dianjie-V4/dianjie-V4-deploy` 干净且位于 `2ff95503`；
- 主工作仓 tracked files 干净，存在若干用户文件和历史临时脚本，未删除、未纳入本次提交。

大量 worktree 来自 2026-07-25 至 2026-07-26 的多 AI 并行开发。部分提交可能已被 squash/cherry-pick，不能仅凭
`git branch --merged` 判断是否可删除。

## 处置规则

1. 生产部署 worktree、主工作仓和当前 P0 分支必须保留。
2. 对每个历史分支记录：提交摘要、相对 `main` 的 patch-id、是否有唯一文件改动、是否关联已发布功能。
3. 有唯一改动的分支进入人工复核清单。
4. 无唯一改动且对应功能已发布的分支先打 `archive/20260729/...` tag，再删除 worktree。
5. 删除 worktree 前不得使用 `git reset --hard` 或覆盖用户文件。
6. 本轮 P0 只完成审计和冻结，不执行批量删除，避免误删尚未归档的多 AI 成果。

## 后续验收

- 活跃 worktree 控制在 5 个以内；
- 所有开发任务均在 `AGENT_BOARD.md` 登记；
- 每个发布分支必须能追溯到远程提交或归档 tag。
