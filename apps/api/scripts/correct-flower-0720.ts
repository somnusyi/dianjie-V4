/** 一次性：鲜花饼 7-20 错误行(1441.09231枚)冲销 + 按总厨确认配方 1份×1枚 补记 */
import 'dotenv/config'
import { prisma } from '@dianjie/db'
import { voidConsumptionWithCorrection } from '../src/services/consumptionCorrection'

const APPLY = process.argv.includes('--apply')

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'dianjie' } })
  const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' } })
  const product = await prisma.product.findFirstOrThrow({ where: { tenantId: tenant.id, name: '烤制鲜花饼' } })
  const row = await prisma.stockConsumption.findFirstOrThrow({
    where: { tenantId: tenant.id, productId: product.id, date: new Date('2026-07-20'), voidedAt: null, sourceType: 'daily_pos', inventoryQuantity: { gt: 100 } },
  })
  const unitCost = Number(row.unitCostSnapshot)
  console.log(`7-20 冲销+补记: id=${row.id} invQty=${row.inventoryQuantity} cost=${row.costAmountSnapshot} → 1 枚 / ¥${unitCost.toFixed(4)}`)
  if (!APPLY) { console.log('DRY-RUN，确认后加 --apply'); return }
  const r = await prisma.$transaction(tx => voidConsumptionWithCorrection(tx, {
    consumptionId: row.id, tenantId: tenant.id,
    reason: 'BOM v1 配方错误(1份≠1441枚)在 7-20 的漏网错误扣减；总厨 7-22 已确认 1份=1枚，按 1份×1枚 补记',
    voidedById: admin.id,
    correctedQuantity: 1, correctedInventoryQuantity: 1, correctedCostAmount: unitCost.toFixed(4),
  }))
  console.log('✓ voided', r.voidedId, 'correction', r.correctionId)
}
main().finally(() => prisma.$disconnect())
