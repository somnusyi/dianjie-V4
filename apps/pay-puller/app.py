"""
滇界云管 · 收款渠道拉单微服务
端口: 5002 (PM2 进程名 dianjie-pay-puller)

职责: 每日凌晨从微信支付 V3 / 支付宝 拉前一天对账单, 写入 RevenueRecord
对外接口:
  POST /pull/wechat   { storeId, date, mchid, apiV3Key }   立即拉某店某日
  POST /pull/alipay   { storeId, date, appId, privateKey }
  POST /webhook/wechat-paid   微信支付成功通知 (实时, 可选)
  GET  /health
  GET  /cron/daily   每日 cron 触发(扫所有 autoSyncRevenue=true 的 store, 并发拉)

设计参考 apps/cmb/app.py 的接口约定:
  - Node.js API 用 HTTP 调用本服务
  - 不直连数据库, 拉到的明细 POST 回 Node.js: PUT /api/revenue/auto-sync
  - 本服务无状态, 可水平扩展

部署 (后续):
  pm2 start app.py --interpreter python3 --name dianjie-pay-puller
"""
import os
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional

from flask import Flask, request, jsonify
import requests

CST = timezone(timedelta(hours=8))

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format='[pay-puller] %(asctime)s %(levelname)s %(message)s')
log = logging.getLogger()

# ── 配置 ───────────────────────────────────────────────────
NODE_API_BASE = os.getenv('NODE_API_BASE', 'http://127.0.0.1:4000')
INTERNAL_TOKEN = os.getenv('PAY_PULLER_INTERNAL_TOKEN', 'dev-token-change-me')


# ── 微信支付 V3 拉对账单 ──────────────────────────────────
class WechatPayClient:
    """
    最小可用版本 · 真实环境需补:
      - 加载商户私钥/证书序列号
      - 请求签名 (RSA SHA256)
      - 平台证书自动更新
    当前先做接口约定 + mock 数据返回, 等用户拿到商户号后接通信
    """
    def __init__(self, mchid: str, api_v3_key: str):
        self.mchid = mchid
        self.api_v3_key = api_v3_key

    def fetch_trade_bill(self, bill_date: str) -> Dict[str, Any]:
        """
        拉指定日期的交易账单.
        正式接口: GET https://api.mch.weixin.qq.com/v3/bill/tradebill?bill_date=YYYY-MM-DD&bill_type=ALL
        响应是 download_url, 需要二次下载 + AEAD-AES-256-GCM 解密.

        当前 stub 返回零数据, 提示需要 真实商户号 + 证书才能联调.
        """
        # TODO 真实实现:
        # 1. 构造 Authorization 头 (RSA SHA256 签名)
        # 2. GET /v3/bill/tradebill 拿 download_url
        # 3. GET download_url 拿到 gzip 加密 CSV
        # 4. 解密 + 解析 → 按交易类型/状态聚合
        log.warning(f'[wechat] 当前为 stub 实现, mchid={self.mchid} bill_date={bill_date}')
        return {
            'mchid': self.mchid,
            'bill_date': bill_date,
            'totalGmv': 0,
            'totalNet': 0,                 # GMV - 通道费 0.6%
            'transactionCount': 0,
            'note': 'STUB · 待商户号 + 证书配置后接真',
        }


# ── 支付宝拉对账单 ────────────────────────────────────────
class AlipayClient:
    def __init__(self, app_id: str, private_key: str):
        self.app_id = app_id
        self.private_key = private_key

    def fetch_trade_bill(self, bill_date: str) -> Dict[str, Any]:
        """
        正式接口: alipay.data.dataservice.bill.downloadurl.query  bill_type=trade
        """
        log.warning(f'[alipay] stub, app_id={self.app_id} bill_date={bill_date}')
        return {
            'appId': self.app_id,
            'bill_date': bill_date,
            'totalGmv': 0,
            'totalNet': 0,
            'transactionCount': 0,
            'note': 'STUB · 待 appId + 私钥配置后接真',
        }


