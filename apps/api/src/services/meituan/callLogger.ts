import { collectProviderSecrets, redactProviderPayload, redactProviderRaw } from '../../lib/provider-log-safety'
import { prisma } from '@dianjie/db'
import { classifyMeituanError, MEITUAN_ERROR_CODES } from './errors'

export interface CallStartParams {
  correlationId: string
  apiPath: string
  apiTitle: string
  mode: 'mock' | 'real'
  requestPublic: Record<string, string>
  requestBiz: object
  signature?: string
}

export interface CallFinishParams {
  httpStatus: number
  httpDurationMs: number
  responseRaw: string
  responseCode?: string | null
  responseMsg?: string | null
  responseData?: unknown
  traceId?: string | number | null
}

export interface CallFailParams {
  httpStatus?: number
  httpDurationMs: number
  errorMessage: string
  responseRaw?: string
}

export class CallLogger {
  private secrets = new Map<string,string[]>()
  /** 开始一次调用 — 立刻落一行 (httpStatus/responseRaw 等先 null) */
  async start(p: CallStartParams): Promise<{ id: string }> {
    const created = await prisma.meituanApiCallLog.create({
      data: {
        correlationId: p.correlationId,
        apiPath: p.apiPath,
        apiTitle: p.apiTitle,
        mode: p.mode,
        requestPublic: redactProviderPayload(p.requestPublic),    // 不存 sign 在 public 里, 单独字段
        requestBiz: redactProviderPayload(p.requestBiz, collectProviderSecrets(p.requestPublic)) as object,
        signature: p.signature ? '[REDACTED]' : undefined,
      },
      select: { id: true },
    })
    if(this.secrets.size>=1000)this.secrets.delete(this.secrets.keys().next().value!)
    this.secrets.set(created.id,collectProviderSecrets(p.requestPublic))
    return created
  }

  /** 调用结束 — 写响应 + 错误分级 */
  async finish(callLogId: string, p: CallFinishParams): Promise<void> {
    const secrets=this.secrets.get(callLogId)||[]
    this.secrets.delete(callLogId)
    const code = p.responseCode == null ? null : Object.hasOwn(MEITUAN_ERROR_CODES,p.responseCode) ? p.responseCode : 'UNKNOWN'
    const meta = classifyMeituanError(code)
    await prisma.meituanApiCallLog.update({
      where: { id: callLogId },
      data: {
        httpStatus: p.httpStatus,
        httpDurationMs: p.httpDurationMs,
        responseRaw: redactProviderRaw(p.responseRaw,secrets),
        responseCode: code,
        responseMsg: p.responseMsg ? 'Provider message withheld' : null,
        responseData: redactProviderPayload(p.responseData,secrets) ?? undefined,
        traceId: p.traceId == null ? null : redactProviderPayload(String(p.traceId),secrets),
        errorSeverity: meta.severity === 'info' ? null : meta.severity,
      },
    })
  }

  /** 调用挂了 (网络/超时/异常) — 标 P0 transport */
  async fail(callLogId: string, p: CallFailParams): Promise<void> {
    const secrets=this.secrets.get(callLogId)||[]
    this.secrets.delete(callLogId)
    await prisma.meituanApiCallLog.update({
      where: { id: callLogId },
      data: {
        httpStatus: p.httpStatus ?? null,
        httpDurationMs: p.httpDurationMs,
        responseRaw: redactProviderRaw(p.responseRaw,secrets),
        errorMessage: 'Provider error details withheld',
        errorSeverity: 'P0',
      },
    })
  }
}
