/**
 * 业务事件定义 + 默认收件人解析 + 模板渲染
 *
 * 加新事件:
 *   1. 在 EVENTS 加一条 (label + 默认收件角色 + 是否紧急)
 *   2. 在 TEMPLATES 加模板 (text 或 textcard 卡片)
 *   3. 业务路由调 notify({ event: 'XXX', eventKey, payload, ... })
 */
import { prisma } from '@dianjie/db'

export const EVENTS = {
  PO_SUBMITTED: {
    label: '订单提交',
    desc: '门店厨师长发起新订单 → 通知供应商接单',
    defaultRoles: ['SUPPLIER_OWNER', 'SUPPLIER_STAFF'],
    scopedBy: 'supplier',
    urgent: false,
  },
  PO_DELIVERING: {
    label: '订单发货',
    desc: '供应商点击发货 → 通知门店准备验收',
    defaultRoles: ['KITCHEN_LEAD', 'MANAGER'],
    scopedBy: 'store',
    urgent: false,
  },
  PO_PENDING_CONFIRM: {
    label: '订单到店',
    desc: '供应商点击送达 → 厨师长验收 24h 倒计时',
    defaultRoles: ['KITCHEN_LEAD'],
    scopedBy: 'store',
    urgent: true,
  },
  LOSS_PENDING: {
    label: '报损待处理',
    desc: '门店验收报损 → 供应商同意/拒绝',
    defaultRoles: ['SUPPLIER_OWNER', 'SUPPLIER_STAFF'],
    scopedBy: 'supplier',
    urgent: false,
  },
  LOSS_REJECTED: {
    label: '报损争议升级',
    desc: '供应商拒绝报损 → 总厨仲裁',
    defaultRoles: ['CHEF_DIRECTOR'],
    scopedBy: 'tenant',
    urgent: false,
  },
  PAYMENT_LARGE: {
    label: '大额付款待审',
    desc: '账期到了大额付款 → 财务+老板放行',
    defaultRoles: ['FINANCE', 'ADMIN'],
    scopedBy: 'tenant',
    urgent: false,
  },
} as const

export type EventKey = keyof typeof EVENTS

/**
 * 模板: 返回 { kind: 'text'|'textcard', text? | textcard? }
 */
export function renderTemplate(event: EventKey, payload: Record<string, any>): RenderedMsg {
  switch (event) {
    case 'PO_SUBMITTED':
      return {
        kind: 'textcard',
        textcard: {
          title: `📥 新订单待接单 #${payload.no || ''}`,
          description: `${payload.storeName || '门店'} 下单 ${payload.itemCount || 0} 项,合计 ¥${fmt(payload.total)}。点开接单。`,
          url: `${baseUrl()}/v2/supplier/orders/${payload.orderId}`,
          btntxt: '去接单',
        },
      }
    case 'PO_DELIVERING':
      return {
        kind: 'text',
        text: `🚚 ${payload.supplierName || '供应商'} 已发货:订单 #${payload.no},预计今天到店,请准备验收。`,
      }
    case 'PO_PENDING_CONFIRM':
      return {
        kind: 'textcard',
        textcard: {
          title: `⏰ 待验收 #${payload.no || ''}`,
          description: `${payload.supplierName || '供应商'} 已送达,合计 ¥${fmt(payload.total)}。24h 未验收将自动收货,请尽快确认。`,
          url: `${baseUrl()}/v2/chef/purchase/${payload.orderId}/receive`,
          btntxt: '去验收',
        },
      }
    case 'LOSS_PENDING':
      return {
        kind: 'textcard',
        textcard: {
          title: `⚠ 报损待处理 ${payload.lossNo || ''}`,
          description: `${payload.storeName || '门店'} 报损 ¥${fmt(payload.amount)}。${payload.itemPreview || ''}。24h 未处理将自动同意。`,
          url: `${baseUrl()}/v2/supplier/orders/${payload.orderId}`,
          btntxt: '查看证据',
        },
      }
    case 'LOSS_REJECTED':
      return {
        kind: 'textcard',
        textcard: {
          title: `⚖ 报损争议待仲裁`,
          description: `${payload.supplierName} 拒绝了 ${payload.storeName} 的 ¥${fmt(payload.amount)} 报损,需要您判定。`,
          url: `${baseUrl()}/v2/chef-director/disputes`,
          btntxt: '去仲裁',
        },
      }
    case 'PAYMENT_LARGE':
      return {
        kind: 'textcard',
        textcard: {
          title: `💰 大额付款待审 ¥${fmt(payload.amount)}`,
          description: `${payload.supplierName} · 账期到 · 共 ${payload.orderCount || 0} 张订单`,
          url: `${baseUrl()}/v2/finance/review`,
          btntxt: '去放行',
        },
      }
    default:
      return { kind: 'text', text: `[${event}] ${JSON.stringify(payload).slice(0, 100)}` }
  }
}

export interface RenderedMsg {
  kind: 'text' | 'textcard'
  text?: string
  textcard?: { title: string; description: string; url: string; btntxt?: string }
}

function fmt(n: any): string {
  return Number(n || 0).toFixed(2)
}

function baseUrl(): string {
  return process.env.WECOM_REDIRECT_BASE || 'https://www.njdianjie.com'
}

/**
 * 默认收件人解析 (基于事件元数据)
 */
export async function defaultRecipients(tenantId: string, opts: {
  event: EventKey
  toRoles?: string[]
  toStoreIds?: string[]
  toSupplierIds?: string[]
}): Promise<string[]> {
  const meta = EVENTS[opts.event]
  const roles = opts.toRoles?.length ? opts.toRoles : meta.defaultRoles
  const where: any = { tenantId, role: { in: roles as any[] }, status: 'ACTIVE' }

  if (meta.scopedBy === 'supplier' && opts.toSupplierIds?.length) {
    where.supplierId = { in: opts.toSupplierIds }
  } else if (meta.scopedBy === 'store' && opts.toStoreIds?.length) {
    // 多店店长用 storeIds 数组重叠匹配
    where.OR = [
      { storeId: { in: opts.toStoreIds } },
      { storeIds: { hasSome: opts.toStoreIds } },
    ]
  }
  const users = await prisma.user.findMany({ where, select: { id: true } })
  return users.map((u) => u.id)
}
