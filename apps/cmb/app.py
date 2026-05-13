"""
滇界云管 · 招商银行免前置 HTTP 微服务
端口：5001（由 PM2 管理，进程名 dianjie-cmb）

职责：封装招行国密签名/加密/通信，供 Node.js API 通过 HTTP 调用。
外部只暴露两个接口：
  POST /transfer  → 向供应商发起转账
  POST /query     → 查询转账结果
  GET  /health    → 健康检查
"""

import json
import os
import random
from datetime import datetime, timezone, timedelta

from flask import Flask, request, jsonify

import dchelper as dchelper_module

# ── 招行时间工具 ───────────────────────────────────────────
CST = timezone(timedelta(hours=8))

def _now_cst():
    return datetime.now(tz=CST)

def _reqid():
    return _now_cst().strftime("%Y%m%d%H%M%S%f")[:-3] + str(random.randint(1000000, 9999999))

def _sigtim():
    return _now_cst().strftime("%Y%m%d%H%M%S")

# ── 配置（从环境变量读取，本地开发用默认测试值）─────────────
USE_PROD        = os.getenv("CMB_USE_PROD", "false").lower() == "true"

URL_TEST        = "http://cdctest.cmburl.cn/cdcserver/api/v2"
URL_PROD        = "https://cdc.cmbchina.com/cdcserver/api/v2"
URL             = os.getenv("CMB_URL", URL_PROD if USE_PROD else URL_TEST)

BANK_PK_TEST    = "BNsIe9U0x8IeSe4h/dxUzVEz9pie0hDSfMRINRXc7s1UIXfkExnYECF4QqJ2SnHxLv3z/99gsfDQrQ6dzN5lZj0="
BANK_PK_PROD    = "BEynMEZOjNpwZIiD9jXtZSGr3Ecpwn7r+m+wtafXHb6VIZTnugfuxhcKASq3hX+KX9JlHODDl9/RDKQv4XLOFak="
BANK_PUBLIC_KEY = os.getenv("CMB_BANK_PUBLIC_KEY", BANK_PK_PROD if USE_PROD else BANK_PK_TEST)

UID         = os.getenv("CMB_UID",         "U005182425")
PRIVATE_KEY = os.getenv("CMB_PRIVATE_KEY", "NBtl7WnuUtA2v5FaebEkU0/Jj1IodLGT6lQqwkzmd2E=")
PUBLIC_KEY  = os.getenv("CMB_PUBLIC_KEY",  "BGN0+JR7IIs/KKLfrseFEPhYvButN/A4uVkDl1yWNr64WWU/sUVyfQLWXNaPICq8L/k+7OpHex3IH09lBiG4np0=")
SYM_KEY     = os.getenv("CMB_SYM_KEY",     "VuAzSWQhsoNqzn0K").encode("utf-8")
ACCOUNT     = os.getenv("CMB_ACCOUNT",     "655905978110000")   # 付款结算账户
MODNBR      = os.getenv("CMB_MODNBR",      "000002")            # 支付业务模式号

# ── 初始化 DcHelper ───────────────────────────────────────
_helper = dchelper_module.DcHelper(URL, UID, PRIVATE_KEY, PUBLIC_KEY, BANK_PUBLIC_KEY, SYM_KEY)

# ── 发送封装 ──────────────────────────────────────────────
def _call(funcode: str, body: dict) -> dict:
    payload = {
        "request": {
            "head": {"funcode": funcode, "userid": UID, "reqid": _reqid()},
            "body": body,
        },
        "signature": {"sigtim": _sigtim(), "sigdat": "__signature_sigdat__"},
    }
    resp_str = _helper.send_request(json.dumps(payload, ensure_ascii=False), funcode)
    return json.loads(resp_str)

# ── Flask 应用 ────────────────────────────────────────────
app = Flask(__name__)

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "env": "prod" if USE_PROD else "test",
        "uid": UID,
        "account": ACCOUNT,
    })


@app.route("/transfer", methods=["POST"])
def transfer():
    """
    向供应商发起转账。

    请求体：
    {
      "toAccount":  "收款账号",
      "toName":     "收款户名",
      "amount":     "金额字符串，如 '1000.00'",
      "bizNo":      "业务参考号（全局唯一，来自 scheduleId）",
      "remark":     "附言（可选）",
      "bankCode":   "收款行行号（他行必填）",
      "bankCity":   "收款开户地（他行必填）"
    }

    响应体：
    {
      "success":    true/false,
      "resultCode": "SUC0000 或错误码",
      "resultMsg":  "描述",
      "txNo":       "银行流水号（成功时）",
      "raw":        { ...完整银行响应 }
    }
    """
    data = request.get_json(force=True)
    to_account = data.get("toAccount", "")
    to_name    = data.get("toName", "")
    amount     = str(data.get("amount", ""))
    biz_no     = data.get("bizNo", "")
    remark     = data.get("remark", "")
    bank_code  = data.get("bankCode", "")
    bank_city  = data.get("bankCity", "")

    if not all([to_account, to_name, amount, biz_no]):
        return jsonify({"success": False, "resultCode": "PARAM_ERROR", "resultMsg": "缺少必填参数"}), 400

    body = {
        "modnbr": MODNBR,
        "refext": biz_no,       # 业务参考号（唯一，防重复）
        "sndeac": ACCOUNT,      # 付款账号
        "rcveac": to_account,   # 收款账号
        "rcvean": to_name,      # 收款户名
        "trsamt": amount,       # 金额
        "ccynbr": "RMB",
        "rpynar": remark,
    }
    if bank_code:
        body["rcvbnk"] = bank_code
    if bank_city:
        body["rcvcty"] = bank_city

    try:
        result = _call("DCPAYOPR", body)
        head = result.get("response", {}).get("head", {})
        resp_body = result.get("response", {}).get("body", {})

        success = head.get("resultcode") == "SUC0000"
        # 银行受理成功时返回 rspid 作为流水号
        tx_no = head.get("rspid", "")

        return jsonify({
            "success":    success,
            "resultCode": head.get("resultcode", ""),
            "resultMsg":  head.get("resultmsg", ""),
            "txNo":       tx_no,
            "raw":        result,
        })

    except Exception as e:
        return jsonify({
            "success":    False,
            "resultCode": "CMB_ERROR",
            "resultMsg":  str(e),
        }), 500


@app.route("/query", methods=["POST"])
def query():
    """
    查询付款结果。

    请求体：{ "bizNo": "发起付款时的业务参考号" }
    """
    data   = request.get_json(force=True)
    biz_no = data.get("bizNo", "")
    if not biz_no:
        return jsonify({"success": False, "resultMsg": "缺少 bizNo"}), 400

    try:
        result = _call("DCPAYQRY", {"sndeac": ACCOUNT, "refext": biz_no})
        head   = result.get("response", {}).get("head", {})
        body   = result.get("response", {}).get("body", {})
        return jsonify({
            "success":    head.get("resultcode") == "SUC0000",
            "resultCode": head.get("resultcode", ""),
            "resultMsg":  head.get("resultmsg", ""),
            "payStatus":  body.get("trssta", ""),   # 转账状态
            "raw":        result,
        })
    except Exception as e:
        return jsonify({"success": False, "resultMsg": str(e)}), 500


if __name__ == "__main__":
    port = int(os.getenv("CMB_SERVICE_PORT", "5001"))
    print(f"🏦 招行微服务启动 port={port} env={'prod' if USE_PROD else 'test'}")
    app.run(host="0.0.0.0", port=port, debug=False)
