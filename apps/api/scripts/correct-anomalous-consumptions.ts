/**
 * 一次性修正脚本：冲销 + 补记 7-16~7-19 单位换算 bug 产生的异常消耗行
 *
 * 背景: stock_consumptions 一批 daily_pos 行因单位换算 bug 数量虚高，
 *       导致「食材成本」卡虚高 ~¥16,500。按审计惯例采用「冲销 + 补记」：
 *       原行标记作废保留，按正确数量补记新行 (sourceType='correction')。
 *       烤制鲜花饼 7-19 行只冲销不补记 (真实配方待总厨确认)。
 *
 * 定位方式: productId + date + inventoryQuantity 匹配 (不硬编码行 id)；
 * 已作废的行自动跳过，可安全重复执行。
 *
 * 用法 (在 apps/api 目录下, 自动读 .env 的 DATABASE_URL):
 *   干跑 (默认, 不写库):  npx tsx scripts/correct-anomalous-consumptions.ts
 *   实际执行:             npx tsx scripts/correct-anomalous-consumptions.ts --apply
 * 指定库:                 DATABASE_URL="postgresql://..." npx tsx scripts/correct-anomalous-consumptions.ts
 */
import 'dotenv/config'
import { Prisma, prisma } from '@dianjie/db'
import { voidConsumptionWithCorrection } from '../src/services/consumptionCorrection'

type Target = {
  productId: string
  productName: string
  date: string // YYYY-MM-DD
  matchInventoryQuantity: string // 原行 inventoryQuantity (Decimal 等值匹配)
  correctedInventoryQuantity: string | null // null = 只冲销不补记
  reason: string
}

const inflateReason = (times: string) =>
  `单位换算 bug 导致扣减数量虚高（×${times}），冲销后按正确数量补记`

// 清单已与本地生产副本 dianjie_prod_copy_20260721 逐行核对 (2026-07-22)。
const TARGETS: Target[] = [
  // ── 奇异果果酱 (1桶=3000g, BOM 把 55g/份 录成 55kg 量级, ×1000) ──
  { productId: 'cmp2dyld2007ndjcn53exbto1', productName: '奇异果果酱', date: '2026-07-17',
    matchInventoryQuantity: '54999.999', correctedInventoryQuantity: '55', reason: inflateReason('1000') },
  { productId: 'cmp2dyld2007ndjcn53exbto1', productName: '奇异果果酱', date: '2026-07-18',
    matchInventoryQuantity: '329999.994', correctedInventoryQuantity: '330', reason: inflateReason('1000') },

  // ── SevenQ茉莉绿茶 (1袋=15000g, ×30) ──
  { productId: 'cmp2dylbv006fdjcngop1z2x6', productName: 'SevenQ茉莉绿茶', date: '2026-07-18',
    matchInventoryQuantity: '900', correctedInventoryQuantity: '30', reason: inflateReason('30') },
  { productId: 'cmp2dylbv006fdjcngop1z2x6', productName: 'SevenQ茉莉绿茶', date: '2026-07-18',
    matchInventoryQuantity: '200.4', correctedInventoryQuantity: '6.68', reason: inflateReason('30') },
  { productId: 'cmp2dylbv006fdjcngop1z2x6', productName: 'SevenQ茉莉绿茶', date: '2026-07-18',
    matchInventoryQuantity: '1000.5', correctedInventoryQuantity: '33.35', reason: inflateReason('30') },
  { productId: 'cmp2dylbv006fdjcngop1z2x6', productName: 'SevenQ茉莉绿茶', date: '2026-07-18',
    matchInventoryQuantity: '750', correctedInventoryQuantity: '25', reason: inflateReason('30') },

  // ── 水牛毛肚 (1包=2500g, ×10) ──
  { productId: 'cmp2dyl7f0023djcnb4cc31tp', productName: '水牛毛肚', date: '2026-07-16',
    matchInventoryQuantity: '7375', correctedInventoryQuantity: '737.5', reason: inflateReason('10') },
  { productId: 'cmp2dyl7f0023djcnb4cc31tp', productName: '水牛毛肚', date: '2026-07-17',
    matchInventoryQuantity: '5010', correctedInventoryQuantity: '501', reason: inflateReason('10') },
  { productId: 'cmp2dyl7f0023djcnb4cc31tp', productName: '水牛毛肚', date: '2026-07-18',
    matchInventoryQuantity: '3340', correctedInventoryQuantity: '334', reason: inflateReason('10') },
  { productId: 'cmp2dyl7f0023djcnb4cc31tp', productName: '水牛毛肚', date: '2026-07-18',
    matchInventoryQuantity: '695', correctedInventoryQuantity: '69.5', reason: inflateReason('10') },

  // ── 猪黄喉 (1包=2500g, ×10) ──
  { productId: 'cmp2dyl7h0025djcnshtrmprm', productName: '猪黄喉', date: '2026-07-18',
    matchInventoryQuantity: '580', correctedInventoryQuantity: '58', reason: inflateReason('10') },

  // ── 斤/kg 混淆 (×2) ──
  { productId: 'cmp2dylby006jdjcnt8dd9lxc', productName: '凤梨果酱', date: '2026-07-18',
    matchInventoryQuantity: '83.001', correctedInventoryQuantity: '41.5005', reason: inflateReason('2') },
  { productId: 'cmp2dylaz005jdjcngyj2nnr1', productName: '特级丘北辣椒', date: '2026-07-18',
    matchInventoryQuantity: '40', correctedInventoryQuantity: '20', reason: inflateReason('2') },
  { productId: 'cmp2dylaz005jdjcngyj2nnr1', productName: '特级丘北辣椒', date: '2026-07-18',
    matchInventoryQuantity: '24', correctedInventoryQuantity: '12', reason: inflateReason('2') },
  { productId: 'cmp2dylb3005ndjcn3q2n950y', productName: '特级子弹头', date: '2026-07-18',
    matchInventoryQuantity: '20', correctedInventoryQuantity: '10', reason: inflateReason('2') },
  { productId: 'cmp2dylax005hdjcnxxskh795', productName: '特级灯笼椒', date: '2026-07-18',
    matchInventoryQuantity: '20', correctedInventoryQuantity: '10', reason: inflateReason('2') },
  { productId: 'cmp2dyle0008hdjcncb1gkyw1', productName: '马蹄爆爆珠', date: '2026-07-18',
    matchInventoryQuantity: '19.9998', correctedInventoryQuantity: '9.9999', reason: inflateReason('2') },
  { productId: 'cmp2dyle0008hdjcncb1gkyw1', productName: '马蹄爆爆珠', date: '2026-07-18',
    matchInventoryQuantity: '79.9992', correctedInventoryQuantity: '39.9996', reason: inflateReason('2') },

  // ── 烤制鲜花饼: BOM 配方录入错误, 只冲销不补记 ──
  { productId: 'cmp2dyl8x003jdjcncf4hlx0x', productName: '烤制鲜花饼', date: '2026-07-19',
    matchInventoryQuantity: '7205.46155', correctedInventoryQuantity: null,
    reason: 'BOM 配方录入错误（1份≠1441枚），待总厨确认真实配方后补记' },
]

