import { readFileSync } from 'fs'
import { join } from 'path'
import type {
  MeituanResponse,
  InstoreOrderListData,
  ReverseOrderListData,
  InstoreQueryReq,
  ReverseQueryReq,
} from './types'

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
// HttpClient — PR 2 末尾接入真实 axios 调用
// 这一 task 先留一个空 stub 类, PR 2 Task 10 替换成真实现
// ════════════════════════════════════════════════════════════════
export class MeituanHttpClient implements MeituanClient {
  async fetchInstoreOrders(_p: any): Promise<any> {
    throw new Error('MeituanHttpClient.fetchInstoreOrders not implemented yet (PR 2 Task 10)')
  }
  async fetchReverseOrders(_p: any): Promise<any> {
    throw new Error('MeituanHttpClient.fetchReverseOrders not implemented yet (PR 2 Task 10)')
  }
}

// ════════════════════════════════════════════════════════════════
// Factory — 由 MEITUAN_MODE 控制 mock | real
// ════════════════════════════════════════════════════════════════
export function createMeituanClient(): MeituanClient {
  const mode = process.env.MEITUAN_MODE || 'mock'
  if (mode === 'real') return new MeituanHttpClient()
  return new MeituanMockClient()
}
