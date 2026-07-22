/** 一次性：鲜花饼 7-21 错误行冲销+补记(3枚)、7-19 已作废行补记(5枚)。配方依据：总厨 7-22 发布 BOM v2 1份=1枚 */
import 'dotenv/config'
import { prisma } from '@dianjie/db'
import { voidConsumptionWithCorrection } from '../src/services/consumptionCorrection'

const APPLY = process.argv.includes('--apply')

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'dianjie' } })
  const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' } })
  const product = await prisma.product.findFirstOrThrow({ where: { tenantId: tenant.id, name: '烤制鲜花饼' } })

  // 7-21 错误行（未作废、sourceType=daily_pos、数量级 4323 枚）
  const row0721 = await prisma.stockConsumption.findFirstOrThrow({
    where: { tenantId: tenant.id, productId: product.id, date: new Date('2026-07-21'), voidedAt: null, sourceType: 'daily_pos', inventoryQuantity: { gt: 100 } },
  })
  const unitCost = Number(row0721.unitCostSnapshot)
  const corrected0721 = { qty: 3, cost: 3 * unitCost }
  console.log(`7-21 冲销+补记: id=${row0721.id} invQty=${row0721.inventoryQuantity} cost=${row0721.costAmountSnapshot} → 3 枚 / ¥${corrected0721.cost.toFixed(4)}`)

  // 7-19 已作废行 → 补记 5 枚
  const voided0719 = await prisma.stockConsumption.findFirstOrThrow({
    where: { tenantId: tenant.id, productId: product.id, date: new Date('2026-07-19'), voidedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
  })
  const exists0719 = await prisma.stockConsumption.findFirst({ where: { sourceType: 'correction', sourceId: voided0719.id } })
  const unitCost0719 = Number(voided0719.unitCostSnapshot)
  console.log(`7-19 补记: 原行 id=${voided0719.id} → 5 枚 / ¥${(5 * unitCost0719).toFixed(4)} ${exists0719 ? '(已存在补记, 跳过)' : ''}`)

  if (!APPLY) { console.log('DRY-RUN，确认后加 --apply'); return }
  await prisma.$transaction(async tx => {
    const r = await voidConsumptionWithCorrection(tx, {
      consumptionId: row0721.id, tenantId: tenant.id,
      reason: 'BOM v1 配方错误(1份≠1441枚)的末次错误扣减；总厨 7-22 已发布 v2(1份=1枚)，按 3份×1枚 补记',
      voidedById: admin.id,
      correctedQuantity: 3, correctedInventoryQuantity: 3, correctedCostAmount: corrected0721.cost.toFixed(4),
    })
    console.log('7-21 ✓ voided', r.voidedId, 'correction', r.correctionId)
    if (!exists0719) {
      await tx.stockConsumption.create({
        data: {
          tenantId: voided0719.tenantId, storeId: voided0719.storeId, productId: voided0719.productId,
          date: voided0719.date, quantity: 5, inventoryQuantity: 5,
          unitSnapshot: voided0719.unitSnapshot, inventoryUnitSnapshot: voided0719.inventoryUnitSnapshot,
          unitCostSnapshot: voided0719.unitCostSnapshot, costAmountSnapshot: (5 * unitCost0719).toFixed(4),
          note: voided0719.note, dishId: voided0719.dishId, variantKey: voided0719.variantKey,
          bomVersionId: voided0719.bomVersionId, sourceType: 'correction', sourceId: voided0719.id,
          sourceLineKey: 'correction', correctionOfId: voided0719.id,
          calculationSnapshot: { correctionOf: voided0719.id, originalInventoryQuantity: voided0719.inventoryQuantity?.toString() ?? null, reason: '总厨 7-22 确认 1份=1枚，补记 5份×1枚' },
          createdById: admin.id,
        },
      })
      console.log('7-19 ✓ 补记已写入')
    }
  })
}
main().finally(() => prisma.$disconnect())
