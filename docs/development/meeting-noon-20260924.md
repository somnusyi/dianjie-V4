# 门店中午收货与逾期报损：首批实现记录

## 范围与规则

- 业务时区固定为 `Asia/Shanghai`；`PurchaseOrder.expectedDate`、`Receipt.deliveryDate` 均以 PostgreSQL `date` 的日期文本处理。
- 门店待收货在约定到货日 12:00 前应处理；逾期只提示和要求处理，绝不自动实收。
- 实际收货单以配送实际送达的上海业务日冻结 `deliveryDate`；系统自动送达没有实际到货证据时回退约定到货日。
- 逾期到货异常仍可如实提交，返回 `lateReport`，并禁止定时任务自动同意；人工处理入口与原有角色不变。
- 已确认收货的逾期判断以 `confirmedAt` 评估，次日查看不会把当时准时的单误判为逾期。

## 已验证证据

使用 Node 20.20.2 与隔离数据库 `dianjie_meeting_noon_20260924_ci`：

- `pnpm --filter @dianjie/api exec tsc --noEmit`：通过。
- `pnpm --filter @dianjie/web exec tsc --noEmit`：通过（控制方执行）。
- 聚焦 API 单元/路由回归：`lossClaimResolution`、`receiptCorrection`、`receiptsQuery`、`loss-claim-scope` 与 deadline/auto-receive 测试，共 8 文件、58 测试通过。
- `vitest.integration.config.ts tests/routes/postReceiptLoss.integration.test.ts`：1 文件、4 测试通过，覆盖逾期补报可创建、标记并保持待人工处理。
- `vitest.integration.config.ts tests/routes/noonReceiptFinance.integration.test.ts`：1 文件、8 测试通过。隔离数据库回归覆盖真实 `confirm-with-loss` 的当日/逾期入口、逾期 NET ¥80/¥20 的冻结与人工批准、拒绝→¥90 仲裁、重复仲裁不重复扣款、高额恢复 `PENDING_APPROVAL`、1950→2050 审批门槛提升，以及账期派生与人工批准、NET 拒绝与 GROSS 批准的 `Promise.all` 竞争路径。
- `tests/services/scheduler.test.ts`：1 测试通过，模拟 1,001 条逾期补报在前时，分页仍扫描并自动处理后续正常报损。
- API 非 integration 全量：118 文件、1,191 测试通过（控制方执行）。
- Web 全量测试：69 文件、853 测试通过（供应商逾期提示最终改动后尚未重新运行该全量命令）。

## 未验证与非目标

- 在独立 preview 数据库做过一次 Safari 门店操作：迟收 10→8 的提交后，数据库为 `PENDING` 差异 ¥20 与 `ON_HOLD` 应付 ¥80；补报页展示逾期标记与 12:00 截止。这不是所有角色、设备或供应商操作的 UI 验收。
- `HEADQ_WAREHOUSE` 补报没有 `paymentSchedule` 的既有限制仍在，不能将其宣称为本批已支持。
- 本批不包含全部会议议题、权限/角色改造、schema 或迁移、部署、生产数据操作、提交或推送。
- 财务派生和结案恢复已按收货-财务锁创建/恢复账期状态；本批有隔离数据库的批准、拒绝、仲裁与高额恢复回归，但未进行真实银行付款或浏览器操作验收。
