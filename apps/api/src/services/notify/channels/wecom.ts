/**
 * WeCom 通道实现
 * 业务层不直接调 wecom service, 通过 notify() 调本通道
 */
import { sendAppMsg, sendCardMsg } from '../../wecom'
import type { RenderedMsg } from '../events'

export async function sendViaWeCom(tenantId: string, wecomUserId: string, msg: RenderedMsg) {
  if (msg.kind === 'textcard' && msg.textcard) {
    return sendCardMsg(tenantId, wecomUserId, msg.textcard)
  }
  return sendAppMsg(tenantId, wecomUserId, msg.text || '滇界提醒')
}
