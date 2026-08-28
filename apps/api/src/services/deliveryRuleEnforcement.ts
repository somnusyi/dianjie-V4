/**
 * 配送班表下单拦截：enforce=true 的班表覆盖的门店+供应商，
 * 订货时段外下单、到货日非送货日、早于最快到货日，一律拦截并给出可操作的提示。
 */
import { prisma } from '@dianjie/db'
import { businessDateKey } from '../lib/businessTime'
import {
  earliestArrivalDate,
  isDeliveryDay,
  isEffectiveOn,
  isWithinOrderWindow,
} from './deliveryRuleDates'

const WEEKDAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日']

export async function checkDeliveryRuleBlock(params: {
  tenantId: string
  storeId: string
  supplierId: string
  expectedDate: string // YYYY-MM-DD
}): Promise<string | null> {
  const { tenantId, storeId, supplierId, expectedDate } = params
  const rules = await prisma.deliveryRule.findMany({
    where: {
      tenantId, status: 'ENABLED', enforce: true,
      stores: { some: { storeId } },
      OR: [{ supplierId }, { supplierId: null }],
    },
    orderBy: [{ createdAt: 'asc' }],
  })
  const today = businessDateKey()
  const active = rules.filter(rule => isEffectiveOn(rule, today))
  if (active.length === 0) return null
  const rule = active.find(item => item.supplierId === supplierId) || active[0]

  if (!isWithinOrderWindow(rule)) {
    return `当前不在「${rule.name}」允许订货时段（${rule.orderWindowStart}~${rule.orderWindowEnd}），请在时段内下单`
  }
  if (!isEffectiveOn(rule, expectedDate) || !isDeliveryDay(rule, expectedDate)) {
    const cadence = rule.deliveryScheduleMode === 'INTERVAL'
      ? `从起算日开始每隔 ${rule.deliveryIntervalDays} 天`
      : `每${rule.weekdays.map(day => `周${WEEKDAY_NAMES[day]}`).join('、')}`
    return `「${rule.name}」的送货日为${cadence}，到货日期请选择送货日`
  }
  const earliest = earliestArrivalDate(rule, today)
  if (earliest && expectedDate < earliest) {
    return `「${rule.name}」今天下单最快 ${earliest} 到货（下单后第 ${rule.leadDays} 个送货日），请调整到货日期`
  }
  return null
}
