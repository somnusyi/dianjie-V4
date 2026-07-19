/**
 * One-off audited correction for confirmed BOM packaging mistakes.
 *
 * Dry-run by default. Production write requires:
 *   --commit --confirm=correct-20260719-bom-units
 */
import 'dotenv/config'
import { Prisma, prisma } from '@dianjie/db'

const CONFIRM = 'correct-20260719-bom-units'
const REASON = '2026-07-19 包装单位纠错：3Gg→3kg，乌苏6罐/箱，生蚝18个/箱'
const EFFECTIVE_DATE = new Date('2026-07-19T00:00:00.000Z')
const WUSU_FUTURE_DATE = new Date('2026-07-20T00:00:00.000Z')

type ItemWithProduct = Prisma.DishBomItemGetPayload<{ include: { product: true } }>

const dateText = (value: Date | null | undefined) => value?.toISOString().slice(0, 10) || null

function selectEffectiveDefaultVersion<T extends {
  status: string; variantKey: string; effectiveFrom: Date | null; effectiveTo: Date | null; versionNo: number
}>(versions: T[], businessDate: Date) {
  const target = dateText(businessDate)!
  return versions
    .filter(version => version.status === 'PUBLISHED'
      && version.variantKey === ''
      && Boolean(version.effectiveFrom)
      && dateText(version.effectiveFrom)! <= target
      && (!version.effectiveTo || dateText(version.effectiveTo)! >= target))
    .sort((left, right) => {
      const byDate = dateText(right.effectiveFrom)!.localeCompare(dateText(left.effectiveFrom)!)
      return byDate || right.versionNo - left.versionNo
    })[0] || null
}

