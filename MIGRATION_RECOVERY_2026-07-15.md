# 数据库迁移链恢复方案（2026-07-15）

> 状态：已在隔离本地库验证；**未在生产执行**。生产执行必须另行获得发布授权，并在低峰窗口完成备份和健康检查。本文早期生产差异结论只对应当时的 28 条迁移快照，不能直接套用于当前 34 条迁移发布。

## 2026-07-16 生产副本复验结论

- 已为生产 commit `c8dca9a` 创建新的数据库和构建快照；服务器端归档校验、下载后 SHA-256 比对和本地恢复均通过。
- 生产当前有 25 条已应用迁移、0 条失败迁移；发布候选有 34 条迁移，其中 9 条待处理。
- 只读指纹复核确认 `20260715101500_reconcile_schema_drift` 所代表的历史结构已经存在：14/14 个枚举、12/12 张表、10/10 个关键字段；documents 三张表也全部存在。
- 在生产副本直接执行 `migrate deploy` 已稳定复现 PostgreSQL `42710`：`InvoiceStatus` 已存在。因此该历史迁移不能直接执行。
- 在全新恢复的生产副本中，仅将 `20260715101500_reconcile_schema_drift` 标记为已应用后，其余迁移全部成功：34/34 已应用、0 失败、最终 schema diff 为零。
- 迁移前后 28 个账号、100 张订货单、92 张收货单、724 个商品及其稳定字段哈希完全一致；历史回填生成 92 张配送单、1316 条配送明细，关键外键孤儿数均为 0。
- 上述检查已固化到 `scripts/prepare-production-p0-baseline.sh`。脚本默认只读，只有提供显式确认短语和 `--apply-baseline` 才会写入 Prisma 迁移账本；它不会执行其余迁移或重启服务。

## 发现的问题

生产数据库实际已存在部分业务结构（documents、发票、总部代付、供应商库存、门店支付配置等），但 Prisma 的 `_prisma_migrations` 缺少对应历史记录。空库执行旧迁移链也无法完整复现当前 `schema.prisma`。

新增迁移：

1. `20260516035000_add_documents_module`：幂等补建 documents/审批流对象，使后续 `20260516040000` 可在空库运行。
2. `20260715101500_reconcile_schema_drift`：让已补齐 documents 的空库创建其余 schema 漂移对象。
3. `20260715103000_align_existing_schema`：对齐既有库的外键规则、`purchase_orders.deliveredAt` 时间精度和库存消耗索引名。

## 已完成验证

- 隔离本地库从空库应用全部 28 条迁移成功。
- 本地最终 schema 与 `schema.prisma` 的 `prisma migrate diff` 为零差异。
- 生产只读预检确认主要业务对象已存在。
- 生产实际差异仅为外键规则、`deliveredAt` 精度和历史索引名。
- 生产 `deliveredAt` 非空值没有毫秒以下精度，收敛为 `timestamp(3)` 不丢失业务时间。

2026-07-15 晚补充：

- 本地现有数据库已建立 34 条完整迁移账本，`migrate status` 为最新。
- 本地现有数据库与当前 `schema.prisma` 零差异。
- 34 条迁移在全新空数据库从头执行成功，执行后与当前 `schema.prisma` 零差异。
- 新增 `20260715180000_align_supplier_product_categories`，幂等修正供应商分类更新时间默认值和索引名。

## 生产发布顺序（已完成副本演练，仍待正式发布授权）

当前 34 条迁移的生产副本演练已经完成。正式发布窗口仍须重新生成当时的新备份，并先运行只读指纹检查；如果指纹发生变化，立即停止，不得沿用本次结论。

1. 备份生产数据库，并记录当前部署 commit、迁移列表和 API 健康检查结果。
2. 将包含上述迁移的已审查代码提交并推送到发布分支；不得手工只传 schema 文件。
3. 运行只读检查：

```bash
./scripts/prepare-production-p0-baseline.sh
```

检查结果必须与本节指纹一致。在新备份和批准窗口内，仅将历史漂移迁移 baseline：

```bash
CONFIRM_PRODUCTION_BASELINE=APPLY_BASELINE_dianjie_v4 \
  ./scripts/prepare-production-p0-baseline.sh --apply-baseline
```

原因：生产已经拥有该迁移代表的历史结构，直接执行会因重复创建失败；全新空库仍会正常执行该迁移。该命令只登记迁移账本，不会运行其他迁移。

4. 运行：

```bash
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
```

这会幂等执行 documents 补建迁移，并执行既有 schema 对齐迁移。

5. 重启服务前后分别验证：API 健康检查、登录、店长库存摘要、营业指标、采购订单与凭证相关页面。
6. 记录 `.deployed-commit`，保留数据库备份和迁移日志；任一验证失败立即停止后续发布并按部署 SOP 回滚代码。

## 禁止事项

- 不要在生产运行 `prisma migrate dev`、`prisma db push` 或数据库 reset。
- 不要跳过备份或把生成的迁移直接 rsync 到服务器后单独执行。
- 不要把数据库连接串、SSH 密码或银行密钥写入本文档、Git 或聊天记录。
