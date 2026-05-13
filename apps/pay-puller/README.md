# dianjie-pay-puller

收款渠道拉单微服务 (Sprint B 骨架版本)。

## 状态
**当前为 stub** — 接口契约已稳定,真实拉单逻辑(微信支付 V3 / 支付宝)待用户提供商户号 + 证书后接通。

## 端口
- `5002` (与 cmb 5001 区分)

## 启动 (开发)
```bash
cd apps/pay-puller
pip install -r requirements.txt
PORT=5002 python3 app.py
```

## 启动 (生产, ECS)
```bash
pm2 start app.py --interpreter python3 --name dianjie-pay-puller --update-env -- 
```

## 接口

### `GET /health`
健康检查。

### `POST /pull/wechat`
手动触发某店某日拉微信支付对账单。
```json
{ "storeId": "abc", "date": "2026-04-29", "mchid": "1234567890", "apiV3Key": "..." }
```

### `POST /pull/alipay`
同上,支付宝。
```json
{ "storeId": "abc", "date": "2026-04-29", "appId": "...", "privateKey": "..." }
```

### `GET /cron/daily`
每日 1:00 cron 触发,扫所有 `autoSyncRevenue=true` 的店,并发拉昨日对账单。

## Node.js 端需新增的 endpoint(待 Sprint B-2 实现)

### `GET /api/internal/stores-with-pay-config`
仅 internal token 可访问,返回所有开启自动同步的店 + 解密后的 mchid/apiV3Key/appId/privateKey。

### `PUT /api/revenue/auto-sync`
被 pay-puller 调用,upsert RevenueRecord:
```json
{ "storeId":"...", "date":"YYYY-MM-DD",
  "channel":"wechatMini"|"alipay",
  "gmv":1234.56, "net":1227.16,
  "sourceId":"weixin-bill-..." }
```
逻辑: 找到该 store + date 的 RevenueRecord (没有则建),设置 `rawData.channels[channel] = gmv`,
更新 `source = 'auto_sync'`, 累加 `amount = sum(channels)`。

## 待办 (接真)
- [ ] 微信支付 V3:RSA SHA256 签名 + AEAD-AES-256-GCM 解密 CSV
- [ ] 支付宝:RSA2048 签名
- [ ] 错误重试 (指数退避)
- [ ] 平台证书自动更新
- [ ] 加密商户密钥 (从 Node.js DB 读取后, KMS / aes-256-gcm 解密再用)
