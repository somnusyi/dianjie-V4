import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Prisma, prisma } from '@dianjie/db'
import {
  normalizeWarehouseProductName,
  normalizeWarehouseUnit,
  parseMeituanUnitConversion,
  parseMeituanWarehouseInventoryWorkbook,
  resolveWarehouseInventoryRow,
  warehouseInventoryCostSemantics,
  warehouseInventoryFileHash,
  type InventoryImportProduct,
} from '../src/services/warehouseInventoryImport'
import { recordWarehouseBaselineSnapshot } from '../src/services/warehouseLedgerBaselineImport'

const SOURCE = 'MEITUAN' as const
const SOURCE_WAREHOUSE = '供应链总仓'

const CURATED_ALIASES: Record<string, string> = {
  'x-鲜奶浆菌': 'ZZ9M-3EOAPD',
  'x-鲜紫葱见手青': 'ZZ9M-3EQ1V1',
  'X-鲜老人头菌': 'ZZ9M-3EQDK6',
  'X-鲜白葱见手青': 'ZZ9M-3EPSH1',
  'X-清远鸡/真空包装': 'ZZ9M-2DYL77',
  'X-傣味舂鸡爪酱（定制）': 'ZZ9M-2DYL9U',
  'X-沙茶酱（定制）': 'ZZ9M-2DYL9N',
  'X-海螺片': 'ZZ9M-2FQEBI-KC',
  'x-焖饭汁（定制）': 'ZZ9M-2DYLA2',
  'X-牛肉酱（定制）': 'ZZ9M-JWI8TZMNA1',
  'X-菌菇酱（定制）': 'ZZ9M-2DYLA4',
  'X-火锅专用红油（定制）': 'ZZ9M-2DYLA0',
  'X-秘制底料（定制）': 'ZZ9M-2DYL9Y',
  'X-长稻香米（定制）': 'ZZ9M-2FQEEE-E5',
  'X-东川三色面-定制': 'ZZ9M-2DYL8H',
  'X-白米线·1.6mm-定制': 'ZZ9M-2DYL8E',
  'X-鲷鱼片': 'ZZ9M-2DYL7K',
  'X-喷射奶油（花园米布用）': 'ZZ9M-2DYLEM',
  'X-米布粉（花园米布）': 'ZZ9M-2DYLEK',
  'X-翻糖小花(春日桃桃/花园米布用)': 'ZZ9M-2DYLDN',
  'X-糯米纸蝴蝶(春日桃桃用)': 'ZZ9M-2DYLDL',
  'X-立体红蘑菇（花园米布用）': 'ZZ9M-2DYLDJ',
  'X-椰皇水(花园米布用）': 'ZZ9M-2DYLE3',
  'X-开心果酱（春日桃桃用）': 'ZZ9M-2DYLE1',
  'X-冷冻水蜜桃酱（春日桃桃用）': 'ZZ9M-2DYLDU',
  'X-鞭炮笋': 'ZZ9M-2DYL8J',
  'X-酸角汁': 'ZZ9M-2DYLD6',
  'X-包浆豆腐（小）': 'ZZ9M-2DYL92',
  'X-辣椒碎（丘北辣椒）': 'ZZ9M-2DYLB1',
  'X-不锈钢调味勺（15cm）': 'ZZ9M-VDRCX18653',
  'X-八鲜菌托盘': 'ZZ9M-PHT8QPMXMW',
  'X-水性杨花（海菜花）': 'ZZ9M-2DYL8R',
  'X-姜饼瓜': 'ZZ9M-2DYL8P',
}

