# 美团智能版 API · 错误码字典

> 来源：[公共错误码文档](https://developer.meituan.com/docs/biz/comm-errcode1) 表 3 (使用 biz 传参时)
> 用途：`apps/api/src/services/meituan/errors.ts` 中 `MEITUAN_ERROR_CODES` 字典对应；Sentry tag 分类报警
> 配套代码：`services/meituan/errors.ts` + `client.ts` 重试策略

---

## 1. 严重程度分级 (与 Sentry tag `meituan.severity` 对应)

| Severity | 含义 | 触发行为 |
|---|---|---|
| `info` | 调用成功 | 无 |
| `P0` | 凭证/签名/接口配置级错误 | 整个集成挂掉; cron 停摆等人工; Sentry 即报 |
| `P1` | 业务参数 / 鉴权语义错 | 单次失败; 看 data.code 子码细分 |
| `P2` | 可恢复 (超时 / 限流) | 文档明确"重试 1 次"; 限流跳过本 cron 后续 page |

## 2. 错误码字典 (使用 biz 传参时, 即智能版接口)

### 2.1 成功

| code | severity | retry | desc | 备注 |
|---|---|---|---|---|
| `OP_SUCCESS` | info | false | 调用成功 | data 字段含业务数据 |

### 2.2 P0 — 停止调用 / 提工单

| code | retry | cat | desc |
|---|---|---|---|
| `OP_API_NOT_EXIST` | false | config | 接口不存在 |
| `OP_SYSTEM_ERROR` | false | transport | 网关错误 |
| `OP_BIZ_ERROR` | false | biz | 业务错误 |
| `OP_HTTP_UNSUPPORTED_CONTENT_TYPE` | false | config | 不支持的 ContentType |
| `OP_HTTP_UNSUPPORTED_METHOD_TYPE` | false | config | 不支持的 HttpMethod |
| `OP_HTTP_SYSTEM_PARAM_ERROR` | false | config | 系统参数读取错误 (提工单) |
| `OP_HTTP_FILEUPLOAD_ERROR` | false | biz | 文件上传失败 |
| `OP_THRIFT_INIT_ERROR` | false | transport | thrift 初始化失败 (提工单) |
| `OP_API_GRANT_FAILED` | false | auth | 没有 Api 权限 (联系运营开通) |
| `OP_REMOTE_ERROR` | false | transport | 业务方服务出错 |
| `OP_CONFIG_ERROR` | false | config | 网关配置错误 (提工单) |
| `OP_CONFIG_NOT_FOUND` | false | config | 未识别的 Api 配置 (提工单) |
| `OP_CONFIG_RPC_EMPTY` | false | config | RPC 参数为空 (提工单) |
| `OP_SERVICE_CONFIG_EMPTY` | false | config | 业务配置为空 (提工单) |
| `OP_RPC_REMOTE_ERROR` | false | transport | 业务服务出错 (提工单) |
| `OP_RPC_INVOKE_ERROR` | false | transport | 业务调用失败 (提工单) |
| `OP_RPC_INVOKE_PARAM_EMPTY` | false | param | 业务调用参数为空 (提工单) |
| `OP_CIRCUITBREAK` | false | transport | 触发熔断 |
| `OP_CIRCUITBREAK_ERROR` | false | transport | 熔断处理错误 |
| `OP_DEGRADED_UNSUPPORTED_DEGRADETYPE` | false | config | 不支持的降级类型 |
| `OP_DEGRADED_HANDLE_ERROR` | false | transport | 降级处理错误 |
| `OP_RESULT_DSL_ERROR` | false | config | 结果集解析失败 (提工单) |
| `OP_SYSTEM_PARAM_ERROR` | false | param | 缺少系统参数 (检查代码) |

### 2.3 P1 — 鉴权失败 (看 data.code 子码)

| code | retry | cat | desc |
|---|---|---|---|
| `OP_UNIAUTH_FAILED` | inspectData | auth | 鉴权失败，必须看 data.code 决定动作 |

#### OP_UNIAUTH_FAILED 的 data.code 子码

| subcode | severity | action | desc |
|---|---|---|---|
| `3` | P1 | stop | 签名错误 — 检查代码 |
| `4` | P2 | **refreshToken** | 令牌已过期 — 自动调 refresh 接口 + 重试 1 次 |
| `5` | P0 | stop | 非法令牌 — 重新授权 |
| `19` | P0 | contactOps | 没 api 权限 — 联系运营 |
| `22` | P0 | stop | 授权过期 — 联系商户重新授权 |

### 2.4 P2 — 文档明确"重试 1 次"

| code | retry | cat | desc |
|---|---|---|---|
| `OP_TIMEOUT` | once | transport | 请求超时 |
| `OP_UNIAUTH_REMOTE_ERROR` | once | auth | 鉴权服务错误 |
| `OP_API_GRANT_REMOTE_ERROR` | once | auth | Api 权限服务错误 |
| `OP_SOCKET_TIMEOUT_EXCEPTION` | once | transport | Socket 连接超时 |
| `OP_LIMITATION_ERROR` | once | rate | 限流执行错误 |

### 2.5 P2 — 限流 (不简单重试)

| code | retry | cat | desc |
|---|---|---|---|
| `OP_LIMITATION_REJECT` | backoff | rate | 限流拒绝 — 跳过本 cron 后续 page，下小时再来 |

### 2.6 未定义错误码

字典外的码默认归类：

| - | severity | retry | cat | desc |
|---|---|---|---|---|
| 未知 | P1 | false | unknown | "未知错误码 ${code} (请补入字典)" |
| null / undefined / 空 | P0 | once | transport | 网络错误 / 无响应 |

---

## 3. Sentry tag 设计

每次错误上报会自动打以下 tag (见 `errors.ts → reportMeituanError`)：

| tag | 值 |
|---|---|
| `meituan.code` | 完整错误码或 `TRANSPORT` |
| `meituan.severity` | `P0` / `P1` / `P2` / `info` |
| `meituan.category` | `auth` / `param` / `rate` / `transport` / `config` / `biz` / `unknown` |
| `meituan.api` | 接口路径 (如 `/rms/pos/api/v2/poi/orders/instore/query`) |

extra:
- `apiTitle`, `traceId`, `callLogId`, `correlationId`, `meta`

---

## 4. 处理流程图

```
HTTP 调用 → axios response
  │
  ├─ code == 'OP_SUCCESS' → 正常返回
  │
  ├─ code == 'OP_UNIAUTH_FAILED' + data.code == 4 (attempt=0)
  │    → refreshToken() → 重试 1 次
  │
  ├─ meta.retry == 'once' (attempt=0)
  │    → setTimeout 500ms → 重试 1 次
  │
  ├─ meta.retry == 'backoff'
  │    → throw MeituanRateLimitError → sync 层 break 跳出 pagination
  │
  └─ 其他 / attempt > 0
       → throw MeituanApiError → Sentry + cron 中止本窗口
```

---

## 5. 工单导出方式

撞到无法自动恢复的错误时：

1. 找出对应的 callLog: `GET /api/admin/meituan/calls?severity=P0&since=...`
2. 拿 callId 生成工单 markdown: `GET /api/admin/meituan/calls/:id/ticket-template`
3. 粘到美团 TT 工单或邮件 `mtdeveloper@meituan.com`

---

## 6. 撞到新错误码怎么办

1. 撞到的码会在 callLog 表 `errorMessage` 字段标 `未知错误码 XXX (请补入字典)`
2. 查美团文档确认含义
3. 在 `services/meituan/errors.ts` 的 `MEITUAN_ERROR_CODES` Record 加一行
4. 更新本文档对应区段
5. 提交 commit: `chore(meituan): errors.ts 补 X 个新错误码 (生产观察 1 周收集)`
