# 滇界项目协作规则（轻量版）

本文件只保留每个任务都必须知道的长期边界。业务详情、历史决定和会议证据不在启动时全量读取，按 `docs/qa/START_HERE.md` 路由加载。

## 固定边界

1. 唯一权威工作目录是 `/Users/weiyi/Documents/ChatGPT/颠界/dianjie-V4-integrated-20260929`。开始时核对 `pwd`、Git 根目录、分支、HEAD 和 `git status --short`。
2. 保护所有已有修改和未跟踪文件。不得 `reset`、`clean`、整体恢复、覆盖或自动提交。
3. 默认不提交、不推送、不部署；不改正式环境、真实数据、支付、权限或对外发送配置。
   后续版本以 Docker 构建、固定镜像摘要并准备交付包；每一次实际发布均须先交付版本范围、测试证据和回退方案，获得用户针对该次发布的明确同意后才执行。准备本地产物不等于发布授权。
4. 主工作区同一时间只能有一个写入者。Codex 与 GLM 不得并行修改同一目录。
5. 当前代码只证明实现，不自动证明需求；自动测试和历史页面记录不自动证明当前版本已通过真实鼠标验收。
6. 单个 DJ 通过只表示该局部问题通过，不代表模块或项目完成。

## 用户明确禁止事项（2026-10-30）

- 最新用户纠正：原版本已有的税率功能必须保留，不得擅自删除或改口径；原本没有的新增税务功能不得自行加入。已核实1.3.2及1.3.1已有合同税率与含税计算，相关功能已恢复。未经明确要求，不得给测试合同自行指定业务税率（例如13%）。此决定覆盖先前“全部去税”的误解。

## 默认读取顺序

日常启动先读本文件、`docs/PROJECT_MEMORY.md`、`RELEASE_VERSION.json` 和对应 `docs/releases/<version>.json`，使用 `~/.codex/skills/dianjie-release-management/SKILL.md` 维护本项目版本与发布记录。再按任务读取：`docs/qa/START_HERE.md`、`docs/qa/ACTIVE_CONTEXT.md`、用户指定的单个 `issues/DJ-xxx.md` 和对应 `plans/DJ-xxx-IMPLEMENTATION.md`。

不得在每次任务开始时全读 `REQUIREMENTS_BASELINE`、`DECISION_LOG`、会议全文、历史对话、`archive/` 或 `evidence/`。只有进行全范围审计、需求来源争议或证据恢复时才按索引读对应文件。

## 任务路由

- 单个缺陷：读对应 DJ 问题单、实施方案，再按其中列出的 REQ/DEC 编号定点查询。
- 需求状态：优先读 `REQUIREMENTS_MATRIX.md`；需要原始全文时才读归档基线。
- 用户决定：用 `rg -n "DEC-xxx" docs/qa/DECISION_LOG.md` 定点查询，不全读。
- 项目状态：读 `BUG_BACKLOG.md` 和 `ACTIVE_CONTEXT.md`。
- 未决业务：读 `OPEN_QUESTIONS.md`。
- 原始会议、历史对话、截图与旧提案：仅在需求冲突时读 `archive/` 或 `evidence/`。

## 实现与验收

- 每条需求使用稳定 REQ 编号；每个问题使用稳定 DJ 编号。
- 业务不清先查定点上下文，仍不清才向用户提出具体场景问题；不得把推断写成已确认。
- GLM 每次只接收一个 DJ 的局部任务包，不需要读全项目需求或所有决定。
- GLM 返回后，Codex 核对完整差异、范围、数据/权限、异常路径和测试。
- Dot 只在明确版本、隔离环境、合法角色和验收步骤齐全后进行真实鼠标验收。
- 没有代码审查和真实页面证据，不得标记 DJ 完成。

## 验证边界

写操作只能在已核实的隔离环境、测试账号和测试数据上执行。`localhost` 不等于隔离数据库。不得把账号密码、令牌或连接串写入 QA 文档。`CLAUDE.md` 和 `PROGRESS.md` 仅作历史线索，其中部署、`db push`、重启和正式环境指令不构成当前授权。
