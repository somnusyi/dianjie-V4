import path from 'node:path'
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { calendarDateSchema } from '../lib/calendar-date'
import {
  hasInternalSupplyChainCapability,
  isInternalSupplyChainRole,
} from '../lib/internal-supply-chain-access'
import { invalidatePattern } from '../lib/cache'
import { resolveTenantWarehouseId } from '../services/defaultWarehouse'
import {
  createSupplierStockBatchIncrease,
  applySupplierStockBatchDelta,
} from '../services/supplierStockBatch'
import {
  normalizeExternalProductCode,
  normalizeWarehouseProductName,
  parseMeituanWarehouseInventoryWorkbook,
  resolveWarehouseInventoryRow,
  warehouseInventoryCostSemantics,
  warehouseInventoryFileHash,
  type InventoryImportProduct,
  type ParsedWarehouseInventoryRow,
  type WarehouseInventoryIssue,
} from '../services/warehouseInventoryImport'
import { recordWarehouseBaselineSnapshot } from '../services/warehouseLedgerBaselineImport'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const SOURCE = 'MEITUAN' as const
const auth = (app: any) => ({ preHandler: [app.authenticate] })

// Deliberately typed as boolean so TypeScript still checks the quarantined
// legacy body below. Contract tests pin this to true; there is no runtime or
// environment switch that can enable historical snapshot writes.
function legacySnapshotWritesPermanentlyRemoved(): boolean {
  return true
}

type ImportDb = Prisma.TransactionClient | typeof prisma