# ── 推送结果回 Node.js API ────────────────────────────────
def push_to_node(store_id: str, date: str, channel: str, gmv: float, net: float, source_id: Optional[str] = None) -> bool:
    """
    Node.js 端需新增 endpoint:
      PUT /api/revenue/auto-sync
        Headers: X-Internal-Token: <PAY_PULLER_INTERNAL_TOKEN>
        Body: { storeId, date, channel: 'wechatMini'|'alipay', gmv, net, sourceId }
      逻辑: upsert RevenueRecord, 在 rawData.channels 里设置对应字段
    """
    url = f'{NODE_API_BASE}/api/revenue/auto-sync'
    payload = {
        'storeId': store_id, 'date': date,
        'channel': channel, 'gmv': gmv, 'net': net,
        'sourceId': source_id,
    }
    try:
        r = requests.put(url, json=payload, headers={
            'X-Internal-Token': INTERNAL_TOKEN,
            'Content-Type': 'application/json',
        }, timeout=10)
        if r.status_code >= 400:
            log.error(f'push_to_node failed {r.status_code}: {r.text[:200]}')
            return False
        return True
    except Exception as e:
        log.exception(f'push_to_node error: {e}')
        return False


# ── HTTP 接口 ─────────────────────────────────────────────
@app.get('/health')
def health():
    return jsonify({
        'status': 'ok',
        'service': 'pay-puller',
        'version': '0.1.0',
        'channels': ['wechat (stub)', 'alipay (stub)'],
        'note': '当前为骨架版本 · 待真实商户号配置后接通',
    })


@app.post('/pull/wechat')
def pull_wechat():
    """手动触发某店某日拉单. body: { storeId, date, mchid, apiV3Key }"""
    body = request.get_json(force=True) or {}
    required = ['storeId', 'date', 'mchid', 'apiV3Key']
    miss = [k for k in required if not body.get(k)]
    if miss: return jsonify({'error': f'missing: {miss}'}), 400

    client = WechatPayClient(body['mchid'], body['apiV3Key'])
    bill = client.fetch_trade_bill(body['date'])
    pushed = push_to_node(body['storeId'], body['date'], 'wechatMini', bill['totalGmv'], bill['totalNet'])
    return jsonify({'bill': bill, 'pushed': pushed})


@app.post('/pull/alipay')
def pull_alipay():
    """手动触发某店某日拉单. body: { storeId, date, appId, privateKey }"""
    body = request.get_json(force=True) or {}
    required = ['storeId', 'date', 'appId', 'privateKey']
    miss = [k for k in required if not body.get(k)]
    if miss: return jsonify({'error': f'missing: {miss}'}), 400

    client = AlipayClient(body['appId'], body['privateKey'])
    bill = client.fetch_trade_bill(body['date'])
    pushed = push_to_node(body['storeId'], body['date'], 'alipay', bill['totalGmv'], bill['totalNet'])
    return jsonify({'bill': bill, 'pushed': pushed})


###################################################
# Webhook 入站 (实时推送)
###################################################
# 三类: 聚合(收钱吧) / 美团核销 / 抖音核销
# 每个 vendor 签名验证不同, 这里仅做接口契约 + 转发到 Node.js
###################################################

@app.post('/webhook/qianqian')
def webhook_qianqian():
    """
    收钱吧支付成功通知 (秒级实时)
    收钱吧文档: https://doc.shouqianba.com/
    Headers 含签名, body 含 sn / status / total_amount / store_id 等
    """
    # TODO 真实接入: 验证 X-SQB-Sign, 防重放
    body = request.get_json(force=True) or {}
    if body.get('status') != 'PAID':
        return jsonify({'ok': True, 'ignored': True})
    store_id = body.get('store_id')   # 我们 Store.aggregatorMerchantId 反查
    amount = float(body.get('total_amount', 0)) / 100  # 分→元
    if not store_id or amount <= 0:
        return jsonify({'error': 'invalid'}), 400
    # 推送到 Node.js: 实时增量营业额
    push_realtime(store_id_aggregator=store_id, channel='aggregator', amount=amount,
                  paidAt=body.get('finish_time'), txId=body.get('sn'))
    return jsonify({'ok': True})


@app.post('/webhook/meituan-verify')
def webhook_meituan_verify():
    """
    美团团购券核销实时通知
    需先入驻美团开放平台 (https://open.meituan.com/) 配置回调
    body: { shop_id, deal_id, voucher_code, verify_amount, verify_time }
    """
    body = request.get_json(force=True) or {}
    shop_id = body.get('shop_id')
    amount = float(body.get('verify_amount', 0))
    if not shop_id or amount <= 0:
        return jsonify({'error': 'invalid'}), 400
    push_realtime(meituan_shop_id=shop_id, channel='meituanVerify', amount=amount,
                  paidAt=body.get('verify_time'), txId=body.get('voucher_code'))
    return jsonify({'ok': True})