const MASTER_CORRECTIONS: Record<string, Prisma.ProductUpdateInput> = {
  'ZZ9M-2DYLKB': {
    unit: '斤', purchaseUnit: '斤', orderUnit: '斤', costUnit: '斤', inventoryUnit: '斤',
    inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1,
    unitConversionStatus: 'VERIFIED', unitConversionVerifiedAt: new Date(),
    unitConversionNote: '2026-08-03 供应链总仓实盘表明确按斤管理；修正旧档“个”单位',
  },
  'ZZ9M-2DYLDH': {
    inventoryUnit: '瓶', inventoryUnitsPerPurchaseUnit: 12,
    inventoryUnitsPerOrderUnit: 12, inventoryUnitsPerCostUnit: 12,
    unitConversionStatus: 'VERIFIED', unitConversionVerifiedAt: new Date(),
    unitConversionNote: '2026-08-03 供应链总仓实盘；1箱=12瓶，实盘数量按瓶',
  },
  'ZZ9M-DOOH0M': {
    unit: '把', purchaseUnit: '把', orderUnit: '把', costUnit: '把', inventoryUnit: '把',
    inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1,
    unitConversionStatus: 'VERIFIED', unitConversionVerifiedAt: new Date(),
    unitConversionNote: '2026-08-03 供应链总仓实盘表明确按把管理',
  },
}

function json<T>(value: T): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value))
}

function productView(product: any): InventoryImportProduct {
  return {
    id: product.id, code: product.code, name: product.name, spec: product.spec,
    status: product.status, supplierId: product.supplierId, unit: product.unit,
    purchaseUnit: product.purchaseUnit, inventoryUnit: product.inventoryUnit,
    orderUnit: product.orderUnit, costUnit: product.costUnit,
    inventoryUnitsPerPurchaseUnit: product.inventoryUnitsPerPurchaseUnit,
    inventoryUnitsPerOrderUnit: product.inventoryUnitsPerOrderUnit,
    inventoryUnitsPerCostUnit: product.inventoryUnitsPerCostUnit,
    unitConversionStatus: product.unitConversionStatus,
  }
}

function newProductCode(externalCode: string) {
  const suffix = externalCode.startsWith('NAME-')
    ? externalCode.slice(-16)
    : crypto.createHash('sha256').update(externalCode).digest('hex').slice(0, 16).toUpperCase()
  return `MT8-${suffix}`
}

function sourceContract(row: Awaited<ReturnType<typeof parseMeituanWarehouseInventoryWorkbook>>['rows'][number]) {
  const conversion = parseMeituanUnitConversion(row.conversionText)
  const inventoryUnit = conversion ? normalizeWarehouseUnit(conversion.rightUnit) : normalizeWarehouseUnit(row.purchaseUnit)
  const factor = conversion ? conversion.rightQuantity / conversion.leftQuantity : 1
  return { inventoryUnit, factor }
}

