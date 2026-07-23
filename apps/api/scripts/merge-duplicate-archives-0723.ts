/**
 * 重复商品档案合并（2026-07-23，盘点差异分析发现）
 *
 * 原则（铁律：历史单据冻结）：
 *   - 不修改任何历史单据：receiptItems / stockConsumptions / lossClaimItems / inventorySnapshotItems 一律不动
 *   - 只迁移主数据：dish_recipes、dish_bom_items、store_inventory_policies
 *   - 重复档案停用（status=DISABLED，改名 [已并入]），账面偏差由 7.22 新基线一次归零
 *
 * 用法：
 *   npx tsx scripts/merge-duplicate-archives-0723.ts          # dry-run
 *   npx tsx scripts/merge-duplicate-archives-0723.ts --apply  # 执行
 */
import 'dotenv/config'
import { prisma } from '@dianjie/db'

const APPLY = process.argv.includes('--apply')

type Merge = {
  label: string
  survivor: { id: string; name: string; invUnit: string }
  dup: { id: string; name: string }
  // dup 配方单位 → survivor 库存单位 的换算系数；null = 该档案不应有配方，发现即报错
  recipeFactor: number | null
  factorNote: string
  // 可选：合并前先把存续方库存单位改掉（如 箱→袋）
  survivorUnitFix?: { inventoryUnit: string; unitsPerPurchaseUnit: number; stockFactor: number }
}

const MERGES: Merge[] = [
  {
    label: '胡萝卜汁（三档案合一）',
    survivor: { id: 'cmp2dylcq007bdjcn1vm2a4es', name: '冷冻香橙胡萝卜汁', invUnit: '包' },
    dup: { id: 'cmp2dylef008rdjcniavcai11', name: '胡萝卜香橙（果汁包）' },
    recipeFactor: 1, // 1袋=1包，实盘60袋 vs 基准66包互证
    factorNote: '1袋=1包（实盘互证，待采购确认）',
  },
  {
    label: '胡萝卜汁（g 档案并入）',
    survivor: { id: 'cmp2dylcq007bdjcn1vm2a4es', name: '冷冻香橙胡萝卜汁', invUnit: '包' },
    dup: { id: 'cmrocnofo002spapyven68x76', name: '冷冻胡萝卜香橙汁' },
    recipeFactor: null, // g 档案的配方行与袋档案重复（一杯扣两次），应删除而不是换算
    factorNote: '配方行与袋档案重复，直接删除（双重扣减）',
  },
  {
    label: '清远鸡（真空并入盒装）',
    survivor: { id: 'cmpwjeqbd000w10o6wui0o0xy', name: '清远鸡盒装', invUnit: '盒' },
    dup: { id: 'cmp2dyl78001xdjcnmx51yafq', name: '清远鸡（真空包装）' },
    recipeFactor: null, // 配方都挂在盒装上；真空档案不应有配方
    factorNote: '1箱≈13盒（四柱推算，待采购确认；本次只停用，不迁移单据）',
  },
  {
    label: '竹荪（件并入 g）',
    survivor: { id: 'cmp2dyl5m000ddjcnj9r93n0o', name: '竹荪', invUnit: 'g' },
    dup: { id: 'cmrlri26x008g133216dhvven', name: '竹荪' },
    recipeFactor: 500, // 件/500g
    factorNote: '1件=500g（spec 件/500g）',
  },
  {
    label: '羽衣甘蓝（叶子并入果汁包，存续方单位 箱→袋）',
    survivor: { id: 'cmp2dyleh008tdjcn847umea7', name: '羽衣甘蓝汁（果汁包）', invUnit: '袋' },
    dup: { id: 'cmrocnoga003epapy2zh767h6', name: '羽衣甘蓝叶子' },
    recipeFactor: 1 / 150, // g→袋：1袋=150g
    factorNote: '1袋=150g、1箱=100袋（spec 箱/150g/100袋，已验证）',
    survivorUnitFix: { inventoryUnit: '袋', unitsPerPurchaseUnit: 100, stockFactor: 100 }, // 采购单位仍是箱，1箱=100袋
  },
]

async function countRefs(productId: string) {
  const [recipes, bomItems, policies, receipts, consumptions, losses, snapshotItems, poItems, doItems] =
    await Promise.all([
      prisma.dishRecipe.count({ where: { productId } }),
      prisma.dishBomItem.count({ where: { productId } }),
      prisma.storeInventoryPolicy.count({ where: { productId } }),
      prisma.receiptItem.count({ where: { productId } }),
      prisma.stockConsumption.count({ where: { productId } }),
      prisma.lossClaimItem.count({ where: { productId } }),
      prisma.inventorySnapshotItem.count({ where: { productId } }),
      prisma.purchaseOrderItem.count({ where: { productId } }),
      prisma.deliveryOrderItem.count({ where: { productId } }),
    ])
  return { recipes, bomItems, policies, receipts, consumptions, losses, snapshotItems, poItems, doItems }
}