@app.post('/webhook/douyin-verify')
def webhook_douyin_verify():
    """
    抖音生活服务券核销实时通知
    """
    body = request.get_json(force=True) or {}
    shop_id = body.get('poi_id') or body.get('shop_id')
    amount = float(body.get('verify_amount', 0))
    if not shop_id or amount <= 0:
        return jsonify({'error': 'invalid'}), 400
    push_realtime(douyin_shop_id=shop_id, channel='douyinVerify', amount=amount,
                  paidAt=body.get('verify_time'), txId=body.get('voucher_code'))
    return jsonify({'ok': True})


def push_realtime(store_id_aggregator=None, meituan_shop_id=None, douyin_shop_id=None,
                  channel: str = '', amount: float = 0, paidAt=None, txId=None):
    """
    Node.js 端待加 endpoint:
      POST /api/internal/realtime-revenue
        Headers: X-Internal-Token
        Body: { aggregatorMerchantId? meituanShopId? douyinShopId?, channel, amount, paidAt, txId }
      逻辑:
        1. 反查 Store (按对应 ID 字段)
        2. 当日 RevenueRecord upsert: rawData.channels[channel] += amount
        3. 通过 SSE / WebSocket 推老板 home 实时刷 Hero
    """
    payload = {
        'aggregatorMerchantId': store_id_aggregator,
        'meituanShopId': meituan_shop_id,
        'douyinShopId': douyin_shop_id,
        'channel': channel, 'amount': amount,
        'paidAt': paidAt, 'txId': txId,
    }
    try:
        requests.post(
            f'{NODE_API_BASE}/api/internal/realtime-revenue',
            json=payload,
            headers={'X-Internal-Token': INTERNAL_TOKEN},
            timeout=5,
        )
    except Exception as e:
        log.exception(f'push_realtime failed: {e}')


@app.get('/cron/daily')
def cron_daily():
    """
    每日凌晨 1:00 由 cron / pm2 cron 调用.
    流程:
      1. GET Node.js: /api/internal/stores-with-pay-config (X-Internal-Token)
         → 返回所有 autoSyncRevenue=true 的店 + 解密后的 mchid/apiV3Key/appId/privateKey
      2. 对每店每渠道并发拉前一天对账单
      3. 推回 push_to_node
    """
    yesterday = (datetime.now(tz=CST) - timedelta(days=1)).strftime('%Y-%m-%d')
    try:
        r = requests.get(
            f'{NODE_API_BASE}/api/internal/stores-with-pay-config',
            headers={'X-Internal-Token': INTERNAL_TOKEN},
            timeout=15,
        )
        if r.status_code != 200:
            return jsonify({'error': f'stores fetch failed {r.status_code}'}), 500
        stores = r.json()
    except Exception as e:
        return jsonify({'error': f'stores fetch error: {e}'}), 500

    results = []
    for s in stores:
        sid = s['id']
        if s.get('wechatMerchantId') and s.get('wechatApiV3Key'):
            client = WechatPayClient(s['wechatMerchantId'], s['wechatApiV3Key'])
            bill = client.fetch_trade_bill(yesterday)
            pushed = push_to_node(sid, yesterday, 'wechatMini', bill['totalGmv'], bill['totalNet'])
            results.append({'store': sid, 'channel': 'wechat', 'gmv': bill['totalGmv'], 'pushed': pushed})
        if s.get('alipayAppId') and s.get('alipayPrivateKey'):
            client = AlipayClient(s['alipayAppId'], s['alipayPrivateKey'])
            bill = client.fetch_trade_bill(yesterday)
            pushed = push_to_node(sid, yesterday, 'alipay', bill['totalGmv'], bill['totalNet'])
            results.append({'store': sid, 'channel': 'alipay', 'gmv': bill['totalGmv'], 'pushed': pushed})

    return jsonify({'date': yesterday, 'results': results, 'total': len(results)})


if __name__ == '__main__':
    port = int(os.getenv('PORT', '5002'))
    log.info(f'pay-puller starting on :{port}')
    app.run(host='0.0.0.0', port=port, debug=False)
