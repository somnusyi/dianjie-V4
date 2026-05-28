# 美团智能版 API · 接入运维手册

> 用途：凭证到位后的部署 / 启用 / 日常运维 / 应急
> 配套代码：`apps/api/src/services/meituan/*` + `apps/api/src/routes/meituanAdmin.ts`
> 配套 spec：`docs/superpowers/specs/2026-05-27-美团智能版-订单同步与可视化-设计稿.md`

---

## 1. 凭证拿到后第一次启用 (约 0.5 天)

### 1.1 填 .env

在生产 `.env` (`/app/dianjie-v4/.env`) 追加：

```
MEITUAN_ENABLED=true
MEITUAN_MODE=real
MEITUAN_DEVELOPER_ID=<美团回复给的>
MEITUAN_APP_SECRET=<美团回复给的>
MEITUAN_BUSINESS_ID=18
MEITUAN_ORG_ID=<美团回复给的>
MEITUAN_POI_ID=<美团回复给的, 仅记录用>
MEITUAN_BOOTSTRAP_AUTH_TOKEN=<沙箱 token, 形如 V2-xxx>
MEITUAN_BOOTSTRAP_REFRESH_TOKEN=<如有>
MEITUAN_API_BASE=https://api-open-cater.meituan.com
```

### 1.2 配置门店映射

把瑶海店的 `Store.meituanShopId` 设成美团下发的 `poiId`：

```sql
UPDATE stores SET meituan_shop_id = '<poiId>' WHERE no = '<瑶海店编号>';
```

⚠️ 不设的话所有订单 `storeId=null` 进入 `skippedNoStore`，处理停滞。

### 1.3 实现 refresh_token (PR 5 Task 33)

待美团回复给出 refresh 接口路径后：
- 修改 `apps/api/src/services/meituan/client.ts` 中 `refreshToken` 方法 (目前为 stub 抛错)
- 填入真实 axios 调用
- 测一遍：手动改 token 让它过期，触发 `OP_UNIAUTH_FAILED + data.code=4`，看是否自动刷新

### 1.4 沙箱验证 (重要)

先用沙箱凭证跑通：

```bash
TOKEN=<boss 账号 token>

# 手动触发一次过去 1 天的回拉
curl -X POST http://localhost:4004/api/admin/meituan/backfill \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"since":"2026-05-26T00:00:00Z","until":"2026-05-26T23:59:59Z"}'

# 等 30s, 看 health
curl http://localhost:4004/api/admin/meituan/health -H "Authorization: Bearer $TOKEN" | jq

# 看真数据
psql -c "SELECT mt_order_id, payed, processed FROM mt_orders ORDER BY created_at DESC LIMIT 5;"
psql -c "SELECT * FROM revenue_records WHERE source='meituan' ORDER BY date DESC LIMIT 5;"
```

成功标志：
- `health.stats24h.errorRate == 0`
- `mt_orders` 有真订单
- `revenue_records` 有 `source='meituan'` 的行
- `health.unprocessedOrders == 0`

### 1.5 切生产

沙箱跑通后：
1. 把 `MEITUAN_ORG_ID` 改成生产值
2. `MEITUAN_BOOTSTRAP_AUTH_TOKEN` 改成生产 token
3. `pm2 reload dianjie-v4-api --update-env`
4. cron 自动接管

---

## 2. 日常运维

### 2.1 健康检查端点

```bash
curl http://localhost:4004/api/admin/meituan/health -H "Authorization: Bearer $TOKEN" | jq
```

返回示例：
```json
{
  "enabled": true,
  "mode": "real",
  "lastSync": { "createdAt": "2026-05-27T16:00:00Z", ... },
  "cursor": { "lastSyncedAt": "...", "consecutiveFailures": 0 },
  "stats24h": { "totalCalls": 24, "successCalls": 23, "failedCalls": 1, "errorRate": 0.042 },
  "topErrors7d": [{ "code": "OP_LIMITATION_REJECT", "count": 3 }],
  "unprocessedOrders": 0,
  "tokenStatus": "valid"
}
```

关注：
- `lastSync.createdAt`：是否 < 90 分钟前 (正常); > 180 分钟 → 红
- `stats24h.errorRate`：< 5% (绿); 5-30% (黄); > 30% (红)
- `unprocessedOrders`：> 100 长期不降 → processor 有 bug, 查 processError 字段
- `tokenStatus`：`valid` / `expiring` / `expired` / `not-seeded`

### 2.2 查看 sync cron 日志

```bash
ssh ECS
pm2 logs dianjie-v4-api --lines 100 | grep meituan
```