async function main() {
  const args = process.argv.slice(2)
  const commit = args.includes('--commit')
  const confirmation = args.find(arg => arg.startsWith('--confirm='))?.slice('--confirm='.length)
  if (commit && confirmation !== CONFIRM) throw new Error(`写入需 --confirm=${CONFIRM}`)

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'dianjie' } })
  const [operator, products, dishes] = await Promise.all([
    prisma.user.findFirst({
      where: { tenantId: tenant.id, status: 'ACTIVE', role: { in: ['CHEF_DIRECTOR', 'ADMIN', 'CHEF'] } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.product.findMany({
      where: {
        tenantId: tenant.id,
        code: { in: ['ZZ9M-2DYLCX', 'ZZ9M-2DYLD1', 'ZZ9M-2DYLBF', 'ZZ9M-2DYL8C', 'DJ-BOM-C449034135'] },
      },
    }),
    prisma.dish.findMany({
      where: { tenantId: tenant.id, name: { in: ['芒芒雪酪', '轻颜羽衣甘蓝', '乌苏1L罐装', '海味四重奏'] } },
      include: {
        bomVersions: {
          orderBy: { versionNo: 'asc' },
          include: { items: { include: { product: true } } },
        },
      },
    }),
  ])
  const productByCode = new Map(products.map(product => [product.code, product]))
  const dishByName = new Map(dishes.map(dish => [dish.name, dish]))
  for (const code of ['ZZ9M-2DYLCX', 'ZZ9M-2DYLD1', 'ZZ9M-2DYLBF', 'ZZ9M-2DYL8C', 'DJ-BOM-C449034135']) {
    if (!productByCode.has(code)) throw new Error(`缺少商品 ${code}`)
  }
  for (const name of ['芒芒雪酪', '轻颜羽衣甘蓝', '乌苏1L罐装', '海味四重奏']) {
    if (!dishByName.has(name)) throw new Error(`缺少菜品 ${name}`)
  }

  const affectedDishIds = dishes.map(dish => dish.id)
  const affectedConsumptions = await prisma.stockConsumption.count({
    where: { tenantId: tenant.id, dishId: { in: affectedDishIds }, date: { gte: EFFECTIVE_DATE } },
  })
  const alreadyApplied = await prisma.opLog.findFirst({
    where: { tenantId: tenant.id, action: 'BOM包装单位纠错', target: CONFIRM },
  })
  const report = {
    mode: commit ? 'commit' : 'dry-run',
    tenant: tenant.slug,
    auditOperator: operator ? `${operator.name}(${operator.role})` : null,
    alreadyApplied: Boolean(alreadyApplied),
    affectedConsumptions,
    productCorrections: [
      { code: 'ZZ9M-2DYLCX', name: productByCode.get('ZZ9M-2DYLCX')!.name, from: productByCode.get('ZZ9M-2DYLCX')!.spec, to: '3kg/桶' },
      { code: 'ZZ9M-2DYLD1', name: productByCode.get('ZZ9M-2DYLD1')!.name, from: productByCode.get('ZZ9M-2DYLD1')!.spec, to: '3kg/桶' },
      { code: 'ZZ9M-2DYL8C', name: productByCode.get('ZZ9M-2DYL8C')!.name, from: productByCode.get('ZZ9M-2DYL8C')!.spec, to: '18个/箱' },
    ],
    bomCorrections: [
      { dish: '芒芒雪酪', product: '芒果果酱', quantity: 0.026, unit: '桶' },
      { dish: '轻颜羽衣甘蓝', product: '奇异果果酱', quantity: 0.018333, unit: '桶' },
      { dish: '乌苏1L罐装', product: '乌苏罐装', quantity: 0.166667, unit: '箱' },
      { dish: '海味四重奏', product: '生蚝-牡蛎半壳', quantity: 0.111111, unit: '箱' },
    ],
  }
  console.log(JSON.stringify(report, null, 2))
  if (!commit || alreadyApplied) return
  if (!operator) throw new Error('没有可用于审计记录的总厨/管理员账号')
  if (affectedConsumptions > 0) {
    throw new Error('受影响菜品在纠错生效日后已有库存消耗，请先制定冲正方案，禁止直接改BOM')
  }

  await prisma.$transaction(async tx => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`bom-unit-correction:${tenant.id}:${CONFIRM}`}))`)

    await tx.product.updateMany({
      where: { tenantId: tenant.id, code: { in: ['ZZ9M-2DYLCX', 'ZZ9M-2DYLD1'] } },
      data: { spec: '3kg/桶' },
    })
    await tx.product.update({
      where: { id: productByCode.get('ZZ9M-2DYL8C')!.id },
      data: { spec: '18个/箱' },
    })

    const publishCorrection = async (input: {
      dishName: string
      effectiveFrom: Date
      transform: (items: ItemWithProduct[]) => Array<{
        productId: string; quantity: number; unit: string; lossRate: Prisma.Decimal
        isMain: boolean; note: string | null
      }>
    }) => {
      const dish = await tx.dish.findFirstOrThrow({
        where: { tenantId: tenant.id, name: input.dishName },
        include: {
          bomVersions: {
            orderBy: { versionNo: 'asc' },
            include: { items: { include: { product: true } } },
          },
        },
      })
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`dish-bom:${tenant.id}:${dish.id}:`}))`)
      const source = selectEffectiveDefaultVersion(dish.bomVersions, input.effectiveFrom)
        || [...dish.bomVersions].reverse().find(version => version.status === 'PUBLISHED' && version.variantKey === '')
      if (!source) throw new Error(`${input.dishName} 没有可纠正的已发布默认BOM`)
      const items = input.transform(source.items as ItemWithProduct[])
      const startText = dateText(input.effectiveFrom)!
      const dayBefore = new Date(input.effectiveFrom)
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)
      const following = dish.bomVersions
        .filter(version => version.status === 'PUBLISHED' && version.effectiveFrom && version.effectiveFrom > input.effectiveFrom)
        .sort((left, right) => left.effectiveFrom!.getTime() - right.effectiveFrom!.getTime())[0]
      const effectiveTo = following?.effectiveFrom ? new Date(following.effectiveFrom) : null
      if (effectiveTo) effectiveTo.setUTCDate(effectiveTo.getUTCDate() - 1)
      await tx.dishBomVersion.updateMany({
        where: {
          dishId: dish.id, variantKey: '', status: 'PUBLISHED',
          effectiveFrom: { lt: input.effectiveFrom },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.effectiveFrom } }],
        },
        data: { effectiveTo: dayBefore },
      })
      await tx.dishBomVersion.updateMany({
        where: { dishId: dish.id, variantKey: '', status: 'PUBLISHED', effectiveFrom: input.effectiveFrom },
        data: { status: 'RETIRED' },
      })
      const latestVersionNo = Math.max(0, ...dish.bomVersions.map(version => version.versionNo))
      const created = await tx.dishBomVersion.create({
        data: {
          tenantId: tenant.id, dishId: dish.id, variantKey: '', versionNo: latestVersionNo + 1,
          status: 'PUBLISHED', changeType: 'HISTORICAL_CORRECTION', changeReason: REASON,
          effectiveFrom: input.effectiveFrom, effectiveTo,
          createdById: operator.id, publishedById: operator.id, publishedAt: new Date(),
          items: { create: items },
        },
      })
      if (startText <= '2026-07-19') {
        await tx.dishRecipe.deleteMany({ where: { dishId: dish.id, variantKey: '' } })
        await tx.dishRecipe.createMany({
          data: items.map(item => ({ dishId: dish.id, variantKey: '', ...item })),
        })
      }
      await tx.opLog.create({
        data: {
          tenantId: tenant.id, userId: operator.id, role: operator.role,
          action: `发布菜品 BOM v${created.versionNo}`, target: dish.name,
          targetId: created.id, entityType: 'DishBomVersion',
          metadata: { variantKey: '', effectiveFrom: startText, changeType: 'HISTORICAL_CORRECTION', reason: REASON },
        },
      })
    }

    const changeQuantity = (productCode: string, quantity: number) => (items: ItemWithProduct[]) => {
      let matched = false
      const next = items.map(item => {
        if (item.product.code !== productCode) return {
          productId: item.productId, quantity: Number(item.quantity), unit: item.unit,
          lossRate: item.lossRate, isMain: item.isMain, note: item.note,
        }
        matched = true
        return {
          productId: item.productId, quantity, unit: item.unit,
          lossRate: item.lossRate, isMain: item.isMain,
          note: `${item.note || ''}；${REASON}`.slice(0, 500),
        }
      })
      if (!matched) throw new Error(`BOM中找不到商品 ${productCode}`)
      return next
    }

    await publishCorrection({ dishName: '芒芒雪酪', effectiveFrom: EFFECTIVE_DATE, transform: changeQuantity('ZZ9M-2DYLCX', 0.026) })
    await publishCorrection({ dishName: '轻颜羽衣甘蓝', effectiveFrom: EFFECTIVE_DATE, transform: changeQuantity('ZZ9M-2DYLD1', 0.018333) })
    await publishCorrection({ dishName: '乌苏1L罐装', effectiveFrom: EFFECTIVE_DATE, transform: changeQuantity('ZZ9M-2DYLBF', 0.166667) })
    await publishCorrection({ dishName: '乌苏1L罐装', effectiveFrom: WUSU_FUTURE_DATE, transform: changeQuantity('ZZ9M-2DYLBF', 0.166667) })

    const oysterProduct = productByCode.get('ZZ9M-2DYL8C')!
    const temporaryOyster = productByCode.get('DJ-BOM-C449034135')!
    await publishCorrection({
      dishName: '海味四重奏', effectiveFrom: EFFECTIVE_DATE,
      transform: items => {
        let matched = false
        const next = items.map(item => {
          if (item.productId !== temporaryOyster.id) return {
            productId: item.productId, quantity: Number(item.quantity), unit: item.unit,
            lossRate: item.lossRate, isMain: item.isMain, note: item.note,
          }
          matched = true
          return {
            productId: oysterProduct.id, quantity: 0.111111, unit: oysterProduct.unit,
            lossRate: item.lossRate, isMain: item.isMain,
            note: `2个；按确认规则1箱=18个换算；${REASON}`,
          }
        })
        if (!matched) throw new Error('海味四重奏BOM中找不到临时生蚝SKU')
        return next
      },
    })
    await tx.product.update({ where: { id: temporaryOyster.id }, data: { status: 'DISABLED' } })

    await tx.opLog.create({
      data: {
        tenantId: tenant.id, userId: operator.id, role: operator.role,
        action: 'BOM包装单位纠错', target: CONFIRM, entityType: 'DataCorrection',
        metadata: { reason: REASON, effectiveDate: dateText(EFFECTIVE_DATE), affectedConsumptions },
      },
    })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 })
  console.log(JSON.stringify({ ok: true, correction: CONFIRM }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
