# 滇界项目 · 质量门禁 (Quality Gate)

每次开发会话**必须遵守**以下规则。这些规则是为防止以往出现过的真实 bug。

## 1. 加链接 → 必须建对应页面/路由

每次给前端加 `<a href="/v2/...">` 或 `location.href = '/v2/...'`，**立刻**:
- `find` 或 `ls` 验证目标 page.tsx 真实存在
- 如果是动态路由 `[id]`,目录里必须有 `page.tsx`，不能只有空目录
- 加新 API 端点时同样,curl 一下确认 200 (或预期状态)

> 历史 bug: `/v2/supplier/orders/[id]` 链接存在但 `[id]/` 目录是空的 → 用户点详情 404

## 2. 改 DB → 必须刷缓存

`/api/products` 等接口有 600s 缓存。任何改 product/store/supplier 等核心表的代码:
- 必须配套 `void invalidatePattern('products:full:${tenantId}:*')`
- 文档审批回调里特别容易漏

> 历史 bug: 总厨批准调价后, 商品报价表前端 600s 内还显示旧价

## 3. 改权限 → 必须 多角色 验证

碰任何 `auth-scope.ts` 相关代码 / 加 `where: { tenantId }` 查询:
- 必须用至少 2 个不同角色 token 调一遍 (建议: 供应商账号 + 老板账号)
- 期望非授权角色返回 403 或空结果

> 历史 bug: payments/reconciliations/schedules/receipts/cashbook 都漏过供应商隔离

## 4. 改 schema → 必须验证 ECS 真同步

每次改 `packages/db/prisma/schema.prisma`:
1. 本地 `npx prisma generate`
2. rsync 到 ECS,**必须 grep 验证文件内容真的变了** (rsync 的 0 字节同步不会报错)
3. ECS 上 `npx -y prisma@5.22.0 db push --schema=./prisma/schema.prisma --skip-generate`
4. ECS 上 `npx -y prisma@5.22.0 generate --schema=./prisma/schema.prisma`
5. pm2 restart (没 restart 旧 client 还在内存)

> 历史 bug: schema rsync 0 字节 → db push 推的是旧 schema → 接口报"列不存在"

## 5. apiFetch / fetch 调用 → 注意 Content-Type

`apiFetch` 只在有 `body` 时才设 `Content-Type: application/json`:
- 没 body 的 PATCH/DELETE 不要传 body 也不要传 Content-Type
- Fastify 看到 Content-Type 但 body 空会 400

> 历史 bug: 撤回上传按钮一直没反应,因为 PATCH 无 body 但传了 Content-Type

## 6. 报价表 (Product) ≠ 库存 (StockMovement)

两个模块**严格解耦**:
- `/api/products` POST/batch 不接受 stock 字段
- 库存变动只走 `/api/supplier/stock/*` (manual/excel inbound, adjust, loss, snapshot)
- 商品报价表 UI 不显示库存数字 (会让供应商误以为能在那改)

## 7. 部署后必跑 E2E

每次 `pm2 restart` 完:
```bash
node scripts/e2e-full-flow.js
```

29 项检查 30 秒内跑完,失败必须先修再说"完成"。

## 8. 触发审批的回调一定要可逆

新增 / 改价 / 停售 走总厨审批的功能:
- APPROVED → 应用变更 + 刷缓存
- REJECTED → **回滚** (新建删 product / 停售恢复 ENABLED) + 刷缓存
- PENDING → product 状态用 PENDING_APPROVAL / PENDING_DISABLE 标记防误触

## 9. 危险操作必须 3 重确认

- DELETE / clear-all 类: 前端 confirm sheet + 后端要求 `confirm=CLEAR_ALL` 字段 + 检查依赖 (有订单引用就拒)
- 改密码 / 改角色 / 改 storeId: 必须用户在 chat 显式说"做" / "确认"

## 10. 开发账号

```
13900000001 / test1234  - SUPPLIER_OWNER (绑 SUP001)
13900000002 / test1234  - CHEF_DIRECTOR  (总厨)
13900000003 / test1234  - ADMIN          (老板)
13900000004 / test1234  - MANAGER        (店长, 绑合肥瑶海店)
13900000005 / test1234  - KITCHEN_LEAD   (厨师长, 绑合肥瑶海店)
13900000006 / test1234  - FINANCE        (财务)
13900000007 / test1234  - ENGINEERING    (工程部)
13900000008 / test1234  - SUPPLIER_STAFF (绑 SUP001)
```

## 11. 关键 URL

- 本地开发: 不用 (我们直接改 ECS)
- 生产: http://116.62.32.162:8080 (HTTP, IP) / https://app.dianjie.cc (HTTPS, 域名)
- ECS 路径: /app/dianjie-v4/apps/api 和 /app/dianjie-v4/apps/web/apps/web
- DB: dianjie_v4 @ pgm-bp14m7g69y66165r.pg.rds.aliyuncs.com (RDS)

## 12. 每次会话开始前

读 `PROGRESS.md` 知道项目状态。每个大功能上线后更新 `PROGRESS.md`。

## 13. 任何带 enum Status 的模型 → 必须画状态机

每次碰带状态枚举的表 (PurchaseOrderStatus / DocumentStatus / ProductStatus / ApplicationStatus / ...),
在代码里维护一张转换表 (注释/MD都行):

| from → to | 触发者(角色) | API 端点 | 通知谁 |
|---|---|---|---|

**规则**:
- 每个状态都要可达 (有 transition 进入). 否则是孤儿状态, 必删.
- 每个状态都要可出 (除终态 COMPLETED/CANCELLED). 否则用户卡死, 必加端点.
- "谁触发" 必须明确. 没人触发的 transition 是设计漏洞.

> 历史 bug: PurchaseOrderStatus 有 CONFIRMED 状态但永远到不了 (供应商没"接单"按钮),
> ship 端点接受 SUBMITTED/CONFIRMED 都能发货, 中间状态永久死亡.

## 14. 跨角色影响清单 (Cross-role Impact)

每加一个 transition 操作 (新端点 / 改业务规则), **必须**列:

1. **触发者**: 哪个角色点哪个按钮
2. **数据写入**: 哪几张表变化
3. **被影响角色**: 哪些角色的视图/inbox/通知会变
4. **验证 SQL/API**: 用被影响角色的 token 至少调一次 GET 确认数据如期变化

> 历史 bug: 加供应商接单按钮时, 没考虑店长侧需要 "已接单" 通知. 链路不完整.

## 15. E2E 必须覆盖每个状态转换

`scripts/e2e-full-flow.js` 里, 每个 status enum 的每个 transition 至少跑一次.
新加状态/端点时同步加用例, 不是只测 happy path.
