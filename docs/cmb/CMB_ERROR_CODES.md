# 招商银行新直联 · 错误码字典

> 来源：4/14、4/15 联调实测 + xlsx 注意事项 + 招行常见 cdcserver 错误码
> 用途：cmbPayment.ts 抛错时按这个表打 Sentry tag，便于分类报警

---

## 1. 我方错误码（V4 自定义）

| code | 来源 | HTTP | 含义 | 处理建议 |
|---|---|---|---|---|
| `PARAM_ERROR` | app.py | 400 | 必填参数缺失 / 类型错 | 调用方 bug，修代码 |
| `RATE_LIMITED` | app.py | 429 | 同账号 10s 限流 | 调用方等 `waitSec` 后重试，**不要并发** |
| `NETWORK_ERROR` | cmbPayment.ts | n/a | fetch reject / timeout | cmbTransferWithCheck 会自动查重 + 重发 |
| `QUERY_ERROR` | cmbPayment.ts | n/a | 查重失败 | 兜底，不可重发，需人工查 |
| `CMB_RETRY_EXHAUSTED` | cmbPayment.ts | n/a | 重发已达上限仍未成功 | 人工查招行后台 + 财务 |
| `CMB_ERROR` | app.py | 500 | Python 端未捕获异常 | 看 stack trace，多半是上游异常 |

---

## 2. 银行错误码

### 2.1 成功类

| code | 含义 | 备注 |
|---|---|---|
| `SUC0000` | **请求被银行成功接收** | ≠ 业务成功，需查询接口确认 |

### 2.2 已知失败码（高频）

| code | 含义 | 触发场景 | 处理建议 |
|---|---|---|---|
| `DCPG008` | 请求数据内容不正确，xxx 未提供服务 | funcode 拼错 / 业务未开通 | 检查 funcode 是否在我方/银行的开通列表 |
| `DCASY12` | 日期转换错误（也用于"无数据"） | ASYCALHD 在测试环境无异步记录时也返这个 | 多数情况下链路通即可 |
| `DCERR##` | 数据加解密 / 签名错 | 密钥不匹配（测试密钥用到生产 / 公私钥不配对） | 立刻停服查 .env CMB_PRIVATE_KEY/CMB_BANK_PUBLIC_KEY |
| `DCSE###` | 会话相关错误 | UID 失效 / 没在白名单 | 联系招行分行 |

### 2.3 BB1PAYOP 内层 errCod

| code | 含义 | 处理 |
|---|---|---|
| `SUC0000` | 银行受理 | 看 reqSts 是 `BNK`（受理）还是 `ACK`（已扣款），通过 BB1PAYQR 跟进 |
| 余额不足 | `dbtAcc` 可用余额不够 trsAmt | 等回款再发；不是银行错，是业务错 |
| 白名单错 | 收款方在风控黑名单 / 跨行行号错 | 检查 crtBnk / crtBnkLnkNo |
| 业务模式错 | busMod 错 | 检查 `CMB_BUSMOD` 是否在 DCLISMOD 返回列表里 |

> ⚠️ 银行后台错误码可能更新，遇到本表外的码立刻去招行开发者门户查或问 BD

---

## 3. Sentry tag 约定

```ts
Sentry.captureException(err, {
  tags: {
    'cmb.code': result.resultCode,       // SUC0000 / RATE_LIMITED / NETWORK_ERROR 等
    'cmb.funcode': 'BB1PAYOP',           // 招行 funcode
    'cmb.severity': severityForCode(code),
  },
  extra: {
    bizNo: params.bizNo,
    bankRawResponse: result.raw,
  },
})
```

`severityForCode` 分级：
- **P0**（立刻告警）：`DCERR##` / `DCSE###`（密钥 / 会话级错，影响所有交易）
- **P1**（24h 内排查）：`DCPG008`（funcode 错，业务全断）
- **P2**（业务自愈，关注趋势）：`RATE_LIMITED` / `NETWORK_ERROR` / 单笔失败
- **info**（仅记录）：`SUC0000`（成功，但需要 trace 时打）

---

## 4. 常见排错 Flowchart

```
付款失败 → 看 resultCode

resultCode = SUC0000
  → 看 bb1payopz1[0].errCod
    = SUC0000 → 看 reqSts=BNK 还是 ACK
      BNK → 银行受理, 用 BB1PAYQR 跟踪
      ACK → 已扣款, 走完整流程
    ≠ SUC0000 → 看 msgTxt（业务原因）, 按 §2.3 处理

resultCode = DCPG008
  → 检查 funcode 是 BB1PAYOP 还是误写成 DCPAYOPR
  → 跑 DCLISMOD 看银行端开通的功能列表

resultCode = DCERR##
  → 检查 .env: CMB_PRIVATE_KEY / CMB_PUBLIC_KEY / CMB_BANK_PUBLIC_KEY / CMB_SYM_KEY
  → 测试 vs 生产密钥串了？

resultCode = RATE_LIMITED
  → 不是错，是限流。等 waitSec 后重试

resultCode = NETWORK_ERROR / Connection refused
  → curl 服务器 telnet cdctest.cmburl.cn 80 看通不通
  → 检查出口 IP 在白名单内
```
