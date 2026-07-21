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
  PO_ACCEPTED: {
    label: '订单已接单',
    desc: '供应商点接单 → 通知下单门店(店长/厨师长)',
    defaultRoles: ['KITCHEN_LEAD', 'MANAGER'],
    scopedBy: 'store',
    urgent: false,
  },
  PO_RECEIVED: {
    label: '验收完成',
    desc: '门店确认收货 → 通知供应商(可结算)',
    defaultRoles: ['SUPPLIER_OWNER', 'SUPPLIER_STAFF'],
    scopedBy: 'supplier',
    urgent: false,
  },
  LOSS_AGREED: {
    label: '报损已通过',
    desc: '供应商同意报损 → 通知门店(店长/厨师长)',
    defaultRoles: ['KITCHEN_LEAD', 'MANAGER'],
    scopedBy: 'store',
    urgent: false,
  },
  PO_AUTO_RECEIVED: {
    label: '超时自动收货',
    desc: '送达 24h 未验收自动收货 → 提醒厨师长',
    defaultRoles: ['KITCHEN_LEAD'],
    scopedBy: 'store',
    urgent: false,
  },
  USER_APPLICATION_PENDING: {
    label: '账号申请待审批',
    desc: '公开入口提交账号申请 → 老板/管理员审批 (BOSS 是 ADMIN 的 v2 别名, 库枚举只有 ADMIN)',
    defaultRoles: ['ADMIN', 'SUPER_ADMIN'],
    scopedBy: 'tenant',
    urgent: false,
  },
  BOM_TASK_PENDING: {
    label: '日报缺 BOM 待办',
    desc: '日报确认产生缺 BOM 暂缓菜品 → 总厨补齐 (一次日报聚合成一条)',
    defaultRoles: ['CHEF_DIRECTOR'],
    scopedBy: 'tenant',
    urgent: false,
  },
  COUNT_PENDING_CONFIRM: {
    label: '盘点待确认',
    desc: '门店盘点单提交待确认 → 厨师长/店长核对确认',
    defaultRoles: ['KITCHEN_LEAD', 'MANAGER'],
    scopedBy: 'store',
    urgent: false,
  },
  DAILY_REPORT_MISSING: {
    label: '日报未上传提醒',
    desc: '每天 11:00 检查前一营业日已确认日报, 缺失 → 提醒店长/厨师长 (每店每天最多一条)',
    defaultRoles: ['MANAGER', 'KITCHEN_LEAD'],
    scopedBy: 'store',
    urgent: false,
  },
  DATA_QUALITY_TASK: {
    label: '数据质量待办',
    desc: '系统审计发现主数据/规格/换算待确认 → 总厨确认修正 (一次审计聚合成一条)',
    defaultRoles: ['CHEF_DIRECTOR'],
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
    case 'PO_ACCEPTED':
      return {
        kind: 'textcard',
        textcard: {
          title: `✅ 订单已接单 #${payload.no || ''}`,
          description: `${payload.supplierName || '供应商'} 已接单,正在备货。请留意后续发货通知。`,
          url: `${baseUrl()}/v2/chef/purchase/${payload.orderId}`,
          btntxt: '查看订单',
        },
      }
    case 'PO_RECEIVED':
      return {
        kind: 'textcard',
        textcard: {
          title: `📦 验收完成 #${payload.no || ''}`,
          description: `门店已确认收货,实收金额 ¥${fmt(payload.total)}${payload.hasLoss ? ' (含报损待处理)' : ',可结算'}。`,
          url: `${baseUrl()}/v2/supplier/orders/${payload.orderId}`,
          btntxt: '查看',
        },
      }
    case 'LOSS_AGREED':
      return {
        kind: 'textcard',
        textcard: {
          title: `✅ 报损已通过 ${payload.lossNo || ''}`,
          description: `供应商已同意 ¥${fmt(payload.amount)} 报损,库存已回补。`,
          url: `${baseUrl()}/v2/chef/purchase/${payload.orderId}`,
          btntxt: '查看',
        },
      }
    case 'PO_AUTO_RECEIVED':
      return {
        kind: 'textcard',
        textcard: {
          title: `⏰ 订单超时自动收货 #${payload.no || ''}`,
          description: `该订单送达 24h 内未验收,系统已自动确认收货。如有短量请及时报损。`,
          url: `${baseUrl()}/v2/chef/purchase/${payload.orderId}`,
          btntxt: '查看',
        },
      }
    case 'USER_APPLICATION_PENDING':
      return {
        kind: 'textcard',
        textcard: {
          title: `👤 新账号申请待审批`,
          description: `${payload.name || '申请人'} (${payload.phone || '-'}) 申请${payload.roleLabel || payload.requestedRole || '账号'}${payload.storeName ? ` · ${payload.storeName}` : ''}${payload.supplierName ? ` · ${payload.supplierName}` : ''},请审批。`,
          url: `${baseUrl()}/v2/me/applications`,
          btntxt: '去审批',
        },
      }
    case 'BOM_TASK_PENDING':
      return {
        kind: 'textcard',
        textcard: {
          title: `🧾 日报缺 BOM ${payload.count || 0} 项待补`,
          description: `${payload.storeName || '门店'} ${payload.bizDate || ''} 日报:${payload.dishNames || ''}。补齐 BOM 后自动回补当日库存消耗。`,
          url: `${baseUrl()}/v2/chef-director/bom`,
          btntxt: '去补 BOM',
        },
      }
    case 'COUNT_PENDING_CONFIRM':
      return {
        kind: 'textcard',
        textcard: {
          title: `📋 盘点待确认 ${payload.no || ''}`,
          description: `${payload.storeName || '门店'} ${payload.submittedByName || ''} 提交了盘点单,共 ${payload.itemCount ?? '-'} 项,请核对差异后确认。`,
          url: `${baseUrl()}/v2/inventory-counts/${payload.countId}`,
          btntxt: '去确认',
        },
      }
    case 'DATA_QUALITY_TASK':
      return {
        kind: 'textcard',
        textcard: {
          title: `🧹 数据质量待办 ${payload.count || 0} 项`,
          description: `${payload.summary || ''}。请核对后在系统内修正,有疑问联系管理员。`,
          url: payload.url || `${baseUrl()}/v2/chef-director/bom`,
          btntxt: '去处理',
        },
      }
    case 'DAILY_REPORT_MISSING':
      return {
        kind: 'textcard',
        textcard: {
          title: `📅 ${payload.bizDate || '昨日'} 日报未确认`,
          description: `${payload.storeName || '门店'} 前一营业日双表日报还未确认上传,请尽快补传并确认,否则当日消耗与营收无数据。`,
          url: `${baseUrl()}/v2/manager/upload-platform`,
          btntxt: '去上传',
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
