import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'

const TABLE_MAP: Record<string, any> = {
  RK: 'receipt',
  PO: 'purchaseOrder',
  DC: 'reconciliation',
  PY: 'payment',
  LC: 'lossClaim',
}

export async function generateNo(prefix: string, tenantId: string): Promise<string> {
  const ym = dayjs().format('YYYYMM')
  const startNo = `${prefix}${ym}`

  const model = TABLE_MAP[prefix]
  let count = 0

  try {
    if (model && (prisma as any)[model]) {
      count = await (prisma as any)[model].count({
        where: { tenantId, no: { startsWith: startNo } }
      })
    }
  } catch {
    count = 0
  }

  return `${startNo}${String(count + 1).padStart(6, '0')}`
}
