"""
滇界云管 · 招商银行免前置 HTTP 微服务
端口：5001（由 PM2 管理，进程名 dianjie-cmb）

职责：封装招行国密签名/加密/通信，供 Node.js API 通过 HTTP 调用。
对外接口：
  POST /transfer  → 向供应商发起转账（同行 / 跨行）
  POST /query     → 查询付款记录
  GET  /health    → 健康检查

报文规范基准：docs/cmb/2026-05-13-招行BB1PAY-报文规范.md
funcode: BB1PAYOP（付款经办）/ BB1PAYQR（付款查询）  ← 2026-04-15 通过版
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
    """24 位：yyyymmddHHMMSSmmm (17) + 7 位随机 = 24 字符"""
    return _now_cst().strftime("%Y%m%d%H%M%S%f")[:-3] + str(random.randint(1000000, 9999999))

def _sigtim():
    return _now_cst().strftime("%Y%m%d%H%M%S")

def _today():
    """yyyymmdd，BB1PAYQR 默认查当天用"""
    return _now_cst().strftime("%Y%m%d")

# ── 配置（环境变量为主，默认值为本地测试值）─────────────
USE_PROD        = os.getenv("CMB_USE_PROD", "false").lower() == "true"

URL_TEST        = "http://cdctest.cmburl.cn/cdcserver/api/v2"
URL_PROD        = "https://cdc.cmbchina.com/cdcserver/api/v2"
URL             = os.getenv("CMB_URL", URL_PROD if USE_PROD else URL_TEST)

# 测试 / 生产 银行 SM2 公钥不同（xlsx + 云洱密钥.txt 已下发）
BANK_PK_TEST    = "BNsIe9U0x8IeSe4h/dxUzVEz9pie0hDSfMRINRXc7s1UIXfkExnYECF4QqJ2SnHxLv3z/99gsfDQrQ6dzN5lZj0="
BANK_PK_PROD    = "BEynMEZOjNpwZIiD9jXtZSGr3Ecpwn7r+m+wtafXHb6VIZTnugfuxhcKASq3hX+KX9JlHODDl9/RDKQv4XLOFak="
BANK_PUBLIC_KEY = os.getenv("CMB_BANK_PUBLIC_KEY", BANK_PK_PROD if USE_PROD else BANK_PK_TEST)

UID         = os.getenv("CMB_UID",         "U005182425")
PRIVATE_KEY = os.getenv("CMB_PRIVATE_KEY", "NBtl7WnuUtA2v5FaebEkU0/Jj1IodLGT6lQqwkzmd2E=")
PUBLIC_KEY  = os.getenv("CMB_PUBLIC_KEY",  "BGN0+JR7IIs/KKLfrseFEPhYvButN/A4uVkDl1yWNr64WWU/sUVyfQLWXNaPICq8L/k+7OpHex3IH09lBiG4np0=")
SYM_KEY     = os.getenv("CMB_SYM_KEY",     "VuAzSWQhsoNqzn0K").encode("utf-8")
ACCOUNT     = os.getenv("CMB_ACCOUNT",     "655905978110000")   # 付款结算账户

# 业务模式（BB1PAYOP 用，规范 §3.1 / §3.3）
# busMod: S100B = 支付自动标准模式（4/15 报告 §5.1 + §5.3 通过版用的就是这套）
# busCod: N02030 = 企银支付经办（无审批）
BUSMOD      = os.getenv("CMB_BUSMOD",      "S100B")
BUSCOD      = os.getenv("CMB_BUSCOD",      "N02030")

# 货币码（招行码表，10 = RMB）
CCY_NBR     = os.getenv("CMB_CCY_NBR",     "10")

# ── 初始化 DcHelper ───────────────────────────────────────
_helper = dchelper_module.DcHelper(URL, UID, PRIVATE_KEY, PUBLIC_KEY, BANK_PUBLIC_KEY, SYM_KEY)


# ── 限流（WARN-4 · xlsx 注意事项 §3）─────────────────────
# 同 account+funcode 在 _RATE_LIMIT_SEC 内只能调一次。账务查询 / 交易管家强制 10s。
# 拒绝时返 RATE_LIMITED 错码（不静默等待，让调用方决定是否重试）。
import threading
_RATE_LIMIT_SEC = float(os.getenv("CMB_RATE_LIMIT_SEC", "10"))
_RATE_LIMITED_FUNCODES = {"NTQACINF", "trsQryByBreakPoint", "DCSIGREC", "BB1PAYQR"}
_rate_last_call: dict = {}      # key = "funcode:account" → unix ts
_rate_lock = threading.Lock()

def _check_rate_limit(funcode: str, account: str) -> tuple[bool, float]:
    """
    返回 (允许?, 还需等待秒数)。仅对查询类 funcode 生效，付款类 BB1PAYOP 不限流。
    """
    if funcode not in _RATE_LIMITED_FUNCODES:
        return True, 0.0
    import time
    key = f"{funcode}:{account}"
    now = time.monotonic()
    with _rate_lock:
        last = _rate_last_call.get(key)
        if last is not None and (now - last) < _RATE_LIMIT_SEC:
            return False, _RATE_LIMIT_SEC - (now - last)
        _rate_last_call[key] = now
    return True, 0.0


class RateLimited(Exception):
    """限流异常：endpoint 应捕获并返 HTTP 429"""
    def __init__(self, funcode: str, account: str, wait_s: float):
        self.funcode = funcode
        self.account = account
        self.wait_s  = wait_s
        super().__init__(f"RATE_LIMITED: {funcode} on {account} 需再等 {wait_s:.1f}s")


def _rate_limited_response(e: RateLimited):
    """统一构造限流响应"""
    return jsonify({
        "success":    False,
        "resultCode": "RATE_LIMITED",
        "resultMsg":  f"招行同账号 10s/次限流，{e.funcode} 还需等 {e.wait_s:.1f}s",
        "waitSec":    round(e.wait_s, 1),
    }), 429


# ── 发送封装 ──────────────────────────────────────────────
def _call(funcode: str, body: dict, *, rate_key_account: str | None = None) -> dict:
    """统一组装外层 head/body/signature + 调 dchelper 加密发包 + 解析响应。

    rate_key_account: 限流维度的账号（默认 ACCOUNT）。BB1PAYQR/NTQACINF/DCSIGREC/
        trsQryByBreakPoint 都按 (funcode, account) 维度限流 10s；
        BB1PAYOP 不限流（付款经办无 10s 约束）。
    """
    acct = rate_key_account or ACCOUNT
    ok, wait_s = _check_rate_limit(funcode, acct)
    if not ok:
        raise RateLimited(funcode, acct, wait_s)

    payload = {
        "request": {
            "head": {"funcode": funcode, "userid": UID, "reqid": _reqid()},
            "body": body,
        },
        "signature": {"sigtim": _sigtim(), "sigdat": "__signature_sigdat__"},
    }
    resp_str = _helper.send_request(json.dumps(payload, ensure_ascii=False), funcode)
    return json.loads(resp_str)


# ── 启动期 self-check · DCLISMOD（WARN-1）────────────────
def _self_check_busmod() -> None:
    """
    启动时调 DCLISMOD 拿当前 UID 可用的业务模式列表，验证 BUSMOD/BUSCOD 命中。
    失败不阻断启动（容忍网络抖动），仅日志告警。
    """
    print(f"🔍 self-check: DCLISMOD busCod={BUSCOD} ...", flush=True)
    try:
        # DCLISMOD 不限流（启动期手工调一次，绕过 limiter）
        body = {"buscod": BUSCOD}
        payload = {
            "request": {
                "head": {"funcode": "DCLISMOD", "userid": UID, "reqid": _reqid()},
                "body": body,
            },
            "signature": {"sigtim": _sigtim(), "sigdat": "__signature_sigdat__"},
        }
        resp = json.loads(_helper.send_request(json.dumps(payload, ensure_ascii=False), "DCLISMOD"))
        head = (resp.get("response") or {}).get("head", {}) or {}
        body_ = (resp.get("response") or {}).get("body", {}) or {}
        if head.get("resultcode") != "SUC0000":
            print(f"⚠️  DCLISMOD self-check 失败 resultcode={head.get('resultcode')} msg={head.get('resultmsg')}")
            return

        modes = body_.get("ntqmdlstz") or []
        available = [m.get("busmod") for m in modes]
        print(f"   可用 busMod: {available}")
        if BUSMOD in available:
            print(f"✅ self-check OK · 当前 CMB_BUSMOD={BUSMOD} 命中银行下发列表")
        else:
            print(f"❌ self-check WARN · 当前 CMB_BUSMOD={BUSMOD} 不在银行返回列表 {available}")
            print(f"   付款经办 BB1PAYOP 可能会失败，请联系招行确认或改 .env CMB_BUSMOD")
    except Exception as e:
        print(f"⚠️  DCLISMOD self-check 异常（不阻断启动）: {e}")


# ── Flask 应用 ────────────────────────────────────────────
app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status":  "ok",
        "env":     "prod" if USE_PROD else "test",
        "url":     URL,
        "uid":     UID,
        "account": ACCOUNT,
        "busMod":  BUSMOD,
        "busCod":  BUSCOD,
    })


@app.route("/transfer", methods=["POST"])
def transfer():
    """
    向供应商发起转账 · BB1PAYOP（规范 §3.3）

    请求体（与 cmbPayment.ts CmbTransferParams 对齐，向前兼容旧调用）：
    {
      "toAccount":  "收款账号",
      "toName":     "收款户名",
      "amount":     "金额字符串，如 '0.01'",
      "bizNo":      "业务参考号（= scheduleId，全局唯一，重发必须同值）",
      "remark":     "附言（可选）",
      "bankCode":   "收款行联行号（跨行必填，传值即视为跨行）",
      "bankCity":   "收款开户地（跨行必填，默认值 北京市）",
      "bankName":   "收款行名（跨行建议传，未传则用 bankCode 兜底）"
    }

    响应体（与 cmbPayment.ts CmbTransferResult 对齐）：
    {
      "success":    true/false,
      "resultCode": "SUC0000 / 错误码",
      "resultMsg":  "...",
      "txNo":       "银行业务流水号 bakAppNbr（成功时）",
      "raw":        { ...完整银行响应（含 reqSts / reqNbr） }
    }
    """
    data = request.get_json(force=True)
    to_account = (data.get("toAccount") or "").strip()
    to_name    = (data.get("toName") or "").strip()
    amount     = str(data.get("amount") or "").strip()
    biz_no     = (data.get("bizNo") or "").strip()
    remark     = (data.get("remark") or "").strip()
    bank_code  = (data.get("bankCode") or "").strip()
    bank_city  = (data.get("bankCity") or "").strip()
    bank_name  = (data.get("bankName") or "").strip()

    if not all([to_account, to_name, amount, biz_no]):
        return jsonify({
            "success": False, "resultCode": "PARAM_ERROR",
            "resultMsg": "缺少必填参数 toAccount/toName/amount/bizNo"
        }), 400

    # 跨行检测：传了 bankCode 视为跨行
    is_cross_bank = bool(bank_code)

    pay_item = {
        "ccyNbr": CCY_NBR,           # 货币码 10
        "dbtAcc": ACCOUNT,           # 付款账号
        "crtAcc": to_account,        # 收款账号
        "crtNam": to_name,           # 收款户名
        "trsAmt": amount,            # 金额
        "nusAge": remark,            # 转账附言（用途）
        "yurRef": biz_no,            # 业务参考号（防重）
    }
    if is_cross_bank:
        pay_item["crtBnk"]      = bank_code
        pay_item["crtBnkCty"]   = bank_city or "北京市"   # 默认北京市（测试环境对收方信息不校验）
        pay_item["crtBnkLnkNo"] = bank_code               # 通常 = 联行号 = crtBnk
        pay_item["crtBnkNam"]   = bank_name or bank_code  # 银行名兜底用行号

    body = {
        "bb1paybmx1": [
            {"busMod": BUSMOD, "busCod": BUSCOD},
        ],
        "bb1payopx1": [pay_item],
    }

    try:
        result = _call("BB1PAYOP", body)
        head      = (result.get("response") or {}).get("head", {}) or {}
        resp_body = (result.get("response") or {}).get("body", {}) or {}
        items     = resp_body.get("bb1payopz1") or []
        first     = items[0] if items else {}

        # 业务受理成功条件: 外层 head.resultcode=SUC0000 + 内层 errCod=SUC0000 + reqSts=BNK
        head_ok = head.get("resultcode") == "SUC0000"
        biz_ok  = first.get("errCod") == "SUC0000"
        success = head_ok and biz_ok

        return jsonify({
            "success":    success,
            "resultCode": first.get("errCod") or head.get("resultcode", ""),
            "resultMsg":  first.get("msgTxt") or head.get("resultmsg", ""),
            "txNo":       first.get("bakAppNbr", ""),
            "raw":        result,
        })

    except RateLimited as e:
        return _rate_limited_response(e)
    except Exception as e:
        return jsonify({
            "success":    False,
            "resultCode": "CMB_ERROR",
            "resultMsg":  str(e),
        }), 500


@app.route("/query", methods=["POST"])
def query():
    """
    查询付款记录 · BB1PAYQR（规范 §3.4）

    请求体：
    {
      "bizNo":     "原发起付款时的 yurRef（必填用于追踪一笔）",
      "beginDate": "yyyymmdd（可选，默认当天）",
      "endDate":   "yyyymmdd（可选，默认当天）"
    }

    响应体：
    {
      "success":    true/false,
      "resultCode": "...",
      "resultMsg":  "...",
      "payStatus":  "BNK / ACK / ...（reqSts，命中 yurRef 时填）",
      "found":      true/false（是否在结果中找到该 yurRef）,
      "txNo":       "bakAppNbr（命中时填）",
      "raw":        { ...完整银行响应 }
    }
    """
    data       = request.get_json(force=True)
    biz_no     = (data.get("bizNo") or "").strip()
    begin_date = (data.get("beginDate") or "").strip() or _today()
    end_date   = (data.get("endDate") or "").strip() or _today()

    if not biz_no:
        return jsonify({"success": False, "resultCode": "PARAM_ERROR", "resultMsg": "缺少 bizNo"}), 400

    body = {
        "bb1payqrx1": [
            {
                "busCod":    BUSCOD,
                "dbtAcc":    ACCOUNT,
                "beginDate": begin_date,
                "endDate":   end_date,
                "yurRef":    biz_no,
            }
        ],
    }

    try:
        result    = _call("BB1PAYQR", body)
        head      = (result.get("response") or {}).get("head", {}) or {}
        resp_body = (result.get("response") or {}).get("body", {}) or {}
        items     = resp_body.get("bb1payqrz1") or []

        head_ok = head.get("resultcode") == "SUC0000"

        # 在返回的多笔记录里按 yurRef 精确匹配（避免日期范围捞到他笔）
        matched = next((i for i in items if (i.get("yurRef") or "").strip() == biz_no), None)

        return jsonify({
            "success":    head_ok,
            "resultCode": head.get("resultcode", ""),
            "resultMsg":  head.get("resultmsg", ""),
            "found":      matched is not None,
            "payStatus":  (matched or {}).get("reqSts", ""),
            "txNo":       (matched or {}).get("bakAppNbr", ""),
            "raw":        result,
        })

    except RateLimited as e:
        return _rate_limited_response(e)
    except Exception as e:
        return jsonify({
            "success":    False,
            "resultCode": "CMB_ERROR",
            "resultMsg":  str(e),
        }), 500


@app.route("/receipt", methods=["POST"])
def receipt():
    """
    单笔电子回单查询 · DCSIGREC（规范 §3.6）
    付款成功后异步触发，下载 PDF 电子回单存 OSS

    请求体：
    {
      "account":    "账号（可选，默认 CMB_ACCOUNT）",
      "yurRef":     "业务参考号（= scheduleId）",
      "date":       "交易日期 yyyy-MM-dd（注意是带横杠格式）",
      "sequence":   "交易流水 idn（来自 /transactions 的 sequence 字段）"
    }

    ⚠️ 注意：DCSIGREC 接口规定 yurref / eacnbr / quedat / trsseq **全部小写**，
       跟 BB1PAY 系列驼峰不同（规范 §3.6 已注明）

    响应体：
    {
      "success":     true/false,
      "resultCode":  "...",
      "resultMsg":   "...",
      "checkCode":   "回单校验码（防伪）",
      "pdfBase64":   "PDF 文件 base64 内容（可直接解码存 OSS）",
      "raw":         { ... }
    }
    """
    data     = request.get_json(force=True) or {}
    account  = (data.get("account") or ACCOUNT).strip()
    yur_ref  = (data.get("yurRef") or "").strip()
    date     = (data.get("date") or "").strip()
    sequence = (data.get("sequence") or "").strip()

    if not all([yur_ref, date, sequence]):
        return jsonify({
            "success": False, "resultCode": "PARAM_ERROR",
            "resultMsg": "缺少必填参数 yurRef/date/sequence"
        }), 400

    body = {
        "eacnbr": account,
        "yurref": yur_ref,    # 小写！规范 §3.6
        "quedat": date,       # 小写！yyyy-MM-dd 带横杠
        "trsseq": sequence,   # 小写！
    }

    try:
        result    = _call("DCSIGREC", body)
        head      = (result.get("response") or {}).get("head", {}) or {}
        resp_body = (result.get("response") or {}).get("body", {}) or {}

        return jsonify({
            "success":    head.get("resultcode") == "SUC0000",
            "resultCode": head.get("resultcode", ""),
            "resultMsg":  head.get("resultmsg", ""),
            "checkCode":  resp_body.get("checod", ""),
            "pdfBase64":  resp_body.get("fildat", ""),
            "raw":        result,
        })

    except RateLimited as e:
        return _rate_limited_response(e)
    except Exception as e:
        return jsonify({
            "success":    False,
            "resultCode": "CMB_ERROR",
            "resultMsg":  str(e),
        }), 500


@app.route("/transactions", methods=["POST"])
def transactions():
    """
    交易概要查询 · trsQryByBreakPoint（规范 §3.5）
    对账主接口 — 拉账户日期范围内的实际入账/出账明细。

    请求体：
    {
      "account":    "账号（可选，默认 CMB_ACCOUNT）",
      "beginDate":  "yyyymmdd（可选，默认当天）",
      "endDate":    "yyyymmdd（可选，默认当天）"
    }

    响应体：
    {
      "success":      true/false,
      "resultCode":   "...",
      "resultMsg":    "...",
      "hasMore":      true/false (Y/N，是否需要续传),
      "nextSequence": "续传序号",
      "summary": {
        "credit": { "amount": "0.00", "count": "0" },   // 入账（贷）
        "debit":  { "amount": "-0.04", "count": "4" }   // 出账（借）
      },
      "transactions": [
        {
          "date":       "20260415",
          "time":       "102100",
          "sequence":   "C0547EP000056BZ",   // DCSIGREC trsseq 入参
          "direction":  "D" | "C",            // D 借/出 | C 贷/入
          "amount":     "-0.01",              // 出账为负，入账为正
          "counterName": "殷萌涵",            // 对方户名
          "counterAcct": "6214837811201866",  // 对方账号
          "remark":     "供应商货款测试-滇界云管",
          "yurRef":     "DJ-TEST-20260415-4131095"
        }
      ],
      "raw": { ... 完整银行响应 }
    }

    限流: 同账号 10s 内只能查一次 (xlsx §3)。
    """
    data       = request.get_json(force=True) or {}
    account    = (data.get("account") or ACCOUNT).strip()
    begin_date = (data.get("beginDate") or "").strip() or _today()
    end_date   = (data.get("endDate") or "").strip() or _today()

    body = {
        "TRANSQUERYBYBREAKPOINT_X1": {
            "cardNbr":   account,
            "beginDate": begin_date,
            "endDate":   end_date,
        }
    }

    try:
        result    = _call("trsQryByBreakPoint", body)
        head      = (result.get("response") or {}).get("head", {}) or {}
        resp_body = (result.get("response") or {}).get("body", {}) or {}

        # Y1: 续传信息（数组，通常 1 个元素）
        y1 = (resp_body.get("TRANSQUERYBYBREAKPOINT_Y1") or [{}])[0]
        # Z1: 汇总（数组，通常 1 个元素）
        z1 = (resp_body.get("TRANSQUERYBYBREAKPOINT_Z1") or [{}])[0]
        # Z2: 明细数组
        z2 = resp_body.get("TRANSQUERYBYBREAKPOINT_Z2") or []

        transactions = [
            {
                "date":         t.get("transDate", ""),
                "time":         t.get("transTime", ""),
                "sequence":     t.get("transSequenceIdn", ""),
                "direction":    t.get("loanCode", ""),
                "amount":       t.get("transAmount", ""),
                "counterName":  t.get("ctpAcctName", ""),
                "counterAcct":  t.get("ctpAcctNbr", ""),
                "remark":       t.get("remarkTextClt", ""),
                "yurRef":       t.get("yurRef", ""),
            }
            for t in z2
        ]

        return jsonify({
            "success":      head.get("resultcode") == "SUC0000",
            "resultCode":   head.get("resultcode", ""),
            "resultMsg":    head.get("resultmsg", ""),
            "hasMore":      z1.get("ctnFlag") == "Y",
            "nextSequence": y1.get("expectNextSequence", ""),
            "summary": {
                "credit": {
                    "amount": z1.get("creditAmount", "0.00"),
                    "count":  z1.get("creditNums", "0"),
                },
                "debit": {
                    "amount": z1.get("debitAmount", "0.00"),
                    "count":  z1.get("debitNums", "0"),
                },
            },
            "transactions": transactions,
            "raw": result,
        })

    except RateLimited as e:
        return _rate_limited_response(e)
    except Exception as e:
        return jsonify({
            "success":    False,
            "resultCode": "CMB_ERROR",
            "resultMsg":  str(e),
        }), 500


@app.route("/balance", methods=["POST"])
def balance():
    """
    账户余额查询 · NTQACINF（规范 §3.2）

    请求体：
    {
      "account":  "账号（可选，默认用 CMB_ACCOUNT 结算户）"
    }

    响应体：
    {
      "success":    true/false,
      "resultCode": "SUC0000 / 错误码",
      "resultMsg":  "...",
      "account":    "账号",
      "accountName": "户名",
      "balance":    "账户余额（元，字符串）",
      "available":  "可用余额（元）",
      "held":       "冻结余额",
      "currency":   "货币码 10=RMB",
      "status":     "账户状态码 A=正常",
      "raw":        { ...完整银行响应 }
    }

    限流: 同账号 10s 内只能查一次（xlsx 注意事项 §3），调用方需自行节流。
    """
    data = request.get_json(force=True) or {}
    account = (data.get("account") or ACCOUNT).strip()

    body = {"ntqacinfx": {"accnbr": account}}

    try:
        result = _call("NTQACINF", body)
        head      = (result.get("response") or {}).get("head", {}) or {}
        resp_body = (result.get("response") or {}).get("body", {}) or {}
        items     = resp_body.get("ntqacinfz") or []
        first     = items[0] if items else {}

        return jsonify({
            "success":     head.get("resultcode") == "SUC0000",
            "resultCode":  head.get("resultcode", ""),
            "resultMsg":   head.get("resultmsg", ""),
            "account":     first.get("accnbr", ""),
            "accountName": first.get("accnam", ""),
            "balance":     first.get("accblv", ""),
            "available":   first.get("avlblv", ""),
            "held":        first.get("hldblv", ""),
            "currency":    first.get("ccynbr", ""),
            "status":      first.get("stscod", ""),
            "raw":         result,
        })

    except RateLimited as e:
        return _rate_limited_response(e)
    except Exception as e:
        return jsonify({
            "success":    False,
            "resultCode": "CMB_ERROR",
            "resultMsg":  str(e),
        }), 500


if __name__ == "__main__":
    port = int(os.getenv("CMB_SERVICE_PORT", "5001"))
    env_lbl = "PROD" if USE_PROD else "TEST"
    print(f"🏦 招行微服务启动 port={port} env={env_lbl} url={URL} uid={UID}")
    print(f"   busMod={BUSMOD}  busCod={BUSCOD}  ccyNbr={CCY_NBR}")
    print(f"   rate-limit={_RATE_LIMIT_SEC}s on funcodes={_RATE_LIMITED_FUNCODES}")

    # 启动 self-check: 验证当前 BUSMOD 在银行下发列表里
    # 跳过条件: 环境变量 CMB_SKIP_SELFCHECK=true（CI/单测场景用）
    if os.getenv("CMB_SKIP_SELFCHECK", "false").lower() != "true":
        _self_check_busmod()

    app.run(host="0.0.0.0", port=port, debug=False)
