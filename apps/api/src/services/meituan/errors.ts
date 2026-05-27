import * as Sentry from '@sentry/node'
import type { MeituanErrorMeta } from './types'

/**
 * 美团错误码字典 — 对照 https://developer.meituan.com/docs/biz/comm-errcode1 表 3
 * （使用 biz 传参时的状态码，跟智能版接口对应）
 *
 * 字典外的错误码默认 P1 + cat='unknown' + retry=false。
 * 撞到新码后请人工补入此字典。
 */
export const MEITUAN_ERROR_CODES: Record<string, MeituanErrorMeta> = {
  'OP_SUCCESS': { severity: 'info', retry: false, cat: 'biz', desc: '调用成功' },

  // ── P0: 停止调用 / 提工单 ──
  'OP_API_NOT_EXIST':                    { severity: 'P0', retry: false, cat: 'config',    desc: '接口不存在' },
  'OP_SYSTEM_ERROR':                     { severity: 'P0', retry: false, cat: 'transport', desc: '网关错误' },
  'OP_BIZ_ERROR':                        { severity: 'P0', retry: false, cat: 'biz',       desc: '业务错误' },
  'OP_HTTP_UNSUPPORTED_CONTENT_TYPE':    { severity: 'P0', retry: false, cat: 'config',    desc: '不支持的 ContentType' },
  'OP_HTTP_UNSUPPORTED_METHOD_TYPE':     { severity: 'P0', retry: false, cat: 'config',    desc: '不支持的 HttpMethod' },
  'OP_HTTP_SYSTEM_PARAM_ERROR':          { severity: 'P0', retry: false, cat: 'config',    desc: '系统参数读取错误（提工单）' },
  'OP_HTTP_FILEUPLOAD_ERROR':            { severity: 'P0', retry: false, cat: 'biz',       desc: '文件上传失败' },
  'OP_THRIFT_INIT_ERROR':                { severity: 'P0', retry: false, cat: 'transport', desc: 'thrift 初始化失败（提工单）' },
  'OP_API_GRANT_FAILED':                 { severity: 'P0', retry: false, cat: 'auth',      desc: '没有 Api 权限（联系运营开通）' },
  'OP_REMOTE_ERROR':                     { severity: 'P0', retry: false, cat: 'transport', desc: '业务方服务出错' },
  'OP_CONFIG_ERROR':                     { severity: 'P0', retry: false, cat: 'config',    desc: '网关配置错误（提工单）' },
  'OP_CONFIG_NOT_FOUND':                 { severity: 'P0', retry: false, cat: 'config',    desc: '未识别的 Api 配置（提工单）' },
  'OP_CONFIG_RPC_EMPTY':                 { severity: 'P0', retry: false, cat: 'config',    desc: 'RPC 参数为空（提工单）' },
  'OP_SERVICE_CONFIG_EMPTY':             { severity: 'P0', retry: false, cat: 'config',    desc: '业务配置为空（提工单）' },
  'OP_RPC_REMOTE_ERROR':                 { severity: 'P0', retry: false, cat: 'transport', desc: '业务服务出错（提工单）' },
  'OP_RPC_INVOKE_ERROR':                 { severity: 'P0', retry: false, cat: 'transport', desc: '业务调用失败（提工单）' },
  'OP_RPC_INVOKE_PARAM_EMPTY':           { severity: 'P0', retry: false, cat: 'param',     desc: '业务调用参数为空（提工单）' },
  'OP_CIRCUITBREAK':                     { severity: 'P0', retry: false, cat: 'transport', desc: '触发熔断' },
  'OP_CIRCUITBREAK_ERROR':               { severity: 'P0', retry: false, cat: 'transport', desc: '熔断处理错误' },
  'OP_DEGRADED_UNSUPPORTED_DEGRADETYPE': { severity: 'P0', retry: false, cat: 'config',    desc: '不支持的降级类型' },
  'OP_DEGRADED_HANDLE_ERROR':            { severity: 'P0', retry: false, cat: 'transport', desc: '降级处理错误' },
  'OP_RESULT_DSL_ERROR':                 { severity: 'P0', retry: false, cat: 'config',    desc: '结果集解析失败（提工单）' },
  'OP_SYSTEM_PARAM_ERROR':               { severity: 'P0', retry: false, cat: 'param',     desc: '缺少系统参数（检查代码）' },

  // ── P1: 鉴权失败 — 看 data.code 子码（用 classifyUniauthSubCode）──
  'OP_UNIAUTH_FAILED':                   { severity: 'P1', retry: 'inspectData', cat: 'auth', desc: '鉴权失败（看 data.code）' },

  // ── P2: 文档明确"重试 1 次" ──
  'OP_TIMEOUT':                          { severity: 'P2', retry: 'once', cat: 'transport', desc: '请求超时' },
  'OP_UNIAUTH_REMOTE_ERROR':             { severity: 'P2', retry: 'once', cat: 'auth',      desc: '鉴权服务错误' },
  'OP_API_GRANT_REMOTE_ERROR':           { severity: 'P2', retry: 'once', cat: 'auth',      desc: 'Api 权限服务错误' },
  'OP_SOCKET_TIMEOUT_EXCEPTION':         { severity: 'P2', retry: 'once', cat: 'transport', desc: 'Socket 连接超时' },
  'OP_LIMITATION_ERROR':                 { severity: 'P2', retry: 'once', cat: 'rate',      desc: '限流执行错误' },

  // ── P2 限流: 不简单重试, 跳过本 cron 后续 page ──
  'OP_LIMITATION_REJECT':                { severity: 'P2', retry: 'backoff', cat: 'rate', desc: '限流拒绝' },
}

