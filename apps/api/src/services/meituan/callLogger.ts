import { prisma } from '@dianjie/db'
import { classifyMeituanError } from './errors'

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
  /** 开始一次调用 — 立刻落一行 (httpStatus/responseRaw 等先 null) */
  async start(p: CallStartParams): Promise<{ id: string }> {
    return await prisma.meituanApiCallLog.create({
      data: {
        correlationId: p.correlationId,
        apiPath: p.apiPath,
        apiTitle: p.apiTitle,
        mode: p.mode,
        requestPublic: maskSign(p.requestPublic),    // 不存 sign 在 public 里, 单独字段
        requestBiz: p.requestBiz as object,
        signature: p.signature,
      },
      select: { id: true },
    })
  }

  /** 调用结束 — 写响应 + 错误分级 */
  async finish(callLogId: string, p: CallFinishParams): Promise<void> {
    const meta = classifyMeituanError(p.responseCode)
    await prisma.meituanApiCallLog.update({
      where: { id: callLogId },
      data: {
        httpStatus: p.httpStatus,
        httpDurationMs: p.httpDurationMs,
        responseRaw: p.responseRaw,
        responseCode: p.responseCode ?? null,
        responseMsg: p.responseMsg ?? null,
        responseData: (p.responseData as object) ?? undefined,
        traceId: p.traceId == null ? null : String(p.traceId),
        errorSeverity: meta.severity === 'info' ? null : meta.severity,
      },
    })
  }

  /** 调用挂了 (网络/超时/异常) — 标 P0 transport */
  async fail(callLogId: string, p: CallFailParams): Promise<void> {
    await prisma.meituanApiCallLog.update({
      where: { id: callLogId },
      data: {
        httpStatus: p.httpStatus ?? null,
        httpDurationMs: p.httpDurationMs,
        responseRaw: p.responseRaw ?? null,
        errorMessage: p.errorMessage,
        errorSeverity: 'P0',
      },
    })
  }
}

/** 把 sign 字段移出 requestPublic, 放 signature 列(避免重复 + 便于查 sign 错误) */
function maskSign(public_: Record<string, string>): object {
  const { sign, ...rest } = public_
  return rest
}