正常日志：
```
⏰ [meituan-cron-hourly] correlationId=clxx...
✅ instore: 12 orders / 1 pages / 1234ms
✅ reverse: 0 refunds / 1 pages
✅ processed: 12 / skipped-nostore: 0 / errors: 0
```

### 2.3 手动触发同步

```bash
curl -X POST http://localhost:4004/api/admin/meituan/sync \
  -H "Authorization: Bearer $TOKEN"
```

### 2.4 历史数据回拉

```bash
curl -X POST http://localhost:4004/api/admin/meituan/backfill \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"since":"2026-04-01T00:00:00Z","until":"2026-04-30T23:59:59Z"}'
```

约束：
- since 不能早于 365 天前
- until 不能晚于现在 +24h
- 单次跨度 ≤ 90 天 (内部按 31 天切片调美团)

---

## 3. 应急 / 故障排查

### 3.1 紧急停掉同步

```bash
# 方式 1: 改 env 重启
ssh ECS
sed -i 's/MEITUAN_ENABLED=true/MEITUAN_ENABLED=false/' /app/dianjie-v4/.env
pm2 reload dianjie-v4-api --update-env
```

cron 立即停止。`mt_orders` 表保留所有已落数据，无任何破坏。

### 3.2 同步失败 → 提工单

```bash
# 找最近的 P0 失败
curl "http://localhost:4004/api/admin/meituan/calls?severity=P0&limit=5" \
  -H "Authorization: Bearer $TOKEN" | jq

# 拿 callId 后生成工单 markdown
CALL_ID=clxxxabc
curl "http://localhost:4004/api/admin/meituan/calls/$CALL_ID/ticket-template" \
  -H "Authorization: Bearer $TOKEN" > ticket.md

# 加备注
curl -X PATCH "http://localhost:4004/api/admin/meituan/calls/$CALL_ID/note" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"note":"凭证到位后第 3 天突然全部 OP_UNIAUTH_FAILED, refresh 也失败"}'

# 再次导出 (这次含 note)
curl "http://localhost:4004/api/admin/meituan/calls/$CALL_ID/ticket-template" \
  -H "Authorization: Bearer $TOKEN" > ticket-with-note.md

# 把 ticket-with-note.md 内容粘到美团 TT 工单 或 mtdeveloper@meituan.com 邮件
```

### 3.3 数据回滚

清除某天的 meituan 数据：

```sql
-- 找出受影响的 mt_order
SELECT mt_order_id, business_time, processed_amount FROM mt_orders
WHERE business_time = '2026-05-27';

-- 删除 mt_orders 行 (级联 items + payments via CASCADE)
DELETE FROM mt_orders WHERE business_time = '2026-05-27';

-- 删除当天的 revenue_records (meituan 来源)
DELETE FROM revenue_records WHERE source = 'meituan' AND date = '2026-05-27';

-- 重新 backfill
curl -X POST .../backfill -d '{"since":"2026-05-27T00:00:00Z","until":"2026-05-27T23:59:59Z"}'
```

### 3.4 替换被 meituan 覆盖的 manual revenue

如果客户某天 manual 录入后被 meituan sync 覆盖, 原值在 `rawData.replacedManual` 里：

```sql
SELECT date,
       amount as current_meituan,
       (raw_data->'replacedManual'->>'previousAmount')::float as previous_manual,
       raw_data->'replacedManual'->>'replacedAt' as overwritten_at
FROM revenue_records
WHERE raw_data->'replacedManual' IS NOT NULL
ORDER BY date DESC;
```

### 3.5 单调失败 replay

某条 callLog 失败可以重放 (用相同 biz 参数, 重新签名+调用)：

```bash
curl -X POST "http://localhost:4004/api/admin/meituan/calls/$CALL_ID/replay" \
  -H "Authorization: Bearer $TOKEN"
```

只对 `mode='real'` 的 callLog 有效, mock 不能 replay.

---

## 4. 长期维护清单

| 触发 | 动作 |
|---|---|
| 撞到字典外的错误码 (callLog.errorMessage 含 "未知错误码") | 查文档 + 加入 errors.ts + 更新 MEITUAN_ERROR_CODES.md |
| `tokenStatus` 变成 `expiring` | 提前手动 trigger refresh, 或人工换 token |
| `consecutiveFailures > 5` | 排查美团接口状态, 必要时提工单 |
| `unprocessedOrders > 1000 持续 1 天` | 检查 processor.ts 是否有 bug; storeId 映射是否丢 |
| 1 个月后 | 评估 `revenue.ts` 手工录入路由是否下线 |