async function main() {
  console.log(`模式: ${APPLY ? '【真改】' : '【dry-run 只看不改】'}\n`)

  for (const m of MERGES) {
    console.log(`■ ${m.label}`)
    console.log(`  存续: ${m.survivor.name}（${m.survivor.invUnit}）  ←  停用: ${m.dup.name}`)
    console.log(`  换算: ${m.factorNote}`)

    const dupRefs = await countRefs(m.dup.id)
    console.log(
      `  重复档案引用: 配方${dupRefs.recipes} BOM项${dupRefs.bomItems} 库存策略${dupRefs.policies} | ` +
      `历史(不动): 入库${dupRefs.receipts} 消耗${dupRefs.consumptions} 报损${dupRefs.losses} 盘点行${dupRefs.snapshotItems} 采购单${dupRefs.poItems} 配送单${dupRefs.doItems}`
    )

    // 存续方单位修正（如 箱→袋）：在迁移前执行，确保换算目标单位已生效
    if (m.survivorUnitFix) {
      const fix = m.survivorUnitFix
      const sv = await prisma.product.findUniqueOrThrow({
        where: { id: m.survivor.id },
        select: { inventoryUnit: true, inventoryUnitsPerPurchaseUnit: true, stock: true },
      })
      const newStock = Number(sv.stock) * fix.stockFactor
      console.log(
        `  存续方单位修正: ${sv.inventoryUnit}→${fix.inventoryUnit}，1采购单位=${fix.unitsPerPurchaseUnit}${fix.inventoryUnit}，账面stock ${sv.stock}→${newStock}`
      )
      if (sv.inventoryUnit === fix.inventoryUnit) {
        console.log('  （已是目标单位，跳过）')
      } else if (APPLY) {
        await prisma.product.update({
          where: { id: m.survivor.id },
          data: {
            inventoryUnit: fix.inventoryUnit,
            inventoryUnitsPerPurchaseUnit: fix.unitsPerPurchaseUnit,
            stock: newStock,
          },
        })
      }
    }

    // 配方迁移计划
    const recipes = await prisma.dishRecipe.findMany({
      where: { productId: m.dup.id },
      select: { id: true, dishId: true, variantKey: true, quantity: true, unit: true, dish: { select: { name: true } } },
    })
    for (const r of recipes) {
      const conflict = await prisma.dishRecipe.findUnique({
        where: { dishId_variantKey_productId: { dishId: r.dishId, variantKey: r.variantKey, productId: m.survivor.id } },
      })
      if (m.recipeFactor == null) {
        console.log(`    配方[${r.dish.name}${r.variantKey ? '·' + r.variantKey : ''}] ${Number(r.quantity)}${r.unit} → 删除（${m.factorNote}）`)
        if (APPLY) await prisma.dishRecipe.delete({ where: { id: r.id } })
      } else if (conflict) {
        console.log(`    配方[${r.dish.name}${r.variantKey ? '·' + r.variantKey : ''}] → 删除（存续方已有同菜配方，避免双重扣减）`)
        if (APPLY) await prisma.dishRecipe.delete({ where: { id: r.id } })
      } else {
        const q = Number(r.quantity) * m.recipeFactor
        console.log(`    配方[${r.dish.name}${r.variantKey ? '·' + r.variantKey : ''}] ${Number(r.quantity)}${r.unit} → 迁移并换算 ${q.toFixed(6)}${m.survivor.invUnit}`)
        if (APPLY) {
          await prisma.dishRecipe.update({ where: { id: r.id }, data: { productId: m.survivor.id, quantity: q, unit: m.survivor.invUnit } })
        }
      }
    }

    // BOM 版本项迁移计划（逻辑同上）
    const bomItems = await prisma.dishBomItem.findMany({
      where: { productId: m.dup.id },
      select: { id: true, versionId: true, quantity: true, unit: true },
    })
    for (const b of bomItems) {
      const conflict = await prisma.dishBomItem.findUnique({
        where: { versionId_productId: { versionId: b.versionId, productId: m.survivor.id } },
      })
      if (m.recipeFactor == null || conflict) {
        console.log(`    BOM项[${b.versionId.slice(-6)}] → 删除`)
        if (APPLY) await prisma.dishBomItem.delete({ where: { id: b.id } })
      } else {
        const q = Number(b.quantity) * m.recipeFactor
        console.log(`    BOM项[${b.versionId.slice(-6)}] ${Number(b.quantity)}${b.unit} → 迁移并换算 ${q.toFixed(6)}${m.survivor.invUnit}`)
        if (APPLY) {
          await prisma.dishBomItem.update({ where: { id: b.id }, data: { productId: m.survivor.id, quantity: q, unit: m.survivor.invUnit } })
        }
      }
    }

    // 库存策略：存续方没有才迁移，有则删除重复方的
    const policies = await prisma.storeInventoryPolicy.findMany({ where: { productId: m.dup.id } })
    for (const pol of policies) {
      const existing = await prisma.storeInventoryPolicy.findFirst({
        where: { tenantId: pol.tenantId, storeId: pol.storeId, productId: m.survivor.id },
      })
      console.log(`    库存策略[store ${pol.storeId.slice(-4)}] → ${existing ? '删除（存续方已有）' : '迁移到存续方'}`)
      if (APPLY) {
        if (existing) await prisma.storeInventoryPolicy.delete({ where: { id: pol.id } })
        else await prisma.storeInventoryPolicy.update({ where: { id: pol.id }, data: { productId: m.survivor.id } })
      }
    }

    // 停用重复档案
    console.log(`    产品「${m.dup.name}」→ 停用并标记 [已并入]`)
    if (APPLY) {
      await prisma.product.update({
        where: { id: m.dup.id },
        data: { status: 'DISABLED', name: `${m.dup.name} [已并入]`, stock: 0 },
      })
    }
    console.log()
  }

  console.log(APPLY ? '执行完成。历史单据未触碰，账面将以 7.22 盘点为新基线归零。' : '[dry-run] 确认无误 → 加 --apply 执行')
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