function preferredNameCandidate(products: any[], row: Awaited<ReturnType<typeof parseMeituanWarehouseInventoryWorkbook>>['rows'][number]) {
  if (products.length === 0) return null
  const normalizedSpec = String(row.sourceSpec || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  const scored = products.map(product => {
    const category = String(product.category || '')
    const productSpec = String(product.spec || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    const operationalMaster = !['BOM待采购映射', '本地配方镜像'].includes(category)
    const score = (product.status === 'ENABLED' ? 100 : 0)
      + (operationalMaster ? 40 : 0)
      + (String(product.code).startsWith('YH001-INV-') ? 30 : 0)
      + (normalizedSpec && productSpec === normalizedSpec ? 20 : 0)
      + (!String(product.code).startsWith('DJ-BOM-') ? 10 : 0)
    return { product, score }
  }).sort((left, right) => right.score - left.score || String(left.product.code).localeCompare(String(right.product.code)))
  if (scored.length > 1 && scored[0].score === scored[1].score) return null
  return scored[0].product
}

async function main() {
  const args = process.argv.slice(2)
  const [sourcePath, snapshotDate] = args
  const mode = args.includes('--apply') ? '--apply' : '--plan'
  const tenantSlug = args.find(argument => argument.startsWith('--tenant='))?.slice('--tenant='.length) || 'dianjie'
  const sourceSnapshotAtText = args.find(argument => argument.startsWith('--snapshot-at='))?.slice('--snapshot-at='.length)
  if (!sourcePath || !snapshotDate || !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    throw new Error('Usage: tsx scripts/import-warehouse-baseline-snapshot.ts <file.xlsx> <YYYY-MM-DD> [--apply] [--tenant=dianjie] [--snapshot-at=ISO-8601]')
  }
  const sourceSnapshotAt = sourceSnapshotAtText ? new Date(sourceSnapshotAtText) : null
  if (sourceSnapshotAtText && Number.isNaN(sourceSnapshotAt!.getTime())) throw new Error('--snapshot-at must be a valid ISO-8601 timestamp')
  if (sourceSnapshotAt && new Date(sourceSnapshotAt.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) !== snapshotDate) {
    throw new Error('--snapshot-at must fall on snapshotDate in Asia/Shanghai')
  }
  const buffer = fs.readFileSync(sourcePath)
  const parsed = await parseMeituanWarehouseInventoryWorkbook(buffer, SOURCE_WAREHOUSE)
  const fileHash = warehouseInventoryFileHash(buffer)

  const tenant = await prisma.tenant.findFirst({ where: { slug: tenantSlug } })
  if (!tenant) throw new Error(`tenant ${tenantSlug} not found`)
  const warehouse = await prisma.warehouse.findFirst({
    where: { tenantId: tenant.id, isDefault: true, isActive: true },
  })
  if (!warehouse) throw new Error('default warehouse not found')
  if (warehouse.inventoryMode === 'STRICT') throw new Error('warehouse is STRICT; historical baseline import refused')
  const actor = await prisma.user.findFirst({
    where: { tenantId: tenant.id, status: 'ACTIVE', role: { in: ['SUPPLY_CHAIN', 'ADMIN'] } },
    orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
  })
  if (!actor) throw new Error('active supply-chain/admin actor not found')

  const existingImport = await prisma.warehouseInventoryImport.findUnique({
    where: {
      tenantId_warehouseId_source_fileHash: {
        tenantId: tenant.id, warehouseId: warehouse.id, source: SOURCE, fileHash,
      },
    },
  })
  if (existingImport?.status === 'CONFIRMED') {
    console.log(JSON.stringify({ status: 'already-confirmed', importId: existingImport.id, no: existingImport.no }, null, 2))
    return
  }
  if (existingImport) throw new Error(`existing non-confirmed import ${existingImport.no}; resolve it before retry`)

  const allProducts = await prisma.product.findMany({ where: { tenantId: tenant.id } })
  const externalMappings = await prisma.productExternalCode.findMany({
    where: { tenantId: tenant.id, source: SOURCE },
  })
  const byId = new Map(allProducts.map(product => [product.id, product]))
  const byCode = new Map(allProducts.map(product => [product.code.toUpperCase(), product]))
  const byExternalCode = new Map(externalMappings.flatMap(mapping => {
    const product = byId.get(mapping.productId)
    return product ? [[mapping.externalCode.toUpperCase(), product] as const] : []
  }))
  const byName = new Map<string, typeof allProducts>()
  for (const product of allProducts) {
    const key = normalizeWarehouseProductName(product.name)
    byName.set(key, [...(byName.get(key) || []), product])
  }

  type Planned = {
    row: typeof parsed.rows[number]
    product: any | null
    method: string
    create?: { code: string; inventoryUnit: string; factor: number }
    reactivate?: boolean
    correction?: Prisma.ProductUpdateInput
  }
  const plan: Planned[] = parsed.rows.map(row => {
    const candidates = byName.get(normalizeWarehouseProductName(row.externalName)) || []
    const mapped = byExternalCode.get(row.externalCode.toUpperCase())
    const exactCode = byCode.get(row.externalCode.toUpperCase())
    const alias = CURATED_ALIASES[row.externalName] ? byCode.get(CURATED_ALIASES[row.externalName].toUpperCase()) : null
    const preferredName = preferredNameCandidate(candidates, row)
    const proposed = mapped || exactCode || preferredName || alias
    const proposedMethod = mapped ? 'EXTERNAL_MAPPING'
      : exactCode ? 'EXACT_CODE'
        : preferredName ? 'EXACT_NORMALIZED_NAME'
          : alias ? 'CURATED_ALIAS'
            : null
    const proposedResolution = proposed
      ? resolveWarehouseInventoryRow(row, productView(proposed), 'EXTERNAL_MAPPING')
      : null
    const nameMatchHasUnsafeUnits = proposedMethod && ['EXACT_NORMALIZED_NAME', 'CURATED_ALIAS'].includes(proposedMethod)
      && proposedResolution?.issues.some(issue => [
        'UNIT_CONVERSION_NOT_VERIFIED',
        'PURCHASE_UNIT_MISMATCH',
        'SOURCE_CONVERSION_UNIT_MISMATCH',
        'NORMALIZED_QUANTITY_TOO_LARGE',
        'NORMALIZED_PRECISION_EXCEEDED',
      ].includes(issue.code))
    // A same-name BOM placeholder or old store archive may describe a
    // different package. Never force the warehouse snapshot into that SKU;
    // create a source-coded warehouse SKU and leave the old BOM untouched.
    const existing = nameMatchHasUnsafeUnits ? null : proposed
    if (existing) {
      return {
        row,
        product: existing,
        method: proposedMethod!,
        reactivate: row.sourceQuantity > 0 && existing.status === 'DISABLED',
        correction: MASTER_CORRECTIONS[existing.code],
      }
    }
    if (row.sourceQuantity <= 0) return { row, product: null, method: 'UNMATCHED_ZERO' }
    const contract = sourceContract(row)
    return {
      row, product: null, method: 'CREATE_FROM_AUTHORITATIVE_SNAPSHOT',
      create: { code: newProductCode(row.externalCode), inventoryUnit: contract.inventoryUnit, factor: contract.factor },
    }
  })

  const planSummary = {
    mode,
    tenantSlug,
    fileHash,
    snapshotDate,
    sourceSnapshotAt: sourceSnapshotAt?.toISOString() || null,
    warehouseId: warehouse.id,
    warehouseMode: warehouse.inventoryMode,
    sourceRows: parsed.rows.length,
    positiveRows: parsed.rows.filter(row => row.sourceQuantity > 0).length,
    creates: plan.filter(item => item.create).length,
    reactivations: plan.filter(item => item.reactivate).length,
    masterCorrections: plan.filter(item => item.correction).length,
    unmatchedZero: plan.filter(item => item.method === 'UNMATCHED_ZERO').length,
  }
  if (mode === '--plan') {
    console.log(JSON.stringify({
      ...planSummary,
      createNames: plan.filter(item => item.create).map(item => item.row.externalName),
      correctedCodes: plan.filter(item => item.correction).map(item => item.product.code),
    }, null, 2))
    return
  }

  const staged = await prisma.$transaction(async tx => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-baseline-stage:${tenant.id}:${fileHash}`}))`)
    const duplicate = await tx.warehouseInventoryImport.findUnique({
      where: {
        tenantId_warehouseId_source_fileHash: {
          tenantId: tenant.id, warehouseId: warehouse.id, source: SOURCE, fileHash,
        },
      },
    })
    if (duplicate) throw new Error(`import already staged: ${duplicate.no}`)

    for (const item of plan) {
      if (!item.product) continue
      const data: Prisma.ProductUpdateInput = {
        ...(item.reactivate ? { status: 'ENABLED' } : {}),
        ...(item.correction || {}),
      }
      if (Object.keys(data).length > 0) {
        item.product = await tx.product.update({ where: { id: item.product.id }, data })
        await tx.opLog.create({
          data: {
            tenantId: tenant.id, userId: actor.id, role: actor.role,
            action: `${item.reactivate ? '恢复并' : ''}核验总仓基准商品 ${item.product.name}`,
            entityType: 'Product', target: item.product.code, targetId: item.product.id,
            metadata: json({ snapshotDate, sourceFilename: path.basename(sourcePath), reactivate: Boolean(item.reactivate), masterCorrection: Boolean(item.correction) }),
          },
        })
      }
    }

    for (const item of plan) {
      if (!item.create) continue
      const created = await tx.product.create({
        data: {
          tenantId: tenant.id, code: item.create.code,
          name: item.row.externalName, spec: item.row.sourceSpec, category: item.row.sourceCategory || '其他',
          unit: item.row.purchaseUnit, purchaseUnit: item.row.purchaseUnit, orderUnit: item.row.purchaseUnit,
          costUnit: item.row.purchaseUnit, inventoryUnit: item.create.inventoryUnit,
          inventoryUnitsPerPurchaseUnit: item.create.factor,
          inventoryUnitsPerOrderUnit: item.create.factor,
          inventoryUnitsPerCostUnit: item.create.factor,
          unitConversionStatus: 'VERIFIED', unitConversionVerifiedAt: new Date(),
          unitConversionNote: `${snapshotDate} 供应链总仓库存快照新建；${item.row.conversionText || '默认 1:1'}；后续盘点校准`,
          price: 0, status: 'ENABLED',
        },
      })
      item.product = created
      await tx.opLog.create({
        data: {
          tenantId: tenant.id, userId: actor.id, role: actor.role,
          action: `总仓基准补建商品 ${created.name}`,
          entityType: 'Product', target: created.code, targetId: created.id,
          metadata: json({ snapshotDate, sourceFilename: path.basename(sourcePath), externalCode: item.row.externalCode, pricePending: true }),
        },
      })
    }

    const resolved = [] as Array<{ item: Planned; resolution: ReturnType<typeof resolveWarehouseInventoryRow> }>
    for (const item of plan) {
      if (item.product) {
        await tx.productExternalCode.upsert({
          where: { tenantId_source_externalCode: { tenantId: tenant.id, source: SOURCE, externalCode: item.row.externalCode } },
          update: { productId: item.product.id, externalName: item.row.externalName, verifiedById: actor.id, verifiedAt: new Date() },
          create: {
            tenantId: tenant.id, productId: item.product.id, source: SOURCE,
            externalCode: item.row.externalCode, externalName: item.row.externalName,
            verifiedById: actor.id, verifiedAt: new Date(),
          },
        })
      }
      const resolution = resolveWarehouseInventoryRow(
        item.row,
        item.product ? productView(item.product) : null,
        item.product ? 'EXTERNAL_MAPPING' : null,
      )
      resolved.push({ item, resolution })
    }

    const positiveBlockers = resolved.filter(({ item, resolution }) =>
      item.row.sourceQuantity > 0 && (resolution.issues.length > 0 || !resolution.productId || resolution.normalizedQuantity == null))
    if (positiveBlockers.length > 0) {
      throw new Error(`positive blockers: ${JSON.stringify(positiveBlockers.map(({ item, resolution }) => ({ row: item.row.rowNumber, name: item.row.externalName, issues: resolution.issues })))}`)
    }
    const mappedIds = resolved.map(({ resolution }) => resolution.productId).filter(Boolean) as string[]
    const duplicates = mappedIds.filter((id, index) => mappedIds.indexOf(id) !== index)
    if (duplicates.length > 0) throw new Error(`duplicate product mappings: ${[...new Set(duplicates)].join(',')}`)

    const no = `WSI-${snapshotDate.replaceAll('-', '')}-${fileHash.slice(0, 8).toUpperCase()}`
    const warningCount = resolved.reduce((sum, { resolution }) => sum + resolution.warnings.length, 0) + parsed.warnings.length
    const record = await tx.warehouseInventoryImport.create({
      data: {
        tenantId: tenant.id, warehouseId: warehouse.id, no, source: SOURCE,
        sourceFilename: path.basename(sourcePath), fileHash, sourceWarehouseName: SOURCE_WAREHOUSE,
        snapshotDate: new Date(`${snapshotDate}T00:00:00.000Z`), sourceRowCount: parsed.sourceRowCount,
        itemCount: parsed.rows.length, ignoredRowCount: parsed.ignoredRowCount,
        matchedCount: resolved.filter(({ resolution }) => resolution.productId).length,
        blockingCount: 0, warningCount, detailTotalAmount: parsed.detailTotalAmount, sourceTotalAmount: parsed.sourceTotalAmount,
        metadata: json({
          sheetName: parsed.sheetName, title: parsed.title, filterDescription: parsed.filterDescription,
          ignoredWarehouses: parsed.ignoredWarehouses, fileWarnings: parsed.warnings,
          quantitySemantics: 'TARGET_CLOSING_BALANCE', sourceQuantityUnit: 'PURCHASE_UNIT',
          costSemantics: warehouseInventoryCostSemantics(parsed),
          sourceFormat: 'MEITUAN_WAREHOUSE_DIMENSION',
          sourceSnapshotAt: sourceSnapshotAt?.toISOString() || undefined,
          originalSha256: fileHash, unmatchedZeroCount: planSummary.unmatchedZero,
          createdProductCount: planSummary.creates, reactivatedProductCount: planSummary.reactivations,
          masterCorrectionCount: planSummary.masterCorrections,
        }),
        createdById: actor.id,
      },
    })
    await tx.warehouseInventoryImportItem.createMany({
      data: resolved.map(({ item, resolution }) => ({
        tenantId: tenant.id, importId: record.id, rowNumber: item.row.rowNumber,
        externalCode: item.row.externalCode, externalName: item.row.externalName,
        sourceSpec: item.row.sourceSpec, sourceCategory: item.row.sourceCategory,
        sourceWarehouseName: item.row.sourceWarehouseName, purchaseUnit: item.row.purchaseUnit,
        conversionText: item.row.conversionText, sourceQuantity: item.row.sourceQuantity,
        inventoryAmount: item.row.inventoryAmount,
        inventoryAmountExcludingTax: item.row.inventoryAmountExcludingTax,
        inventoryTax: item.row.inventoryTax,
        averageCostExcludingTax: item.row.averageCostExcludingTax,
        expectedInboundQuantity: item.row.expectedInboundQuantity,
        expectedOutboundQuantity: item.row.expectedOutboundQuantity,
        theoreticalQuantity: item.row.theoreticalQuantity,
        theoreticalAmount: item.row.theoreticalAmount,
        productId: resolution.productId, matchSource: resolution.matchSource,
        inventoryUnit: resolution.inventoryUnit, conversionFactor: resolution.conversionFactor,
        normalizedQuantity: resolution.normalizedQuantity, issues: json(resolution.issues),
        warnings: json(resolution.warnings), rawData: json(item.row.rawData),
      })),
    })
    await tx.opLog.create({
      data: {
        tenantId: tenant.id, userId: actor.id, role: actor.role,
        action: `预检并暂存总仓库存基线 ${no}`,
        entityType: 'WarehouseInventoryImport', target: no, targetId: record.id,
        metadata: json({ ...planSummary, actorId: actor.id }),
      },
    })
    return { id: record.id, rowVersion: record.rowVersion }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 })

  const applied = await recordWarehouseBaselineSnapshot({
    tenantId: tenant.id, userId: actor.id, role: actor.role,
    importId: staged.id, rowVersion: staged.rowVersion,
  })
  if (applied.blocked) throw new Error(`baseline blocked: ${JSON.stringify(applied.blockingIssues)}`)
  const modeAfter = await prisma.warehouse.findUnique({ where: { id: warehouse.id }, select: { inventoryMode: true } })
  console.log(JSON.stringify({ status: 'confirmed', ...planSummary, importId: staged.id, importNo: applied.importNo, snapshotAt: applied.snapshotAt, ledgerItems: applied.items.length, createdCount: applied.createdCount, adjustedCount: applied.adjustedCount, warehouseModeAfter: modeAfter?.inventoryMode }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await prisma.$disconnect()
})
