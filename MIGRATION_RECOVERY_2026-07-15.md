# 数据库迁移链恢复方案（2026-07-15）

> 状态：已在隔离本地库验证；**未在生产执行**。生产执行必须另行获得发布授权，并在低峰窗口完成备份和健康检查。本文早期生产差异结论只对应当时的 28 条迁移快照，不能直接套用于当前 34 条迁移发布。

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

## 生产发布顺序（待重新预检和授权）

当前发布候选已新增订货不可变、配送单、供应商商品/分类等迁移。生产执行前必须重新取得生产 `_prisma_migrations`、只读 schema diff 和数据库备份副本演练结果，再生成精确的 `migrate resolve` 清单。下面第 3 步的单条 baseline 只适用于早期快照，**当前不得原样执行**。

1. 备份生产数据库，并记录当前部署 commit、迁移列表和 API 健康检查结果。
2. 将包含上述迁移的已审查代码提交并推送到发布分支；不得手工只传 schema 文件。
3. 早期快照曾计划将 **仅** `20260715101500_reconcile_schema_drift` 标记为已应用；当前必须以重新预检结果为准：

```bash
pnpm exec prisma migrate resolve --applied 20260715101500_reconcile_schema_drift
```

早期原因：当时生产库已拥有该迁移会创建的对象，直接执行会因重复创建失败；空库仍会正常执行该迁移。当前发布不得仅凭本段历史结论操作。

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