async function main() {
  const apply = process.argv.includes('--apply')
  console.log(apply ? '模式: APPLY (实际写库)' : '模式: DRY-RUN (仅打印改动, 加 --apply 才写库)')

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, email: true, tenantId: true },
  })
  if (!admin) throw new Error('未找到 ACTIVE 的 ADMIN 用户作为 voidedById')
  console.log(`冲销操作人 (voidedById): ${admin.name} <${admin.email}> (${admin.id})\n`)

  const stats = { corrected: 0, voidOnly: 0, skipped: 0, missing: 0 }
  for (const target of TARGETS) {
    const rows = await prisma.stockConsumption.findMany({
      where: {
        productId: target.productId,
        date: new Date(`${target.date}T00:00:00.000Z`),
        inventoryQuantity: new Prisma.Decimal(target.matchInventoryQuantity),
      },
      orderBy: { createdAt: 'asc' },
    })
    const label = `[${target.date}] ${target.productName} (invQty=${target.matchInventoryQuantity})`
    if (rows.length === 0) {
      console.log(`✗ ${label} 未找到匹配行`)
      stats.missing += 1
      continue
    }
    const active = rows.filter(row => !row.voidedAt)
    if (active.length === 0) {
      console.log(`↷ ${label} 已冲销过，跳过`)
      stats.skipped += 1
      continue
    }
    if (active.length > 1) {
      console.log(`✗ ${label} 匹配到 ${active.length} 行未作废记录，跳过待人工核对`)
      stats.missing += 1
      continue
    }

    const original = active[0]
    const correctedInv = target.correctedInventoryQuantity == null
      ? null
      : new Prisma.Decimal(target.correctedInventoryQuantity)
    let correctedQty: Prisma.Decimal | null = null
    let correctedCost: Prisma.Decimal | null = null
    if (correctedInv != null) {
      // 采购单位口径按原行隐含换算比缩放: qty × 修正库存量 ÷ 原库存量
      correctedQty = original.inventoryQuantity != null && original.inventoryQuantity.gt(0)
        ? new Prisma.Decimal(original.quantity).mul(correctedInv).div(original.inventoryQuantity).toDecimalPlaces(6)
        : correctedInv
      correctedCost = original.unitCostSnapshot != null
        ? correctedInv.mul(original.unitCostSnapshot).toDecimalPlaces(4)
        : null
    }

    console.log(`→ ${label}`)
    console.log(`    冲销: id=${original.id} qty=${original.quantity} invQty=${original.inventoryQuantity} cost=${original.costAmountSnapshot ?? 'null'}`)
    if (correctedInv != null) {
      console.log(`    补记: qty=${correctedQty} invQty=${correctedInv} cost=${correctedCost ?? 'null'} (unitCost=${original.unitCostSnapshot ?? 'null'})`)
    } else {
      console.log(`    不补记 (${target.reason})`)
    }

    if (apply) {
      await prisma.$transaction(tx => voidConsumptionWithCorrection(tx, {
        consumptionId: original.id,
        tenantId: original.tenantId,
        reason: target.reason,
        voidedById: admin.id,
        correctedQuantity: correctedQty,
        correctedInventoryQuantity: correctedInv,
        correctedCostAmount: correctedCost,
      }))
      console.log('    ✓ 已写入')
    }
    if (correctedInv != null) stats.corrected += 1
    else stats.voidOnly += 1
  }

  console.log(`\n汇总: 冲销+补记 ${stats.corrected} 行, 仅冲销 ${stats.voidOnly} 行, 已处理跳过 ${stats.skipped} 行, 未匹配 ${stats.missing} 行`)
  if (!apply) console.log('以上为 DRY-RUN，确认无误后加 --apply 执行。')
}

main().finally(() => prisma.$disconnect())
