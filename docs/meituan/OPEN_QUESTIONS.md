# 美团智能版 API · 待美团回复的开放问题

> 用途：跟 mtdeveloper@meituan.com 邮件 / 工单沟通时的问题清单
> 凭证到位、答案收集齐了 → 把答案回填到本文档并 commit

---

## Q1: 接入流程下一步

**问题**：我们目前的接入进度卡在哪一步？还需要补交什么材料 / 完成什么操作？

**期望答案**：明确的下一步行动清单（如"提交营业执照彩色扫描件"或"应用类型审核中, 预计 X 天"）

**状态**：⏸️ 等回复

**答案**：

---

## Q2: appAuthToken 生命周期与 refresh 机制

**问题 2.1**：appAuthToken 的获取方式？商家扫码 / 开发者后台直接生成 / OAuth2 跳转？

**期望答案**：具体步骤截图或文字流程

**答案 2.1**：

**问题 2.2**：appAuthToken 的有效期是多少？是长期 token 还是定期需要刷新？

**期望答案**：天数（如 "30 天" 或 "永久"）

**答案 2.2**：

**问题 2.3**：refresh_token 的接口路径、请求参数、返回结构能否提供完整文档？

**背景**：错误码文档说 `OP_UNIAUTH_FAILED + data.code=4` 时 "使用 refresh_token 刷新"，但具体接口路径没说

**期望答案**：完整的接口规范，例如：
```
POST /rms/auth/refresh
Body: { businessId, refreshToken, ... }
Response: { code, data: { appAuthToken, refreshToken, expiresIn } }
```

**答案 2.3**：

---

## Q3: 沙箱（测试）环境接入

**问题**：沙箱环境怎么接入？能否分配测试用的 orgId / poiId / 模拟订单数据？

**期望答案**：
- 沙箱 API 域名（与生产是否相同）
- 测试 orgId / poiId
- 测试 appAuthToken (或测试授权流程)
- 是否能 mock 推送一些测试订单

**状态**：⏸️ 等回复

**答案**：

---

## Q4: 接口权限白名单

**问题**：智能收银三方应用类型，调用以下接口是否需要单独申请权限？

待确认接口：
- `POST /rms/pos/api/v2/poi/orders/instore/query` (订单列表 V2)
- `POST /rms/pos/api/v1/poi/reverse/orders/search` (退单列表)
- `POST /rms/pos/api/v2/poi/orders/ids/query` (订单详情)
- `POST /rms/data/api/v1/poi/dishes_report_loss/query` (菜品报损)
- `POST /rms/data/api/v1/poi/dish_sale/query` (菜品销售统计)

**期望答案**：每个接口"已开通 / 需申请 / 不可申请"的明确状态

**状态**：⏸️ 等回复

**答案**：

---

## Q5: 数据保留期

**问题**：智能版接口的订单数据保留期是多久？我们想拉历史 N 个月前的数据，能否实现？

**期望答案**：天数 (如 "90 天" 或 "1 年")

**应用**：决定 backfill 历史数据的上限 (我们代码内置 365 天 cap)

**状态**：⏸️ 等回复

**答案**：

---

## Q6: 调用频次与限流策略

**问题**：每小时增量轮询 (按 modifyTime 类似机制) 是否支持？有 QPS / 单次拉取条数限制？

**已知约束**：
- pageSize ≤ 50 (从 API debug 工具确认)
- 单次窗口 ≤ 31 天 (instore) / 30 天 (reverse)

**期望答案**：
- QPS 上限
- 单日总调用次数上限
- 限流恢复机制

**应用**：决定 cron 频率 (目前每小时, 未来如能更频可改为 15 分钟)

**状态**：⏸️ 等回复

**答案**：

---

## Q7: 签名算法版本

**问题**：我们已按 [签名规则文档](https://developer.meituan.com/docs/biz/comm-dev-isv-sign-rule) §2.1 PHP 样例实现 SHA1 算法。如有版本差异请明示。

**期望答案**：确认 "SHA1 + 字典序拼接 + signKey 前置 + hex 小写" 这套算法目前仍是当前版本

**状态**：⏸️ 等回复 (低优先级, 我们的签名实现已经通过 6 个单测)

**答案**：

---

## 工单 / 邮件提交记录

| 时间 | 渠道 | 提交人 | 状态 |
|---|---|---|---|
| 2026-05-XX | TT 工单 "接口对接" | 客户 | ❌ 被机器人退回 (走错通道) |
| (待) | 邮件 mtdeveloper@meituan.com | 客户 | ⏸️ 等发 |
