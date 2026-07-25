# 滇界 V4 环境基线

更新时间：2026-07-25 13:50 CST

## 结论

- 当前生产实际部署提交为 `a6d64c9db1a62ebec7c21018af116ea1dfb36430`，不是
  `main@f5a4192` 或统一 RC。
- 生产、统一 RC、本地开发库、CI 库和临时空库的 Prisma datamodel 均可对齐到同一
  63 条迁移链；生产无失败迁移，schema diff 为零。
- 本地既有库原少最后一条迁移，已在可恢复备份后通过 `prisma migrate deploy` 补齐；
  未使用 `db push`、reset 或生产写入。
- 生产三项 V4 服务和关键 HTTP/CSS 健康检查通过。自动付款、内部转账、CMB 自动同步、
  美团同步和生产 seed 均为关闭或未设置后的安全默认值。
- 本机原默认 Node 25 / pnpm 9 与生产不一致。本轮已安装并验证 Node 20.20.2，通过
  Corepack 激活 pnpm 10.32.1，并在仓库固化 Node、pnpm、Prisma 和环境键契约。
- 环境基线已足以支持三 AI 从统一 RC 并行开发；这不代表统一 RC 已获准部署生产。

## Git 与运行时基线

| 环境 | 代码/运行时 |
| --- | --- |
| 生产 ECS | deployed commit `a6d64c9` |
| GitHub main | `f5a4192` |
| 生产安全线 | `b525807` |
| 统一 RC | `c75fa11`（本批修改前） |
| 生产 Node | `20.20.1` |
| 本地项目 Node | `20.20.2` |
| 生产/本地项目 pnpm | `10.32.1` |
| 生产/统一 RC Prisma CLI/Client | `5.22.0` |
| 生产 PostgreSQL | `15.16` |
| 本地 PostgreSQL | Docker `postgres:16-alpine` |
| 生产 Python | `3.10.12` |

Node 只要求同一 20.x LTS 线；生产和本地的补丁版本差异不作为阻塞。仓库通过
`.nvmrc`、`.node-version`、`package.json#engines`、`.npmrc` 和 `pnpm env:check`
阻止以后再次无意使用 Node 25 或 pnpm 9 构建。

## 生产只读核验

### 服务与健康

- `dianjie-v4-api`、`dianjie-v4-web`、`dianjie-v4-cmb` 均为 `online`，当前进程
  uptime 起点为 2026-07-23 部署窗口。
- API `/health` 返回 200。
- CMB relay 未鉴权请求返回 401，鉴权前置正常。
- CMB 自身 `/health` 返回 200。
- Web `/v2/login` 返回 200；当前 CSS chunk 返回 200，大小 42,779 bytes。
- API 错误日志当前为 0 bytes。CMB 的 stderr 主要是每 20 秒一次的成功余额查询访问日志。
- Web 日志存在旧客户端/旧部署 Server Action 请求错误，但当前页面和静态资源健康；
  作为运行监控项保留，不作为本地环境阻塞。

### 数据库与迁移

- 数据库名：`dianjie_v4`。
- 已完成迁移：63。
- 失败迁移：0。
- 最新迁移：`20260722014111_add_consumption_void_correction`。
- 公共表：86；公共枚举：59。
- 生产 datasource 到部署 datamodel 的 `prisma migrate diff --exit-code` 为 0，
  `No difference detected`。
- `inventory_snapshot_items` 的五个单位归一化字段类型和精度与统一 RC 一致。

存在一项迁移账本历史差异：

- `20260716143000_inventory_snapshot_unit_normalization` 的生产 Prisma ledger checksum
  为 `33e33f...`。
- production/main/safety/release/统一 RC 以及 ECS 当前 migration.sql 文件 checksum 均为
  `55fbad...`。
- 生产真实字段和当前 datamodel 一致，因此这是“迁移应用后文件曾发生变化”的历史账本
  证据，不是 schema 缺失。
- 禁止修改、重跑或用 `db push` 掩盖该差异；未来只新增 migration。

### 生产功能开关

| 开关 | 当前只读事实 |
| --- | --- |
| `NODE_ENV` | `production` |
| `CMB_USE_PROD` | `true` |
| `CMB_AUTOPAY_ENABLED` | `false` |
| `CMB_INTERNAL_TRANSFER_ENABLED` | `false` |
| `CMB_SYNC_ENABLED` | 未设置，代码默认 `false` |
| `MEITUAN_ENABLED` | 未设置，代码默认 `false` |
| `MEITUAN_MODE` | 未设置，代码默认 `mock` |
| `ALLOW_DEMO_SEED` | 未设置，代码与生产环境双重拒绝 |
| `ALLOW_TEST_ACCOUNT_SEED` | 未设置，代码与预览模式双重拒绝 |

