import { readFileSync } from 'fs'
import { join } from 'path'
import axios, { AxiosError } from 'axios'
import type {
  MeituanResponse,
  InstoreOrderListData,
  ReverseOrderListData,
  InstoreQueryReq,
  ReverseQueryReq,
} from './types'
import { signMeituan } from './signature'
import { classifyMeituanError, classifyUniauthSubCode, reportMeituanError } from './errors'
import { CallLogger } from './callLogger'
import { DbTokenStore } from './tokenStore'

const API_BASE = process.env.MEITUAN_API_BASE || 'https://api-open-cater.meituan.com'
const TIMEOUT_MS = 5000

// ════════════════════════════════════════════════════════════════
// Client 接口（Http / Mock 都实现这套）
// ════════════════════════════════════════════════════════════════
export interface MeituanClient {
  fetchInstoreOrders(p: {
    orgId: number
    req: InstoreQueryReq
    correlationId: string
  }): Promise<MeituanResponse<InstoreOrderListData>>

  fetchReverseOrders(p: {
    orgId: number
    req: ReverseQueryReq
    correlationId: string
  }): Promise<MeituanResponse<ReverseOrderListData>>
}

// ════════════════════════════════════════════════════════════════
// 自定义错误：让 sync 层能识别 "限流" / "业务错误"
// ════════════════════════════════════════════════════════════════
export class MeituanRateLimitError extends Error {
  constructor(public responseCode: string) {
    super(`美团限流: ${responseCode}`)
    this.name = 'MeituanRateLimitError'
  }
}

export class MeituanApiError extends Error {
  constructor(
    public responseCode: string,
    msg: string,
    public traceId?: string | null,
    public responseData?: unknown,
  ) {
    super(`${responseCode}: ${msg}`)
    this.name = 'MeituanApiError'
  }
}

// ════════════════════════════════════════════════════════════════
// MockClient — 读 fixtures 返回, 凭证未到位期间 CI / 集成测用
// ════════════════════════════════════════════════════════════════
const fxDir = join(__dirname, 'fixtures')
const loadFx = (name: string) => JSON.parse(readFileSync(join(fxDir, name), 'utf-8'))

export class MeituanMockClient implements MeituanClient {
  /** 可调控行为: 设置下次返回某个 fixture, 否则按 pageNo 默认逻辑 */
  private nextResponse: any = null
  setNextResponse(fx: any) { this.nextResponse = fx }

  async fetchInstoreOrders(p: any) {
    if (this.nextResponse) {
      const r = this.nextResponse
      this.nextResponse = null
      return r
    }
    // pageNo=1 → page1 fixture (2 单);  pageNo>=2 → page2 fixture (空)
    if (p.req.pageNo === 1) return loadFx('instore-order-page1-success.json')
    return loadFx('instore-order-page2-success.json')
  }

  async fetchReverseOrders(p: any) {
    if (this.nextResponse) {
      const r = this.nextResponse
      this.nextResponse = null
      return r
    }
    return loadFx('reverse-order-list.json')
  }
}

// ════════════════════════════════════════════════════════════════
// HttpClient — 真实 axios 调用 + 签名 + 重试 + callLog + Sentry
// ════════════════════════════════════════════════════════════════
export class MeituanHttpClient implements MeituanClient {
  private logger = new CallLogger()

  constructor(
    private secret: string,
    private developerId: string,
    private businessId: string,
    private tokenStore: DbTokenStore,
  ) {}

  async fetchInstoreOrders(p: { orgId: number; req: InstoreQueryReq; correlationId: string }) {
    return await this.callWithRetry<InstoreOrderListData>(
      '/rms/pos/api/v2/poi/orders/instore/query',
      '门店-查询店内订单列表V2',
      { orgId: p.orgId, req: p.req },
      p.correlationId,
    )
  }

  async fetchReverseOrders(p: { orgId: number; req: ReverseQueryReq; correlationId: string }) {
    return await this.callWithRetry<ReverseOrderListData>(
      '/rms/pos/api/v1/poi/reverse/orders/search',
      '门店-查询退单列表',
      { orgId: p.orgId, req: p.req },
      p.correlationId,
    )
  }