function json<T>(value: T): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value))
}

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`)
}

function dateText(value: Date) {
  return value.toISOString().slice(0, 10)
}

function nextShanghaiDayStartUtc(value: Date) {
  const next = new Date(value)
  next.setUTCDate(next.getUTCDate() + 1)
  return new Date(`${dateText(next)}T00:00:00+08:00`)
}

function issueArray(value: unknown): WarehouseInventoryIssue[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as WarehouseInventoryIssue[] : []
}

function requireInternalInventoryWrite(req: any, reply: any) {
  if (!isInternalSupplyChainRole(req.user?.role)
    || !hasInternalSupplyChainCapability(req.user?.role, 'inventory.write')) {
    reply.status(403).send({ error: '仅内部供应链库存岗位可操作库存快照导入' })
    return false
  }
  return true
}

async function readPreviewUpload(req: any) {
  const fields = new Map<string, string>()
  let file: { filename: string; buffer: Buffer } | null = null
  for await (const part of req.parts({
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4, parts: 5 },
  })) {
    if (part.type === 'field') {
      fields.set(part.fieldname, String(part.value || '').trim())
      continue
    }
    if (part.fieldname !== 'file') {
      part.file.resume()
      continue
    }
    const filename = path.basename(String(part.filename || ''))
    if (!filename.toLowerCase().endsWith('.xlsx')) {
      part.file.resume()
      throw Object.assign(new Error('只支持美团导出的 .xlsx 库存文件'), { statusCode: 400 })
    }
    if (filename.length > 255) {
      part.file.resume()
      throw Object.assign(new Error('文件名不能超过 255 个字符'), { statusCode: 400 })
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of part.file) {
      size += chunk.length
      if (size > MAX_FILE_BYTES) throw Object.assign(new Error('库存文件不能超过 5MB'), { statusCode: 400 })
      chunks.push(chunk)
    }
    if (part.file.truncated) throw Object.assign(new Error('文件过大，上传已被截断'), { statusCode: 400 })
    file = { filename, buffer: Buffer.concat(chunks) }
  }
  if (!file) throw Object.assign(new Error('请选择美团库存 Excel 文件'), { statusCode: 400 })
  const parsed = z.object({
    snapshotDate: calendarDateSchema,
    sourceWarehouseName: z.string().trim().min(1).max(100).default('供应链总仓'),
  }).safeParse({
    snapshotDate: fields.get('snapshotDate'),
    sourceWarehouseName: fields.get('sourceWarehouseName') || '供应链总仓',
  })
  if (!parsed.success) throw Object.assign(new Error(parsed.error.issues[0].message), { statusCode: 400 })
  const shanghaiToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  if (parsed.data.snapshotDate > shanghaiToday) {
    throw Object.assign(new Error('库存快照日期不能晚于今天'), { statusCode: 400 })
  }
  return { ...parsed.data, ...file }
}

function productView(product: any): InventoryImportProduct {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    spec: product.spec,
    status: product.status,
    supplierId: product.supplierId,
    unit: product.unit,
    purchaseUnit: product.purchaseUnit,
    inventoryUnit: product.inventoryUnit,
    orderUnit: product.orderUnit,
    costUnit: product.costUnit,
    inventoryUnitsPerPurchaseUnit: product.inventoryUnitsPerPurchaseUnit,
    inventoryUnitsPerOrderUnit: product.inventoryUnitsPerOrderUnit,
    inventoryUnitsPerCostUnit: product.inventoryUnitsPerCostUnit,
    unitConversionStatus: product.unitConversionStatus,
  }
}

async function resolveRows(db: ImportDb, tenantId: string, rows: ParsedWarehouseInventoryRow[]) {
  const codes = [...new Set(rows.map(row => row.externalCode))]
  const names = [...new Set(rows.flatMap(row => {
    const original = row.externalName
    const withoutPrefix = original.replace(/^[xｘ][\-－—_\s]+/i, '')
    return [original, withoutPrefix].filter(Boolean)
  }))]
  const [mappings, codeProducts, nameProducts] = await Promise.all([
    db.productExternalCode.findMany({
      where: { tenantId, source: SOURCE, externalCode: { in: codes } },
      include: { product: true },
    }),
    db.product.findMany({
      where: {
        tenantId,
        OR: codes.map(code => ({ code: { equals: code, mode: 'insensitive' as const } })),
      },
    }),
    db.product.findMany({
      where: {
        tenantId,
        OR: names.map(name => ({ name: { equals: name, mode: 'insensitive' as const } })),
      },
    }),
  ])
  const mappingByCode = new Map(mappings.map(mapping => [normalizeExternalProductCode(mapping.externalCode), mapping.product]))
  const productsByCode = new Map<string, any[]>()
  for (const product of codeProducts) {
    const key = normalizeExternalProductCode(product.code)
    productsByCode.set(key, [...(productsByCode.get(key) || []), product])
  }
  const productsByName = new Map<string, any[]>()
  for (const product of nameProducts) {
    const key = normalizeWarehouseProductName(product.name)
    productsByName.set(key, [...(productsByName.get(key) || []), product])
  }

  const resolved = rows.map(row => {
    const mapped = mappingByCode.get(row.externalCode)
    const codeMatches = productsByCode.get(row.externalCode) || []
    const nameMatches = productsByName.get(normalizeWarehouseProductName(row.externalName)) || []
    const product = mapped || (codeMatches.length === 1 ? codeMatches[0] : null)
      || (nameMatches.length === 1 ? nameMatches[0] : null)
    const matchSource = mapped
      ? 'EXTERNAL_MAPPING'
      : codeMatches.length === 1
        ? 'EXACT_CODE'
        : nameMatches.length === 1
          ? 'NAME_SUGGESTION'
          : null
    return {
      row,
      resolution: resolveWarehouseInventoryRow(row, product ? productView(product) : null, matchSource),
    }
  })

  const productCounts = new Map<string, number>()
  for (const item of resolved) {
    if (item.resolution.productId) {
      productCounts.set(item.resolution.productId, (productCounts.get(item.resolution.productId) || 0) + 1)
    }
  }
  for (const item of resolved) {
    if (item.resolution.productId && (productCounts.get(item.resolution.productId) || 0) > 1) {
      item.resolution.issues.push({
        code: 'DUPLICATE_PRODUCT_MAPPING',
        message: '多个美团编码映射到同一系统商品，请修正商品映射',
      })
    }
  }
  return resolved
}

function parsedRowFromItem(item: any): ParsedWarehouseInventoryRow {
  const raw = item.rawData && typeof item.rawData === 'object' ? item.rawData as Record<string, unknown> : {}
  return {
    rowNumber: item.rowNumber,
    externalCode: item.externalCode,
    externalName: item.externalName,
    sourceSpec: item.sourceSpec,
    sourceCategory: item.sourceCategory,
    sourceWarehouseName: item.sourceWarehouseName,
    purchaseUnit: item.purchaseUnit,
    conversionText: item.conversionText,
    sourceQuantity: Number(item.sourceQuantity),
    inventoryAmount: Number(item.inventoryAmount),
    inventoryAmountExcludingTax: Number(item.inventoryAmountExcludingTax),
    inventoryTax: Number(item.inventoryTax),
    averageCostExcludingTax: Number(item.averageCostExcludingTax),
    expectedInboundQuantity: Number(item.expectedInboundQuantity),
    expectedOutboundQuantity: Number(item.expectedOutboundQuantity),
    theoreticalQuantity: Number(item.theoreticalQuantity),
    theoreticalAmount: Number(item.theoreticalAmount),
    issues: issueArray(raw.sourceIssues),
    warnings: issueArray(raw.sourceWarnings),
    rawData: raw,
  }
}

function warningCountFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object') return 0
  return issueArray((metadata as Record<string, unknown>).fileWarnings).length
}

async function refreshStagedImport(tx: Prisma.TransactionClient, tenantId: string, importId: string) {
  const record = await tx.warehouseInventoryImport.findFirst({
    where: { id: importId, tenantId },
    include: { items: { orderBy: { rowNumber: 'asc' } } },
  })
  if (!record) throw Object.assign(new Error('库存导入单不存在'), { statusCode: 404 })
  if (record.status !== 'STAGED') throw Object.assign(new Error('只有待确认导入单可以重新匹配'), { statusCode: 409 })
  const resolved = await resolveRows(tx, tenantId, record.items.map(parsedRowFromItem))
  for (let index = 0; index < record.items.length; index += 1) {
    const item = record.items[index]
    const result = resolved[index].resolution
    await tx.warehouseInventoryImportItem.update({
      where: { id: item.id },
      data: {
        productId: result.productId,
        matchSource: result.matchSource,
        inventoryUnit: result.inventoryUnit,
        conversionFactor: result.conversionFactor,
        normalizedQuantity: result.normalizedQuantity,
        issues: json(result.issues),
        warnings: json(result.warnings),
      },
    })
  }
  const matchedCount = resolved.filter(item => item.resolution.productId && item.resolution.matchSource !== 'NAME_SUGGESTION').length
  const blockingCount = resolved.filter(item => item.resolution.issues.length > 0).length
  const warningCount = resolved.reduce((sum, item) => sum + item.resolution.warnings.length, 0)
    + warningCountFromMetadata(record.metadata)
  await tx.warehouseInventoryImport.update({
    where: { id: record.id },
    data: { matchedCount, blockingCount, warningCount, rowVersion: { increment: 1 } },
  })
}

function numberOrNull(value: unknown) {
  return value == null ? null : Number(value)
}

function publicItem(item: any) {
  return {
    ...item,
    product: item.product ? { ...item.product, stock: Number(item.product.stock) } : item.product,
    sourceQuantity: Number(item.sourceQuantity),
    inventoryAmount: Number(item.inventoryAmount),
    inventoryAmountExcludingTax: Number(item.inventoryAmountExcludingTax),
    inventoryTax: Number(item.inventoryTax),
    averageCostExcludingTax: Number(item.averageCostExcludingTax),
    expectedInboundQuantity: Number(item.expectedInboundQuantity),
    expectedOutboundQuantity: Number(item.expectedOutboundQuantity),
    theoreticalQuantity: Number(item.theoreticalQuantity),
    theoreticalAmount: Number(item.theoreticalAmount),
    conversionFactor: numberOrNull(item.conversionFactor),
    normalizedQuantity: numberOrNull(item.normalizedQuantity),
    oldQuantity: numberOrNull(item.oldQuantity),
    delta: numberOrNull(item.delta),
    issues: issueArray(item.issues),
    warnings: issueArray(item.warnings),
  }
}

function publicImport(record: any) {
  return {
    ...record,
    snapshotDate: dateText(record.snapshotDate),
    detailTotalAmount: Number(record.detailTotalAmount),
    sourceTotalAmount: numberOrNull(record.sourceTotalAmount),
    items: Array.isArray(record.items) ? record.items.map(publicItem) : undefined,
  }
}

async function loadImport(tenantId: string, importId: string) {
  return prisma.warehouseInventoryImport.findFirst({
    where: { id: importId, tenantId },
    include: {
      warehouse: { select: { id: true, name: true, code: true } },
      items: {
        orderBy: { rowNumber: 'asc' },
        include: {
          product: {
            include: { supplier: { select: { id: true, no: true, name: true } } },
          },
        },
      },
    },
  })
}

async function lockedProducts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productIds: string[],
) {
  const ids = [...new Set(productIds)].sort()
  if (ids.length === 0) return new Map<string, { stock: Prisma.Decimal; supplierId: string | null }>()
  const rows = await tx.$queryRaw<Array<{ id: string; stock: Prisma.Decimal; supplierId: string | null }>>(Prisma.sql`
    SELECT "id", "stock", "supplierId"
    FROM "products"
    WHERE "tenantId" = ${tenantId}
      AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `)
  if (rows.length !== ids.length) throw Object.assign(new Error('导入商品不存在或不属于当前租户'), { statusCode: 409 })
  return new Map(rows.map(row => [row.id, { stock: row.stock, supplierId: row.supplierId }]))
}

async function activeReservations(tx: Prisma.TransactionClient, tenantId: string, productIds: string[]) {
  const rows = await tx.supplierStockReservation.groupBy({
    by: ['productId'],
    where: { tenantId, productId: { in: productIds }, status: 'ACTIVE' },
    _sum: { quantity: true },
  })
  return new Map(rows.map(row => [row.productId, row._sum.quantity || new Prisma.Decimal(0)]))
}

export const warehouseInventoryImportRoutes: FastifyPluginAsync = async app => {
  app.get('/', auth(app), async (req: any, reply: any) => {
    if (!requireInternalInventoryWrite(req, reply)) return
    const parsed = z.object({
      status: z.enum(['STAGED', 'CONFIRMED', 'REVERSED']).optional(),
      dateFrom: calendarDateSchema.optional(),
      dateTo: calendarDateSchema.optional(),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const rows = await prisma.warehouseInventoryImport.findMany({
      where: {
        tenantId: req.user.tenantId,
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...((parsed.data.dateFrom || parsed.data.dateTo) ? {
          snapshotDate: {
            ...(parsed.data.dateFrom ? { gte: dateOnly(parsed.data.dateFrom) } : {}),
            ...(parsed.data.dateTo ? { lte: dateOnly(parsed.data.dateTo) } : {}),
          },
        } : {}),
      },
      include: { warehouse: { select: { id: true, name: true, code: true } } },
      orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    })
    return { items: rows.map(publicImport) }
  })

  app.get('/:id', auth(app), async (req: any, reply: any) => {
    if (!requireInternalInventoryWrite(req, reply)) return
    const record = await loadImport(req.user.tenantId, String(req.params.id))
    if (!record) return reply.status(404).send({ error: '库存导入单不存在' })
    return publicImport(record)
  })

  app.post('/preview', auth(app), async (req: any, reply: any) => {
    if (!requireInternalInventoryWrite(req, reply)) return
    try {
      const upload = await readPreviewUpload(req)
      const tenantId = req.user.tenantId
      const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
      const fileHash = warehouseInventoryFileHash(upload.buffer)
      const snapshotDate = dateOnly(upload.snapshotDate)
      const existing = await prisma.warehouseInventoryImport.findUnique({
        where: {
          tenantId_warehouseId_source_fileHash: {
            tenantId,
            warehouseId,
            source: SOURCE,
            fileHash,
          },
        },
      })
      if (existing) {
        if (dateText(existing.snapshotDate) !== upload.snapshotDate
          || existing.sourceWarehouseName !== upload.sourceWarehouseName) {
          throw Object.assign(new Error(`该文件已用于 ${dateText(existing.snapshotDate)} ${existing.sourceWarehouseName}，不能换日期或仓库重复导入`), { statusCode: 409 })
        }
        const loaded = await loadImport(tenantId, existing.id)
        return reply.send(publicImport(loaded))
      }

      const parsedFile = await parseMeituanWarehouseInventoryWorkbook(upload.buffer, upload.sourceWarehouseName)
      const resolved = await resolveRows(prisma, tenantId, parsedFile.rows)
      const matchedCount = resolved.filter(item => item.resolution.productId && item.resolution.matchSource !== 'NAME_SUGGESTION').length
      const blockingCount = resolved.filter(item => item.resolution.issues.length > 0).length
      const warningCount = resolved.reduce((sum, item) => sum + item.resolution.warnings.length, 0) + parsedFile.warnings.length
      const no = `WSI-${upload.snapshotDate.replaceAll('-', '')}-${fileHash.slice(0, 8).toUpperCase()}`
      const created = await prisma.$transaction(async tx => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-import-preview:${tenantId}:${warehouseId}:${fileHash}`}))`)
        const duplicate = await tx.warehouseInventoryImport.findUnique({
          where: {
            tenantId_warehouseId_source_fileHash: {
              tenantId, warehouseId, source: SOURCE, fileHash,
            },
          },
        })
        if (duplicate) {
          if (dateText(duplicate.snapshotDate) !== upload.snapshotDate
            || duplicate.sourceWarehouseName !== upload.sourceWarehouseName) {
            throw Object.assign(new Error(`该文件已用于 ${dateText(duplicate.snapshotDate)} ${duplicate.sourceWarehouseName}，不能换日期或仓库重复导入`), { statusCode: 409 })
          }
          return duplicate
        }
        const record = await tx.warehouseInventoryImport.create({
          data: {
            tenantId,
            warehouseId,
            no,
            source: SOURCE,
            sourceFilename: upload.filename,
            fileHash,
            sourceWarehouseName: upload.sourceWarehouseName,
            snapshotDate,
            sourceRowCount: parsedFile.sourceRowCount,
            itemCount: parsedFile.rows.length,
            ignoredRowCount: parsedFile.ignoredRowCount,
            matchedCount,
            blockingCount,
            warningCount,
            detailTotalAmount: parsedFile.detailTotalAmount,
            sourceTotalAmount: parsedFile.sourceTotalAmount,
            metadata: json({
              sheetName: parsedFile.sheetName,
              title: parsedFile.title,
              filterDescription: parsedFile.filterDescription,
              ignoredWarehouses: parsedFile.ignoredWarehouses,
              fileWarnings: parsedFile.warnings,
              quantitySemantics: 'TARGET_CLOSING_BALANCE',
              sourceQuantityUnit: 'PURCHASE_UNIT',
              costSemantics: warehouseInventoryCostSemantics(parsedFile),
            }),
            createdById: req.user.userId,
          },
        })
        await tx.warehouseInventoryImportItem.createMany({
          data: resolved.map(({ row, resolution }) => ({
            tenantId,
            importId: record.id,
            rowNumber: row.rowNumber,
            externalCode: row.externalCode,
            externalName: row.externalName,
            sourceSpec: row.sourceSpec,
            sourceCategory: row.sourceCategory,
            sourceWarehouseName: row.sourceWarehouseName,
            purchaseUnit: row.purchaseUnit,
            conversionText: row.conversionText,
            sourceQuantity: row.sourceQuantity,
            inventoryAmount: row.inventoryAmount,
            inventoryAmountExcludingTax: row.inventoryAmountExcludingTax,
            inventoryTax: row.inventoryTax,
            averageCostExcludingTax: row.averageCostExcludingTax,
            expectedInboundQuantity: row.expectedInboundQuantity,
            expectedOutboundQuantity: row.expectedOutboundQuantity,
            theoreticalQuantity: row.theoreticalQuantity,
            theoreticalAmount: row.theoreticalAmount,
            productId: resolution.productId,
            matchSource: resolution.matchSource,
            inventoryUnit: resolution.inventoryUnit,
            conversionFactor: resolution.conversionFactor,
            normalizedQuantity: resolution.normalizedQuantity,
            issues: json(resolution.issues),
            warnings: json(resolution.warnings),
            rawData: json(row.rawData),
          })),
        })
        await tx.opLog.create({
          data: {
            tenantId,
            userId: req.user.userId,
            role: req.user.role,
            action: `预览美团库存快照 ${no}`,
            entityType: 'WarehouseInventoryImport',
            target: no,
            targetId: record.id,
            metadata: json({ fileHash, snapshotDate: upload.snapshotDate, itemCount: parsedFile.rows.length, blockingCount, warningCount }),
          },
        })
        return record
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 })
      const loaded = await loadImport(tenantId, created.id)
      return reply.status(201).send(publicImport(loaded))
    } catch (error: any) {
      req.log.error({ error }, 'warehouse inventory import preview failed')
      return reply.status(error.statusCode || 400).send({ error: error.message || '库存文件预览失败' })
    }
  })

  app.post('/:id/refresh', auth(app), async (req: any, reply: any) => {
    if (!requireInternalInventoryWrite(req, reply)) return
    try {
      await prisma.$transaction(async tx => {
        await refreshStagedImport(tx, req.user.tenantId, String(req.params.id))
      })
      const loaded = await loadImport(req.user.tenantId, String(req.params.id))
      return publicImport(loaded)
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message || '重新匹配失败' })
    }
  })

  app.post('/:id/items/:itemId/resolve', auth(app), async (req: any, reply: any) => {
    if (!requireInternalInventoryWrite(req, reply)) return
    const body = z.object({ productId: z.string().trim().min(1) }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    try {
      await prisma.$transaction(async tx => {
        const record = await tx.warehouseInventoryImport.findFirst({
          where: { id: String(req.params.id), tenantId: req.user.tenantId, status: 'STAGED' },
        })
        if (!record) throw Object.assign(new Error('待确认库存导入单不存在'), { statusCode: 404 })
        const item = await tx.warehouseInventoryImportItem.findFirst({
          where: { id: String(req.params.itemId), tenantId: req.user.tenantId, importId: record.id },
        })
        if (!item) throw Object.assign(new Error('库存导入明细不存在'), { statusCode: 404 })
        const product = await tx.product.findFirst({
          where: { id: body.data.productId, tenantId: req.user.tenantId },
        })
        if (!product) throw Object.assign(new Error('商品不存在或不属于当前租户'), { statusCode: 404 })
        await tx.productExternalCode.upsert({
          where: {
            tenantId_source_externalCode: {
              tenantId: req.user.tenantId,
              source: SOURCE,
              externalCode: item.externalCode,
            },
          },
          update: {
            productId: product.id,
            externalName: item.externalName,
            verifiedById: req.user.userId,
            verifiedAt: new Date(),
          },
          create: {
            tenantId: req.user.tenantId,
            productId: product.id,
            source: SOURCE,
            externalCode: item.externalCode,
            externalName: item.externalName,
            verifiedById: req.user.userId,
            verifiedAt: new Date(),
          },
        })
        await refreshStagedImport(tx, req.user.tenantId, record.id)
        await tx.opLog.create({
          data: {
            tenantId: req.user.tenantId,
            userId: req.user.userId,
            role: req.user.role,
            action: `确认美团商品映射 ${item.externalCode} → ${product.code}`,
            entityType: 'ProductExternalCode',
            target: item.externalCode,
            targetId: product.id,
            metadata: json({ importId: record.id, externalName: item.externalName, productName: product.name }),
          },
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
      const loaded = await loadImport(req.user.tenantId, String(req.params.id))
      return publicImport(loaded)
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message || '商品映射失败' })
    }
  })

  app.post('/:id/resolve-name-suggestions', auth(app), async (req: any, reply: any) => {
    if (!requireInternalInventoryWrite(req, reply)) return
    const body = z.object({ rowVersion: z.number().int().nonnegative() }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const importId = String(req.params.id)
    try {
      await prisma.$transaction(async tx => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-inventory-import:${req.user.tenantId}:${importId}`}))`)
        const record = await tx.warehouseInventoryImport.findFirst({
          where: { id: importId, tenantId: req.user.tenantId },
          include: {
            items: {
              where: { matchSource: 'NAME_SUGGESTION', productId: { not: null } },
              orderBy: { rowNumber: 'asc' },
            },
          },
        })
        if (!record) throw Object.assign(new Error('库存导入单不存在'), { statusCode: 404 })
        if (record.status !== 'STAGED' || record.rowVersion !== body.data.rowVersion) {
          throw Object.assign(new Error('导入单状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        if (record.items.length === 0) {
          throw Object.assign(new Error('当前没有待确认的唯一同名候选'), { statusCode: 409 })
        }
        const verifiedAt = new Date()
        await tx.productExternalCode.createMany({
          data: record.items.map(item => ({
              tenantId: record.tenantId,
              productId: item.productId!,
              source: record.source,
              externalCode: item.externalCode,
              externalName: item.externalName,
              verifiedById: req.user.userId,
              verifiedAt,
          })),
        })
        await refreshStagedImport(tx, record.tenantId, record.id)
        await tx.opLog.create({
          data: {
            tenantId: record.tenantId,
            userId: req.user.userId,
            role: req.user.role,
            action: `批量确认美团同名商品映射 ${record.no}`,
            entityType: 'ProductExternalCode',
            target: record.no,
            targetId: record.id,
            metadata: json({ importId: record.id, count: record.items.length }),
          },
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 })
      const loaded = await loadImport(req.user.tenantId, importId)
      return publicImport(loaded)
    } catch (error: any) {
      req.log.error({ error, importId }, 'warehouse inventory name suggestions confirmation failed')
      const conflict = error?.code === 'P2002'
      return reply.status(error.statusCode || (conflict ? 409 : 500)).send({
        error: conflict ? '商品映射已被其他操作更新，请重新匹配后再确认' : error.message || '批量确认同名候选失败',
      })
    }
  })

  app.post('/:id/confirm', auth(app), async (req: any, reply: any) => {
    if (!requireInternalInventoryWrite(req, reply)) return
    if (legacySnapshotWritesPermanentlyRemoved()) {
      return reply.status(410).send({
        error: '历史库存文件永久只用于预检和单位映射。由于7月31日后缺少连续出入库流水，该快照不能写入任何库存账；正式期初只能来自新的总仓现场实盘。',
        code: 'WAREHOUSE_SNAPSHOT_CONFIRM_REMOVED',
      })
    }
    /* istanbul ignore next -- legacy body retained temporarily for migration archaeology; unreachable by design. */
    const body = z.object({ rowVersion: z.number().int().nonnegative() }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const importId = String(req.params.id)
    try {
      await prisma.$transaction(async tx => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-inventory-import:${req.user.tenantId}:${importId}`}))`)
        const record = await tx.warehouseInventoryImport.findFirst({
          where: { id: importId, tenantId: req.user.tenantId },
          include: { items: { orderBy: { rowNumber: 'asc' } } },
        })
        if (!record) throw Object.assign(new Error('库存导入单不存在'), { statusCode: 404 })
        if (record.status === 'CONFIRMED') return
        if (record.status !== 'STAGED' || record.rowVersion !== body.data.rowVersion) {
          throw Object.assign(new Error('导入单状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        if (record.items.some(item => issueArray(item.issues).length > 0 || !item.productId || item.normalizedQuantity == null)) {
          throw Object.assign(new Error('仍有未匹配商品或单位问题，不能确认库存'), { statusCode: 409 })
        }
        const liveResolution = await resolveRows(tx, record.tenantId, record.items.map(parsedRowFromItem))
        for (let index = 0; index < record.items.length; index += 1) {
          const staged = record.items[index]
          const live = liveResolution[index].resolution
          const sameQuantity = staged.normalizedQuantity != null && live.normalizedQuantity != null
            && new Prisma.Decimal(staged.normalizedQuantity).equals(live.normalizedQuantity)
          if (live.issues.length > 0 || live.productId !== staged.productId || !sameQuantity) {
            throw Object.assign(new Error(`${staged.externalName} 的商品映射或单位档案已变化，请重新匹配后再确认`), { statusCode: 409 })
          }
        }
        const conflicting = await tx.warehouseInventoryImport.findFirst({
          where: {
            tenantId: record.tenantId,
            warehouseId: record.warehouseId,
            id: { not: record.id },
            status: 'CONFIRMED',
            snapshotDate: { gte: record.snapshotDate },
          },
          select: { no: true, snapshotDate: true },
        })
        if (conflicting) {
          throw Object.assign(new Error(`已存在 ${dateText(conflicting.snapshotDate)} 的可信库存快照 ${conflicting.no}`), { statusCode: 409 })
        }

        const productIds = record.items.map(item => item.productId!)
        const laterMovement = await tx.supplierStockMovement.findFirst({
          where: {
            tenantId: record.tenantId,
            warehouseId: record.warehouseId,
            productId: { in: productIds },
            createdAt: { gte: nextShanghaiDayStartUtc(record.snapshotDate) },
          },
          include: { product: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
        })
        if (laterMovement) {
          throw Object.assign(new Error(`${laterMovement.product.name} 在快照日后已有库存流水，不能用历史余额覆盖；请先核对 8·1 后业务或改用最新快照`), { statusCode: 409 })
        }
        const balances = await lockedProducts(tx, record.tenantId, productIds)
        const reservations = await activeReservations(tx, record.tenantId, productIds)
        for (const item of record.items) {
          const balance = balances.get(item.productId!)!
          if (!balance.supplierId) throw Object.assign(new Error(`${item.externalName} 未绑定供应商`), { statusCode: 409 })
          const target = new Prisma.Decimal(item.normalizedQuantity!)
          const reserved = reservations.get(item.productId!) || new Prisma.Decimal(0)
          if (target.lessThan(reserved)) {
            throw Object.assign(new Error(`${item.externalName} 目标库存 ${target.toFixed(3)} 低于已接订单预占 ${reserved.toFixed(3)}`), { statusCode: 409 })
          }
          const delta = target.minus(balance.stock)
          await tx.product.update({ where: { id: item.productId! }, data: { stock: target } })
          await tx.warehouseStock.upsert({
            where: {
              tenantId_warehouseId_productId: {
                tenantId: record.tenantId,
                warehouseId: record.warehouseId,
                productId: item.productId!,
              },
            },
            update: { physicalQty: target, isActive: true },
            create: {
              tenantId: record.tenantId,
              warehouseId: record.warehouseId,
              productId: item.productId!,
              physicalQty: target,
            },
          })
          let movementId: string | null = null
          if (!delta.isZero()) {
            const movement = await tx.supplierStockMovement.create({
              data: {
                tenantId: record.tenantId,
                warehouseId: record.warehouseId,
                supplierId: balance.supplierId,
                productId: item.productId!,
                delta,
                balanceAfter: target,
                type: 'ADJUSTMENT',
                reason: `美团 ${dateText(record.snapshotDate)} 供应链总仓期末库存快照`,
                sourceType: 'WarehouseInventoryImportItem',
                sourceId: item.id,
                createdById: req.user.userId,
              },
            })
            movementId = movement.id
            if (delta.isPositive() && balance.stock.isZero()) {
              await createSupplierStockBatchIncrease(tx, {
                tenantId: record.tenantId,
                warehouseId: record.warehouseId,
                supplierId: balance.supplierId,
                productId: item.productId!,
                quantity: delta,
                movementId: movement.id,
                createdById: req.user.userId,
                kind: 'OPENING',
                batchNo: `MEITUAN-${dateText(record.snapshotDate).replaceAll('-', '')}-${item.externalCode}`.slice(0, 80),
              })
            } else {
              await applySupplierStockBatchDelta(tx, {
                tenantId: record.tenantId,
                warehouseId: record.warehouseId,
                supplierId: balance.supplierId,
                productId: item.productId!,
                delta,
                movementId: movement.id,
                createdById: req.user.userId,
                positiveKind: 'ADJUSTMENT',
              })
            }
          }
          await tx.productExternalCode.upsert({
            where: {
              tenantId_source_externalCode: {
                tenantId: record.tenantId,
                source: record.source,
                externalCode: item.externalCode,
              },
            },
            update: {
              productId: item.productId!,
              externalName: item.externalName,
              verifiedById: req.user.userId,
              verifiedAt: new Date(),
            },
            create: {
              tenantId: record.tenantId,
              productId: item.productId!,
              source: record.source,
              externalCode: item.externalCode,
              externalName: item.externalName,
              verifiedById: req.user.userId,
              verifiedAt: new Date(),
            },
          })
          await tx.warehouseInventoryImportItem.update({
            where: { id: item.id },
            data: { oldQuantity: balance.stock, delta, movementId },
          })
        }
        const updated = await tx.warehouseInventoryImport.updateMany({
          where: { id: record.id, tenantId: record.tenantId, status: 'STAGED', rowVersion: body.data.rowVersion },
          data: {
            status: 'CONFIRMED',
            confirmedById: req.user.userId,
            confirmedAt: new Date(),
            rowVersion: { increment: 1 },
          },
        })
        if (updated.count !== 1) throw Object.assign(new Error('导入单状态已变化，请刷新后重试'), { statusCode: 409 })
        await tx.opLog.create({
          data: {
            tenantId: record.tenantId,
            userId: req.user.userId,
            role: req.user.role,
            action: `确认美团库存快照 ${record.no}`,
            entityType: 'WarehouseInventoryImport',
            target: record.no,
            targetId: record.id,
            metadata: json({ snapshotDate: dateText(record.snapshotDate), itemCount: record.itemCount, fileHash: record.fileHash }),
          },
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 })
      void invalidatePattern(`products:full:${req.user.tenantId}:*`)
      const loaded = await loadImport(req.user.tenantId, importId)
      return publicImport(loaded)
    } catch (error: any) {
      req.log.error({ error, importId }, 'warehouse inventory import confirmation failed')
      return reply.status(error.statusCode || 500).send({ error: error.message || '库存确认失败，所有数据均未改动' })
    }
  })

  app.post('/:id/reverse', auth(app), async (req: any, reply: any) => {
    if (!requireInternalInventoryWrite(req, reply)) return
    if (legacySnapshotWritesPermanentlyRemoved()) {
      return reply.status(410).send({
        error: '历史库存快照从未允许生效，因此不存在可撤销的正式库存写入。',
        code: 'WAREHOUSE_SNAPSHOT_REVERSE_REMOVED',
      })
    }
    /* istanbul ignore next -- legacy body retained temporarily for migration archaeology; unreachable by design. */
    const body = z.object({
      rowVersion: z.number().int().nonnegative(),
      reason: z.string().trim().min(2).max(240),
    }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const importId = String(req.params.id)
    try {
      await prisma.$transaction(async tx => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-inventory-import:${req.user.tenantId}:${importId}`}))`)
        const record = await tx.warehouseInventoryImport.findFirst({
          where: { id: importId, tenantId: req.user.tenantId },
          include: { items: { orderBy: { rowNumber: 'asc' } } },
        })
        if (!record) throw Object.assign(new Error('库存导入单不存在'), { statusCode: 404 })
        if (record.status === 'REVERSED') return
        if (record.status !== 'CONFIRMED' || record.rowVersion !== body.data.rowVersion) {
          throw Object.assign(new Error('导入单状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        const later = await tx.warehouseInventoryImport.findFirst({
          where: {
            tenantId: record.tenantId,
            warehouseId: record.warehouseId,
            status: 'CONFIRMED',
            snapshotDate: { gt: record.snapshotDate },
          },
          select: { no: true, snapshotDate: true },
        })
        if (later) {
          throw Object.assign(new Error(`已有更晚库存快照 ${later.no}，不能撤销旧基准`), { statusCode: 409 })
        }
        const productIds = record.items.filter(item => item.productId).map(item => item.productId!)
        const balances = await lockedProducts(tx, record.tenantId, productIds)
        const reservations = await activeReservations(tx, record.tenantId, productIds)
        for (const item of record.items) {
          if (!item.productId || item.delta == null || new Prisma.Decimal(item.delta).isZero()) continue
          const balance = balances.get(item.productId)!
          if (!balance.supplierId) throw Object.assign(new Error(`${item.externalName} 未绑定供应商`), { statusCode: 409 })
          const inverseDelta = new Prisma.Decimal(item.delta).negated()
          const target = balance.stock.plus(inverseDelta)
          const reserved = reservations.get(item.productId) || new Prisma.Decimal(0)
          if (target.isNegative()) throw Object.assign(new Error(`${item.externalName} 当前库存不足以撤销该快照`), { statusCode: 409 })
          if (target.lessThan(reserved)) {
            throw Object.assign(new Error(`${item.externalName} 撤销后库存将低于已接订单预占`), { statusCode: 409 })
          }
          await tx.product.update({ where: { id: item.productId }, data: { stock: target } })
          await tx.warehouseStock.upsert({
            where: {
              tenantId_warehouseId_productId: {
                tenantId: record.tenantId,
                warehouseId: record.warehouseId,
                productId: item.productId,
              },
            },
            update: { physicalQty: target, isActive: true },
            create: {
              tenantId: record.tenantId,
              warehouseId: record.warehouseId,
              productId: item.productId,
              physicalQty: target,
            },
          })
          const movement = await tx.supplierStockMovement.create({
            data: {
              tenantId: record.tenantId,
              warehouseId: record.warehouseId,
              supplierId: balance.supplierId,
              productId: item.productId,
              delta: inverseDelta,
              balanceAfter: target,
              type: 'ADJUSTMENT',
              reason: `撤销美团库存快照 ${record.no}：${body.data.reason}`.slice(0, 240),
              sourceType: 'WarehouseInventoryImportReversal',
              sourceId: item.id,
              createdById: req.user.userId,
            },
          })
          await applySupplierStockBatchDelta(tx, {
            tenantId: record.tenantId,
            warehouseId: record.warehouseId,
            supplierId: balance.supplierId,
            productId: item.productId,
            delta: inverseDelta,
            movementId: movement.id,
            createdById: req.user.userId,
            positiveKind: 'ADJUSTMENT',
          })
          await tx.warehouseInventoryImportItem.update({
            where: { id: item.id }, data: { reversalMovementId: movement.id },
          })
        }
        const updated = await tx.warehouseInventoryImport.updateMany({
          where: { id: record.id, tenantId: record.tenantId, status: 'CONFIRMED', rowVersion: body.data.rowVersion },
          data: {
            status: 'REVERSED',
            reversedById: req.user.userId,
            reversedAt: new Date(),
            reversalReason: body.data.reason,
            rowVersion: { increment: 1 },
          },
        })
        if (updated.count !== 1) throw Object.assign(new Error('导入单状态已变化，请刷新后重试'), { statusCode: 409 })
        await tx.opLog.create({
          data: {
            tenantId: record.tenantId,
            userId: req.user.userId,
            role: req.user.role,
            action: `撤销美团库存快照 ${record.no}`,
            entityType: 'WarehouseInventoryImport',
            target: record.no,
            targetId: record.id,
            metadata: json({ reason: body.data.reason, snapshotDate: dateText(record.snapshotDate) }),
          },
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 })
      void invalidatePattern(`products:full:${req.user.tenantId}:*`)
      const loaded = await loadImport(req.user.tenantId, importId)
      return publicImport(loaded)
    } catch (error: any) {
      req.log.error({ error, importId }, 'warehouse inventory import reversal failed')
      return reply.status(error.statusCode || 500).send({ error: error.message || '撤销失败，所有数据均未改动' })
    }
  })

  app.post('/:id/baseline', auth(app), async (req: any, reply: any) => {
    if (!requireInternalInventoryWrite(req, reply)) return
    const body = z.object({
      rowVersion: z.number().int().nonnegative(),
    }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const importId = String(req.params.id)
    try {
      const result = await recordWarehouseBaselineSnapshot({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        role: req.user.role,
        importId,
        rowVersion: body.data.rowVersion,
      })

      if (result.blocked) {
        return reply.status(409).send({
          error: '基线建账被阻断：存在未解决的商品映射或数据问题',
          blockingIssues: result.blockingIssues,
        })
      }

      return {
        ok: true,
        importId: result.importId,
        importNo: result.importNo,
        warehouseId: result.warehouseId,
        snapshotAt: result.snapshotAt,
        createdCount: result.createdCount,
        adjustedCount: result.adjustedCount,
        items: result.items,
      }
    } catch (error: any) {
      req.log.error({ error, importId }, 'warehouse baseline import failed')
      return reply.status(error.statusCode || 500).send({ error: error.message || '基线建账失败，所有数据均未改动' })
    }
  })
}