生产未提供的 18 个 `.env.example` 键均属于关闭功能、测试 seed、Sentry 或企微 webhook
等条件配置。本轮没有为了“形式一致”向生产写入无用空值。

生产额外存在 6 个键名。本轮已把仍被运行时代码使用的 `CMB_RATE_LIMIT_SEC`、
`RECEIPT_STORAGE_DIR` 和 `WECOM_REDIRECT_BASE` 补入模板；三个 `ALIYUN_SMS_*` 键在当前
源码没有消费者，暂列历史配置，不擅自从生产删除。

### 一次性脚本执行事实

生产数据库只读证据补齐了此前 UNKNOWN：

- `MANUAL:BOM-GAP:2026-07-21`：sent 1。
- `MANUAL:DQ:2026-07-21`：sent 1。
- `MANUAL:DQ:2026-07-24`：sent 1；因此 `notify-chef-confirm-0724.ts` 已执行。
- `correct-20260719-bom-units`：存在 1 条“BOM包装单位纠错”操作日志，已执行。
- 2026-07-22 消耗作废 30 行、补记 30 行，与三条修正脚本的组合记录一致。
- `merge-duplicate-archives-0723.ts --apply` 仍以部署记录为执行证据。

这些脚本全部视为历史已执行脚本，禁止自动重跑。

### 备份

- 最近数据库备份：
  `dianjie_v4-deploy-bak-20260723-090849-a6d64c9.dump`，权限 600，
  `pg_restore -l` 通过。
- 最近构建备份：
  `v4-build-bak-20260723-090849-a6d64c9.tar.gz`，权限 600，tar 目录校验通过。
- 根磁盘占用 54%。
- 下一次任何生产写入或部署前仍须生成新备份，不能把 7 月 23 日备份当作当前回滚点。

## 本地与 CI 对齐

### 本地既有库

- 对齐前：62/63，缺 `20260722014111_add_consumption_void_correction`。
- 备份：
  `/Users/somnusyi/Documents/Codex/backups/dianjie-v4-local/before-env-alignment-20260725-133451.dump`，
  已通过 `pg_restore -l`，权限 600。
- 通过 `prisma migrate deploy` 应用最后一条迁移。
- 对齐后：63/63，`migrate status` up to date，schema diff 为零。

### CI 库

- `dianjie_v4_ci`：63/63，schema diff 为零。
- PostgreSQL 全量集成测试：16 个文件，93/93 通过。

### 临时空库

- 从零应用 63 条 migration 成功。
- `migrate status` up to date，schema diff 为零。
- 退出后 `dianjie_v4_migration_e2e_*` 临时数据库残留为 0。

## 运行时契约改动

- 新增 `.nvmrc` 和 `.node-version`：Node 20.20.2。
- 新增 `.npmrc`：`engine-strict=true`。
- `package.json` 固化 Node 20.x、pnpm 10.32.1，并新增 `pnpm env:check`。
- API、DB 的 Prisma Client/CLI 从宽泛 `^5.9.1` 固定为实际使用的 `5.22.0`。
- `.env.example` 补齐当前运行时代码使用的非密钥配置键，移除模板注释中的测试银行标识。
- README 的启动流程改为先验证运行时，再用 `migrate deploy` 对齐现有本地库。

## 验证

以下全部在 Node 20.20.2、pnpm 10.32.1、Prisma 5.22.0 下执行：

- `pnpm env:check`：PASS，63 migrations、49 个环境契约键。
- 冻结 lockfile 离线安装：PASS。
- API 单元测试：28 个文件，163/163。
- API build：PASS。
- Web 测试：6 个文件，22/22。
- Web `tsc --noEmit`：PASS。
- Web production build：PASS，142 个静态页面生成。
- PostgreSQL 集成：16 个文件，93/93。
- 本地既有库、CI 库、临时空库 migration/status/diff：全部 PASS。

## 剩余环境事项

1. 统一 RC 尚未部署，生产继续运行 `a6d64c9`；两者的代码差异进入正常 integration train，
   不能直接覆盖 main 或生产。
2. 迁移 checksum 历史差异保留审计记录，不修改旧 migration。
3. Web 的旧 Server Action 请求日志需要继续观察；当前健康检查无故障。
4. 下次生产变更前创建新数据库和构建备份。
5. 三个无源码消费者的 `ALIYUN_SMS_*` 生产键待后续配置清理批次处理，不影响开发。