  private async callWithRetry<T>(
    apiPath: string,
    apiTitle: string,
    biz: object,
    correlationId: string,
    attempt = 0,
  ): Promise<MeituanResponse<T>> {
    const token = await this.tokenStore.getActive()
    const publicParams: Record<string, string> = {
      developerId: this.developerId,
      businessId: this.businessId,
      charset: 'utf-8',
      version: '2',
      timestamp: String(Math.floor(Date.now() / 1000)),
      appAuthToken: token,
      biz: JSON.stringify(biz),
    }
    const sign = signMeituan(this.secret, publicParams)
    publicParams.sign = sign

    const callLog = await this.logger.start({
      correlationId,
      apiPath,
      apiTitle,
      mode: 'real',
      requestPublic: publicParams,
      requestBiz: biz,
      signature: sign,
    })

    const body = new URLSearchParams(publicParams).toString()
    const start = Date.now()
    try {
      const resp = await axios.post<MeituanResponse<T>>(
        `${API_BASE}${apiPath}`,
        body,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
          timeout: TIMEOUT_MS,
          validateStatus: () => true,   // 不让 axios 自己抛
        },
      )
      const duration = Date.now() - start
      await this.logger.finish(callLog.id, {
        httpStatus: resp.status,
        httpDurationMs: duration,
        responseRaw: typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data),
        responseCode: resp.data?.code,
        responseMsg: resp.data?.msg,
        responseData: resp.data?.data,
        traceId: resp.data?.traceId,
      })

      // 成功
      if (resp.data?.code === 'OP_SUCCESS') return resp.data

      const meta = classifyMeituanError(resp.data?.code)
      const traceId = resp.data?.traceId == null ? undefined : String(resp.data.traceId)

      // OP_UNIAUTH_FAILED + data.code=4 → refresh + 重试 1 次
      if (resp.data?.code === 'OP_UNIAUTH_FAILED' && attempt === 0) {
        const sub = classifyUniauthSubCode((resp.data?.data as any)?.code)
        if (sub.action === 'refreshToken') {
          // PR 5 接 refresh; 当前阶段：记录 + 抛错让 cron 停摆等人工
          await this.tokenStore.recordRefreshFailure()
          throw new MeituanApiError('OP_UNIAUTH_FAILED', 'token 过期 (refresh 接口待 PR5 实现)', traceId, resp.data.data)
        }
      }

      // retry: 'once' → 重试 1 次
      if (meta.retry === 'once' && attempt === 0) {
        await new Promise(r => setTimeout(r, 500))
        return this.callWithRetry<T>(apiPath, apiTitle, biz, correlationId, attempt + 1)
      }

      // backoff (限流) → 抛特殊异常让 cron 跳过后续 page
      if (meta.retry === 'backoff') {
        throw new MeituanRateLimitError(resp.data?.code || 'OP_LIMITATION_REJECT')
      }

      // 其他失败
      throw new MeituanApiError(
        resp.data?.code || 'UNKNOWN',
        resp.data?.msg || 'unknown error',
        traceId,
        resp.data?.data,
      )
    } catch (e) {
      const duration = Date.now() - start
      if (e instanceof MeituanApiError || e instanceof MeituanRateLimitError) {
        // 业务错误：callLog 已落 (finish 写过), 这里只上 Sentry 后抛回
        reportMeituanError(e, {
          apiPath, apiTitle,
          responseCode: (e as MeituanApiError).responseCode,
          traceId: (e as MeituanApiError).traceId,
          callLogId: callLog.id,
          correlationId,
        })
        throw e
      }
      // axios 抛 / 网络错 — finish 没写, 走 fail 路径
      const ax = e as AxiosError
      await this.logger.fail(callLog.id, {
        httpStatus: ax.response?.status,
        httpDurationMs: duration,
        errorMessage: ax.message,
        responseRaw: ax.response?.data ? JSON.stringify(ax.response.data) : undefined,
      })
      reportMeituanError(ax, { apiPath, apiTitle, callLogId: callLog.id, correlationId })
      throw e
    }
  }
}

// ════════════════════════════════════════════════════════════════
// Factory — 由 MEITUAN_MODE 控制 mock | real
// ════════════════════════════════════════════════════════════════
export function createMeituanClient(): MeituanClient {
  const mode = process.env.MEITUAN_MODE || 'mock'
  if (mode === 'real') {
    const secret = process.env.MEITUAN_APP_SECRET
    const developerId = process.env.MEITUAN_DEVELOPER_ID
    const businessId = process.env.MEITUAN_BUSINESS_ID || '18'
    const orgId = Number(process.env.MEITUAN_ORG_ID)
    if (!secret || !developerId || !orgId) {
      throw new Error('MEITUAN_MODE=real 但缺 MEITUAN_APP_SECRET / DEVELOPER_ID / ORG_ID')
    }
    return new MeituanHttpClient(secret, developerId, businessId, new DbTokenStore(orgId))
  }
  return new MeituanMockClient()
}