export function classifyMeituanError(code: string | null | undefined): MeituanErrorMeta {
  if (code == null || code === '') {
    return { severity: 'P0', retry: 'once', cat: 'transport', desc: '网络错误 / 无响应' }
  }
  return MEITUAN_ERROR_CODES[code] ?? {
    severity: 'P1',
    retry: false,
    cat: 'unknown',
    desc: `未知错误码 ${code}（请补入字典）`,
  }
}

/** OP_UNIAUTH_FAILED 的 data.code 子码 */
export interface UniauthSubcodeMeta {
  severity: 'P0' | 'P1' | 'P2'
  desc: string
  action: 'stop' | 'refreshToken' | 'contactOps'
}

const UNIAUTH_SUBCODES: Record<number, UniauthSubcodeMeta> = {
  3:  { severity: 'P1', desc: '签名错误(检查代码)',           action: 'stop' },
  4:  { severity: 'P2', desc: '令牌已过期',                   action: 'refreshToken' },
  5:  { severity: 'P0', desc: '非法令牌(重新授权)',          action: 'stop' },
  19: { severity: 'P0', desc: '没 api 权限(联系运营)',        action: 'contactOps' },
  22: { severity: 'P0', desc: '授权过期(联系商户重新授权)',    action: 'stop' },
}

export function classifyUniauthSubCode(subCode: number | string | null | undefined): UniauthSubcodeMeta {
  const n = typeof subCode === 'string' ? Number(subCode) : subCode
  if (n == null || Number.isNaN(n)) {
    return { severity: 'P0', desc: '未知 UNIAUTH 子码', action: 'stop' }
  }
  return UNIAUTH_SUBCODES[n as number] ?? { severity: 'P0', desc: `未知 UNIAUTH 子码 ${n}`, action: 'stop' }
}

/** Sentry 上报 — 跟 reportCmbError 同款 */
export function reportMeituanError(
  err: Error | string,
  ctx: {
    apiPath: string
    apiTitle: string
    responseCode?: string | null
    traceId?: string | number | null
    callLogId?: string
    correlationId?: string
  },
): void {
  const e = typeof err === 'string' ? new Error(err) : err
  const meta = classifyMeituanError(ctx.responseCode)
  Sentry.captureException(e, {
    tags: {
      'meituan.code': ctx.responseCode || 'TRANSPORT',
      'meituan.severity': meta.severity,
      'meituan.category': meta.cat,
      'meituan.api': ctx.apiPath,
    },
    extra: {
      apiTitle: ctx.apiTitle,
      traceId: ctx.traceId,
      callLogId: ctx.callLogId,
      correlationId: ctx.correlationId,
      meta,
    },
  })
}
