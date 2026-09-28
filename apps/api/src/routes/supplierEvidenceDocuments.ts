import { createHash } from 'node:crypto'
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { isStoreScoped, storeScopeOf } from '../lib/auth-scope'
import { businessDayUtc, evaluateReceiptEvidenceCompleteness, PRODUCT_EVIDENCE_TYPES } from '../services/receiptEvidencePolicy'
import {
  assertSupplierEvidenceObject,
  canManageSupplierEvidence,
  signOssKey,
} from './upload'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const idSchema = z.string().trim().min(1).max(64)
const typeSchema = z.enum([
  'BUSINESS_LICENSE',
  'QUARANTINE_CERTIFICATE',
  'INSPECTION_REPORT',
  'SLAUGHTER_CERTIFICATE',
  'PRODUCTION_INSPECTION_REPORT',
  'THIRD_PARTY_TEST_REPORT',
  'PESTICIDE_RESIDUE_REPORT',
  'OTHER_PRODUCT_EVIDENCE',
])
const attachmentSchema = z.object({
  key: z.string().trim().min(1).max(1024),
  name: z.string().trim().min(1).max(255),
  mime: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  size: z.number().int().min(1).max(10 * 1024 * 1024),
}).strict()
const createDocumentSchema = z.object({
  type: typeSchema,
  title: z.string().trim().min(1).max(160),
  note: z.string().trim().max(1000).optional().default(''),
  validFrom: z.string().date().nullable().optional(),
  validUntil: z.string().date().nullable().optional(),
  productIds: z.array(idSchema).max(1000).optional().default([]),
  attachment: attachmentSchema,
  requestKey: z.string().trim().min(8).max(160),
}).strict().superRefine((value, ctx) => {
  if (value.validFrom && value.validUntil && value.validFrom > value.validUntil) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validUntil'], message: '有效期截止日不能早于开始日' })
  }
  if (value.type === 'BUSINESS_LICENSE' && value.productIds.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['productIds'], message: '营业执照是供应商级证照，不能关联商品' })
  }
  if (value.type !== 'BUSINESS_LICENSE' && value.productIds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['productIds'], message: '产品随货资料至少关联一个商品' })
  }
})
const listQuerySchema = z.object({
  includeArchived: z.enum(['0', '1']).optional().default('0').transform(value => value === '1'),
}).strict()
const linkSchema = z.object({
  links: z.array(z.object({
    receiptLineId: idSchema,
    documentIds: z.array(idSchema).min(1).max(50),
  }).strict()).min(1).max(200),
  requestKey: z.string().trim().min(8).max(120),
  backfillReason: z.string().trim().min(2).max(500).optional(),
}).strict()
const requirementSchema = z.object({
  expectedStatus: z.enum(['PENDING', 'REQUIRED', 'NOT_REQUIRED']),
  expectedRequiredTypes: z.array(z.enum(PRODUCT_EVIDENCE_TYPES)).max(PRODUCT_EVIDENCE_TYPES.length),
  expectedVersion: z.number().int().min(0),
  status: z.enum(['PENDING', 'REQUIRED', 'NOT_REQUIRED']),
  requiredTypes: z.array(z.enum(PRODUCT_EVIDENCE_TYPES)).max(PRODUCT_EVIDENCE_TYPES.length),
  reason: z.string().trim().min(2).max(500),
  requestKey: z.string().trim().min(8).max(160),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.expectedRequiredTypes).size !== value.expectedRequiredTypes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedRequiredTypes'], message: '原所需资料类型不能重复' })
  }
  if (new Set(value.requiredTypes).size !== value.requiredTypes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredTypes'], message: '所需资料类型不能重复' })
  }
  if (value.status === 'REQUIRED' && value.requiredTypes.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredTypes'], message: '必须至少选择一种所需随货资料' })
  }
  if (value.status !== 'REQUIRED' && value.requiredTypes.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredTypes'], message: '只有必须提供时才能配置资料类型' })
  }
})
const voidLinkSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  requestKey: z.string().trim().min(8).max(160),
}).strict()

const INTERNAL_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPLY_CHAIN'])
const STORE_PROOF_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'CHEF', 'PURCHASER', 'KITCHEN_LEAD', 'SUPERVISOR', 'REGIONAL_MANAGER'])

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort()
}

function fingerprint(supplierId: string, input: z.infer<typeof createDocumentSchema>) {
  return createHash('sha256').update(JSON.stringify({
    supplierId,
    type: input.type,
    title: input.title,
    note: input.note || '',
    validFrom: input.validFrom || null,
    validUntil: input.validUntil || null,
    productIds: uniqueSorted(input.productIds),
    attachment: input.attachment,
  })).digest('hex')
}

function isExpired(validUntil: Date | string | null | undefined) {
  if (!validUntil) return false
  const end = new Date(validUntil)
  end.setUTCHours(23, 59, 59, 999)
  return end.getTime() < Date.now()
}

function documentView(document: any) {
  return {
    id: document.id,
    supplierId: document.supplierId,
    type: document.type,
    version: document.version,
    title: document.title,
    note: document.note || '',
    validFrom: document.validFrom,
    validUntil: document.validUntil,
    expired: isExpired(document.validUntil),
    archived: Boolean(document.archivedAt),
    archivedAt: document.archivedAt,
    fileName: document.fileName,
    fileMime: document.fileMime,
    fileSize: document.fileSize,
    fileUrl: signOssKey(document.objectKey),
    productIds: (document.products || []).map((row: any) => row.productId),
    products: (document.products || []).map((row: any) => row.product).filter(Boolean),
    createdByName: document.createdByNameSnapshot,
    createdByRole: document.createdByRoleSnapshot,
    createdAt: document.createdAt,
  }
}

export function collectTraceableDeliveryEvidence(movements: any[]) {
  const documents = new Map<string, any>()
  for (const movement of movements) for (const allocation of movement.lotAllocations || []) {
    const source = allocation.lot?.sourceMovement
    const line = source?.upstreamReceiptLine
    const sameWarehouse = movement.warehouseId === allocation.warehouseId
      && allocation.warehouseId === allocation.lot?.warehouseId
      && allocation.lot?.warehouseId === source?.warehouseId
    const sameProduct = movement.productId === allocation.productId
      && allocation.productId === allocation.lot?.productId
      && allocation.lot?.productId === source?.productId
      && source?.productId === line?.productId
    if (!sameWarehouse || !sameProduct || source?.type !== 'UPSTREAM_RECEIPT' || Number(source?.physicalDelta) <= 0 || !line || line.receipt?.status !== 'POSTED') continue
    for (const link of line.evidenceDocumentLinks || []) {
      if (link.voidedAt) continue
      const actualProduct = (link.document.products || []).find((row: any) => row.productId === line.productId)?.product
      if (!actualProduct) continue
      const item = documents.get(link.document.id) || {
        scope: 'PRODUCT',
        supplierName: line.receipt.supplier.name,
        type: link.document.type,
        title: link.document.title,
        version: link.document.version,
        validFrom: link.document.validFrom,
        validUntil: link.document.validUntil,
        expired: isExpired(link.document.validUntil),
        archived: Boolean(link.document.archivedAt),
        fileName: link.document.fileName,
        fileMime: link.document.fileMime,
        fileSize: link.document.fileSize,
        fileUrl: signOssKey(link.document.objectKey),
        actualProducts: [],
        originalAssociations: [],
        backfillAssociations: [],
      }
      if (!item.actualProducts.some((product: any) => product.id === actualProduct.id)) item.actualProducts.push(actualProduct)
      const association = { product: actualProduct, linkedAt: link.linkedAt }
      const target = link.linkedAfterPosted ? item.backfillAssociations : item.originalAssociations
      const value = link.linkedAfterPosted ? { ...association, reason: link.backfillReason || '未记录' } : association
      if (!target.some((saved: any) => saved.product.id === actualProduct.id && String(saved.linkedAt) === String(link.linkedAt))) target.push(value)
      documents.set(link.document.id, item)
    }
  }
  return [...documents.values()]
}

async function loadSupplierForEvidence(tenantId: string, role: string, supplierId: string) {
  const supplier = await prisma.supplier.findFirst({
    where: { tenantId, id: supplierId },
    select: { id: true, no: true, name: true, businessScopes: true },
  })
  if (!supplier) return null
  if (role === 'SUPPLY_CHAIN' && !supplier.businessScopes.includes('WAREHOUSE_UPSTREAM')) return null
  return supplier
}

async function actorOf(user: any) {
  return prisma.user.findFirst({
    where: { tenantId: user.tenantId, id: user.userId },
    select: { id: true, name: true, role: true },
  })
}

function strictReplay(existing: any, supplierId: string, type: string, requestFingerprint: string) {
  return existing?.supplierId === supplierId
    && existing?.type === type
    && existing?.requestFingerprint === requestFingerprint
}

export const supplierEvidenceDocumentRoutes: FastifyPluginAsync = async app => {
  app.get('/suppliers/:supplierId/evidence-documents', auth(app), async (req: any, reply: any) => {
    if (!INTERNAL_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看供应商证照与来货证明' })
    const supplierId = idSchema.safeParse(req.params.supplierId)
    const query = listQuerySchema.safeParse(req.query || {})
    if (!supplierId.success || !query.success) return reply.status(400).send({ error: '请求参数不正确' })
    const supplier = await loadSupplierForEvidence(req.user.tenantId, req.user.role, supplierId.data)
    if (!supplier) return reply.status(404).send({ error: '供应商不存在' })
    const documents = await prisma.supplierEvidenceDocument.findMany({
      where: {
        tenantId: req.user.tenantId,
        supplierId: supplier.id,
        ...(!query.data.includeArchived ? { archivedAt: null } : {}),
      },
      include: { products: { include: { product: { select: { id: true, code: true, name: true, spec: true } } } } },
      orderBy: [{ type: 'asc' }, { version: 'desc' }],
    })
    return { supplier, permissions: { canManage: canManageSupplierEvidence(req.user.role) }, items: documents.map(documentView) }
  })

  app.post('/suppliers/:supplierId/evidence-documents', auth(app), async (req: any, reply: any) => {
    if (!canManageSupplierEvidence(req.user.role)) return reply.status(403).send({ error: '无权维护供应商证照与来货证明' })
    const supplierId = idSchema.safeParse(req.params.supplierId)
    const parsed = createDocumentSchema.safeParse(req.body)
    if (!supplierId.success) return reply.status(400).send({ error: '供应商 ID 格式不正确' })
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const supplier = await loadSupplierForEvidence(req.user.tenantId, req.user.role, supplierId.data)
    if (!supplier) return reply.status(404).send({ error: '供应商不存在' })
    const productIds = uniqueSorted(parsed.data.productIds)
    const requestFingerprint = fingerprint(supplier.id, { ...parsed.data, productIds })
    const existing = await prisma.supplierEvidenceDocument.findUnique({
      where: { tenantId_requestKey: { tenantId: req.user.tenantId, requestKey: parsed.data.requestKey } },
      include: { products: true },
    })
    if (existing) {
      if (!strictReplay(existing, supplier.id, parsed.data.type, requestFingerprint)) {
        return reply.status(409).send({ error: '同一请求标识已用于不同的证明内容' })
      }
      return { ...documentView(existing), duplicated: true }
    }
    if (productIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { tenantId: req.user.tenantId, id: { in: productIds } },
        select: { id: true },
      })
      if (products.length !== productIds.length) return reply.status(400).send({ error: '存在不属于当前租户的商品' })
    }
    await assertSupplierEvidenceObject({ tenantId: req.user.tenantId, attachment: parsed.data.attachment })
    const actor = await actorOf(req.user)
    if (!actor) return reply.status(401).send({ error: '当前用户不存在' })

    const createOnce = async () => prisma.$transaction(async tx => {
      const lockKey = `${req.user.tenantId}:${supplier.id}:${parsed.data.type}`
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
      const replay = await tx.supplierEvidenceDocument.findUnique({
        where: { tenantId_requestKey: { tenantId: req.user.tenantId, requestKey: parsed.data.requestKey } },
        include: { products: true },
      })
      if (replay) {
        if (!strictReplay(replay, supplier.id, parsed.data.type, requestFingerprint)) {
          const conflict: any = new Error('同一请求标识已用于不同的证明内容')
          conflict.statusCode = 409
          throw conflict
        }
        return { document: replay, duplicated: true }
      }
      const latest = await tx.supplierEvidenceDocument.aggregate({
        where: { tenantId: req.user.tenantId, supplierId: supplier.id, type: parsed.data.type },
        _max: { version: true },
      })
      const document = await tx.supplierEvidenceDocument.create({
        data: {
          tenantId: req.user.tenantId,
          supplierId: supplier.id,
          type: parsed.data.type,
          version: (latest._max.version || 0) + 1,
          title: parsed.data.title,
          note: parsed.data.note || null,
          validFrom: parsed.data.validFrom ? new Date(`${parsed.data.validFrom}T00:00:00.000Z`) : null,
          validUntil: parsed.data.validUntil ? new Date(`${parsed.data.validUntil}T00:00:00.000Z`) : null,
          objectKey: parsed.data.attachment.key,
          fileName: parsed.data.attachment.name,
          fileMime: parsed.data.attachment.mime,
          fileSize: parsed.data.attachment.size,
          requestKey: parsed.data.requestKey,
          requestFingerprint,
          createdById: actor.id,
          createdByNameSnapshot: actor.name,
          createdByRoleSnapshot: actor.role,
          products: productIds.length > 0 ? { create: productIds.map(productId => ({ tenantId: req.user.tenantId, productId })) } : undefined,
        },
        include: { products: true },
      })
      await tx.opLog.create({
        data: {
          tenantId: req.user.tenantId,
          userId: actor.id,
          role: actor.role,
          action: '新增供应商证照或来货证明',
          entityType: 'SupplierEvidenceDocument',
          targetId: document.id,
          metadata: { supplierId: supplier.id, type: document.type, version: document.version, productIds },
        },
      })
      return { document, duplicated: false }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await createOnce()
        return reply.status(result.duplicated ? 200 : 201).send({ ...documentView(result.document), duplicated: result.duplicated })
      } catch (error: any) {
        if (error?.statusCode === 409) return reply.status(409).send({ error: error.message })
        if (error?.code === 'P2034' && attempt < 2) continue
        if (error?.code === 'P2002') {
          const replay = await prisma.supplierEvidenceDocument.findUnique({
            where: { tenantId_requestKey: { tenantId: req.user.tenantId, requestKey: parsed.data.requestKey } },
            include: { products: true },
          })
          if (strictReplay(replay, supplier.id, parsed.data.type, requestFingerprint)) {
            return { ...documentView(replay), duplicated: true }
          }
          return reply.status(409).send({ error: '同一请求标识已用于不同的证明内容' })
        }
        throw error
      }
    }
  })

  app.patch('/suppliers/:supplierId/evidence-documents/:documentId/archive', auth(app), async (req: any, reply: any) => {
    if (!canManageSupplierEvidence(req.user.role)) return reply.status(403).send({ error: '无权归档该证明' })
    const supplierId = idSchema.safeParse(req.params.supplierId)
    const documentId = idSchema.safeParse(req.params.documentId)
    if (!supplierId.success || !documentId.success) return reply.status(400).send({ error: '证明 ID 格式不正确' })
    const supplier = await loadSupplierForEvidence(req.user.tenantId, req.user.role, supplierId.data)
    if (!supplier) return reply.status(404).send({ error: '供应商不存在' })
    const document = await prisma.supplierEvidenceDocument.findFirst({
      where: { tenantId: req.user.tenantId, supplierId: supplier.id, id: documentId.data },
    })
    if (!document) return reply.status(404).send({ error: '证明不存在' })
    if (document.archivedAt) return { id: document.id, archivedAt: document.archivedAt, duplicated: true }
    const actor = await actorOf(req.user)
    if (!actor) return reply.status(401).send({ error: '当前用户不存在' })
    const result = await prisma.$transaction(async tx => {
      const archivedAt = new Date()
      const claimed = await tx.supplierEvidenceDocument.updateMany({
        where: { tenantId: req.user.tenantId, id: document.id, archivedAt: null },
        data: { archivedAt, archivedById: actor.id, archivedByNameSnapshot: actor.name, archivedByRoleSnapshot: actor.role },
      })
      if (claimed.count === 1) await tx.opLog.create({
        data: {
          tenantId: req.user.tenantId,
          userId: actor.id,
          role: actor.role,
          action: '归档供应商证照或来货证明',
          entityType: 'SupplierEvidenceDocument',
          targetId: document.id,
          metadata: { supplierId: supplier.id, type: document.type, version: document.version },
        },
      })
      const current = await tx.supplierEvidenceDocument.findFirst({ where: { tenantId: req.user.tenantId, id: document.id }, select: { archivedAt: true } })
      return { archivedAt: current?.archivedAt || archivedAt, duplicated: claimed.count === 0 }
    })
    return { id: document.id, ...result }
  })

  app.patch('/suppliers/:supplierId/evidence-requirements/:productId', auth(app), async (req: any, reply: any) => {
    if (!canManageSupplierEvidence(req.user.role)) return reply.status(403).send({ error: '无权配置商品随货资料要求' })
    const supplierId = idSchema.safeParse(req.params.supplierId)
    const productId = idSchema.safeParse(req.params.productId)
    const parsed = requirementSchema.safeParse(req.body)
    if (!supplierId.success || !productId.success || !parsed.success) return reply.status(400).send({ error: '请求参数不正确' })
    const expectedRequiredTypes = uniqueSorted(parsed.data.expectedRequiredTypes)
    const requiredTypes = uniqueSorted(parsed.data.requiredTypes)
    const actor = await actorOf(req.user)
    if (!actor) return reply.status(401).send({ error: '当前用户不存在' })
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      productId: productId.data,
      expectedStatus: parsed.data.expectedStatus,
      expectedRequiredTypes,
      expectedVersion: parsed.data.expectedVersion,
      status: parsed.data.status,
      requiredTypes,
      reason: parsed.data.reason,
    })).digest('hex')
    const strictReplay = (row: any) => row
      && row.productId === productId.data
      && row.requestFingerprint === requestFingerprint
    const changeOnce = async () => prisma.$transaction(async tx => {
      const replay = await tx.productEvidenceRequirementChange.findUnique({
        where: { tenantId_requestKey: { tenantId: req.user.tenantId, requestKey: parsed.data.requestKey } },
      })
      if (replay) {
        if (!strictReplay(replay)) throw Object.assign(new Error('同一请求标识已用于不同的商品资料规则'), { statusCode: 409 })
        return { id: replay.productId, evidenceRequirement: replay.afterStatus, requiredEvidenceTypes: replay.afterRequiredTypes, evidenceRequirementVersion: replay.newVersion, duplicated: true }
      }
      const binding = await tx.productUpstreamSource.findFirst({
        where: { tenantId: req.user.tenantId, supplierId: supplierId.data, productId: productId.data, isActive: true },
        select: { id: true, product: { select: { evidenceRequirement: true, requiredEvidenceTypes: true, evidenceRequirementVersion: true, name: true } } },
      })
      if (!binding) return null
      if (binding.product.evidenceRequirement !== parsed.data.expectedStatus
        || binding.product.evidenceRequirementVersion !== parsed.data.expectedVersion
        || JSON.stringify(uniqueSorted(binding.product.requiredEvidenceTypes)) !== JSON.stringify(expectedRequiredTypes)) {
        throw Object.assign(new Error('商品随货资料规则已被他人更新，请刷新后重试'), { statusCode: 409 })
      }
      const claimed = await tx.product.updateMany({
        where: {
          tenantId: req.user.tenantId,
          id: productId.data,
          evidenceRequirement: parsed.data.expectedStatus,
          requiredEvidenceTypes: { equals: expectedRequiredTypes },
          evidenceRequirementVersion: parsed.data.expectedVersion,
        },
        data: { evidenceRequirement: parsed.data.status, requiredEvidenceTypes: requiredTypes, evidenceRequirementVersion: { increment: 1 } },
      })
      if (claimed.count !== 1) throw Object.assign(new Error('商品随货资料规则已被他人更新，请刷新后重试'), { statusCode: 409 })
      const newVersion = parsed.data.expectedVersion + 1
      await tx.productEvidenceRequirementChange.create({
        data: {
          tenantId: req.user.tenantId,
          productId: productId.data,
          beforeStatus: parsed.data.expectedStatus,
          afterStatus: parsed.data.status,
          beforeRequiredTypes: expectedRequiredTypes,
          afterRequiredTypes: requiredTypes,
          expectedVersion: parsed.data.expectedVersion,
          newVersion,
          reason: parsed.data.reason,
          requestKey: parsed.data.requestKey,
          requestFingerprint,
          createdById: actor.id,
          createdByNameSnapshot: actor.name,
          createdByRoleSnapshot: actor.role,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId: req.user.tenantId,
          userId: actor.id,
          role: actor.role,
          action: '配置商品随货资料要求',
          entityType: 'Product',
          targetId: productId.data,
          metadata: {
            supplierId: supplierId.data,
            productName: binding.product.name,
            before: binding.product.evidenceRequirement,
            after: parsed.data.status,
            beforeRequiredTypes: binding.product.requiredEvidenceTypes,
            afterRequiredTypes: requiredTypes,
            reason: parsed.data.reason,
          },
        },
      })
      return { id: productId.data, evidenceRequirement: parsed.data.status, requiredEvidenceTypes: requiredTypes, evidenceRequirementVersion: newVersion, duplicated: false }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    try {
      const result = await changeOnce()
      if (!result) return reply.status(404).send({ error: '该商品不在当前供应商的生效供货关系中' })
      return result
    } catch (error: any) {
      if (error?.statusCode === 409) return reply.status(409).send({ error: error.message })
      if (error?.code === 'P2002' || error?.code === 'P2034') {
        const replay = await prisma.productEvidenceRequirementChange.findUnique({
          where: { tenantId_requestKey: { tenantId: req.user.tenantId, requestKey: parsed.data.requestKey } },
        })
        if (replay && strictReplay(replay)) return { id: replay.productId, evidenceRequirement: replay.afterStatus, requiredEvidenceTypes: replay.afterRequiredTypes, evidenceRequirementVersion: replay.newVersion, duplicated: true }
        return reply.status(409).send({ error: '商品随货资料规则已并发变更，请刷新后重试' })
      }
      throw error
    }
  })

  app.get('/upstream/receipts/:receiptId/evidence-documents', auth(app), async (req: any, reply: any) => {
    if (!INTERNAL_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看到货证明关联' })
    const receiptId = idSchema.safeParse(req.params.receiptId)
    if (!receiptId.success) return reply.status(400).send({ error: '到货单 ID 格式不正确' })
    const receipt = await prisma.upstreamReceipt.findFirst({
      where: { tenantId: req.user.tenantId, id: receiptId.data },
      include: {
        supplier: { select: { id: true, no: true, name: true, businessScopes: true } },
        lines: {
          include: {
            product: { select: { id: true, code: true, name: true, spec: true, evidenceRequirement: true, requiredEvidenceTypes: true } },
            purchaseOrderLine: { select: { productNameSnapshot: true } },
            evidenceDocumentLinks: {
              include: { document: { include: { products: true } } },
              orderBy: { linkedAt: 'desc' },
            },
          },
        },
      },
    })
    if (!receipt || (req.user.role === 'SUPPLY_CHAIN' && !receipt.supplier.businessScopes.includes('WAREHOUSE_UPSTREAM'))) {
      return reply.status(404).send({ error: '到货单不存在' })
    }
    const completeness = await evaluateReceiptEvidenceCompleteness(prisma, {
      tenantId: req.user.tenantId,
      supplierId: receipt.supplier.id,
      businessAt: receipt.arrivedAt || new Date(),
      lines: receipt.lines,
    })
    return {
      receipt: {
        id: receipt.id,
        no: receipt.no,
        status: receipt.status,
        arrivedAt: receipt.arrivedAt,
        supplier: receipt.supplier,
        postedCompleteness: receipt.evidenceCompletenessSnapshot || null,
      },
      completeness,
      lines: receipt.lines.map(line => ({
        id: line.id,
        product: line.product,
        arrivedQty: line.arrivedQty,
        acceptedQty: line.acceptedQty,
        purchaseUnit: line.purchaseUnit,
        documents: line.evidenceDocumentLinks.filter(link => !link.voidedAt).map(link => ({
          linkId: link.id,
          linkedAt: link.linkedAt,
          linkedAfterPosted: link.linkedAfterPosted,
          backfillReason: link.backfillReason,
          ...documentView(link.document),
        })),
        voidedLinks: line.evidenceDocumentLinks.filter(link => Boolean(link.voidedAt)).map(link => ({ id: link.id, voidedAt: link.voidedAt, voidReason: link.voidReason })),
      })),
    }
  })

  app.post('/upstream/receipts/:receiptId/evidence-links', auth(app), async (req: any, reply: any) => {
    if (!canManageSupplierEvidence(req.user.role)) return reply.status(403).send({ error: '无权关联到货证明' })
    const receiptId = idSchema.safeParse(req.params.receiptId)
    const parsed = linkSchema.safeParse(req.body)
    if (!receiptId.success || !parsed.success) return reply.status(400).send({ error: parsed.success ? '到货单 ID 格式不正确' : parsed.error.issues[0].message })
    const receipt = await prisma.upstreamReceipt.findFirst({
      where: { tenantId: req.user.tenantId, id: receiptId.data },
      include: { supplier: { select: { businessScopes: true } }, lines: { select: { id: true, productId: true, arrivedQty: true, acceptedQty: true } } },
    })
    if (!receipt || (req.user.role === 'SUPPLY_CHAIN' && !receipt.supplier.businessScopes.includes('WAREHOUSE_UPSTREAM'))) return reply.status(404).send({ error: '到货单不存在' })
    if (receipt.status === 'REVERSED') return reply.status(409).send({ error: '已冲销到货单不能补录来货资料' })
    const linkedAfterPosted = receipt.status === 'POSTED'
    if (linkedAfterPosted && !parsed.data.backfillReason) return reply.status(400).send({ error: '已过账单据补录资料必须填写原因' })
    if (!linkedAfterPosted && parsed.data.backfillReason) return reply.status(400).send({ error: '过账前正常关联无需填写事后补录原因' })
    const lineMap = new Map(receipt.lines.map(line => [line.id, line]))
    const requestedLineIds = uniqueSorted(parsed.data.links.map(link => link.receiptLineId))
    if (requestedLineIds.some(id => !lineMap.has(id))) return reply.status(400).send({ error: '存在不属于该到货单的到货行' })
    if (requestedLineIds.some(id => Number(lineMap.get(id)!.arrivedQty) <= 0)) return reply.status(400).send({ error: '实到数量大于 0 的到货行才能关联随货资料' })
    const documentIds = uniqueSorted(parsed.data.links.flatMap(link => link.documentIds))
    const documents = await prisma.supplierEvidenceDocument.findMany({
      where: { tenantId: req.user.tenantId, supplierId: receipt.supplierId, id: { in: documentIds }, archivedAt: null },
      include: { products: true },
    })
    if (documents.length !== documentIds.length) return reply.status(400).send({ error: '存在不属于本供应商或已归档的证明' })
    if (documents.some(document => document.type === 'BUSINESS_LICENSE')) return reply.status(400).send({ error: '营业执照是供应商级企业证照，不能冒充产品随货资料' })
    const businessAt = businessDayUtc(receipt.arrivedAt || new Date())
    if (documents.some(document => (document.validFrom && document.validFrom > businessAt) || (document.validUntil && document.validUntil < businessAt))) {
      return reply.status(400).send({ error: '存在尚未生效或已超过有效期的证明，不能关联本次到货' })
    }
    const documentMap = new Map(documents.map(document => [document.id, document]))
    for (const requested of parsed.data.links) {
      const line = lineMap.get(requested.receiptLineId)!
      for (const documentId of uniqueSorted(requested.documentIds)) {
        const document = documentMap.get(documentId)!
        if (!document.products.some(row => row.productId === line.productId)) {
          return reply.status(400).send({ error: '产品随货资料未覆盖到货行商品' })
        }
      }
    }
    const actor = await actorOf(req.user)
    if (!actor) return reply.status(401).send({ error: '当前用户不存在' })
    const rows = parsed.data.links
      .flatMap(link => uniqueSorted(link.documentIds).map(documentId => ({ receiptLineId: link.receiptLineId, documentId })))
      .sort((a, b) => `${a.receiptLineId}:${a.documentId}`.localeCompare(`${b.receiptLineId}:${b.documentId}`))
      .map((row, index) => ({
        ...row,
        linkRequestKey: `${parsed.data.requestKey}:${index}`,
        linkRequestFingerprint: createHash('sha256').update(JSON.stringify({
          receiptId: receipt.id,
          ...row,
          linkedAfterPosted,
          backfillReason: parsed.data.backfillReason || null,
        })).digest('hex'),
      }))
    const writeBatch = async () => prisma.$transaction(async tx => {
      let createdCount = 0
      let duplicatedCount = 0
      for (const row of rows) {
        const replay = await tx.upstreamReceiptLineEvidenceDocument.findUnique({
          where: { tenantId_linkRequestKey: { tenantId: req.user.tenantId, linkRequestKey: row.linkRequestKey } },
        })
        if (replay) {
          if (replay.receiptLineId !== row.receiptLineId || replay.documentId !== row.documentId || replay.linkRequestFingerprint !== row.linkRequestFingerprint) {
            const conflict: any = new Error('同一请求标识已用于不同的证明关联')
            conflict.statusCode = 409
            throw conflict
          }
          duplicatedCount += 1
          continue
        }
        const active = await tx.upstreamReceiptLineEvidenceDocument.findFirst({
          where: { tenantId: req.user.tenantId, receiptLineId: row.receiptLineId, documentId: row.documentId, voidedAt: null },
        })
        if (active) {
          const conflict: any = new Error('该到货行已关联此证明，请勿使用新的请求标识重复提交')
          conflict.statusCode = 409
          throw conflict
        }
        await tx.upstreamReceiptLineEvidenceDocument.create({
          data: {
            tenantId: req.user.tenantId,
            ...row,
            linkedAfterPosted,
            backfillReason: linkedAfterPosted ? parsed.data.backfillReason : null,
            linkedById: actor.id,
            linkedByNameSnapshot: actor.name,
            linkedByRoleSnapshot: actor.role,
          },
        })
        createdCount += 1
      }
      if (createdCount > 0) await tx.opLog.create({
        data: {
          tenantId: req.user.tenantId,
          userId: actor.id,
          role: actor.role,
          action: linkedAfterPosted ? '事后补录到货行资料' : '关联到货行随货资料',
          entityType: 'UpstreamReceipt',
          targetId: receipt.id,
          metadata: {
            supplierId: receipt.supplierId,
            linkedAfterPosted,
            backfillReason: parsed.data.backfillReason || null,
            links: rows.map(({ receiptLineId, documentId }) => ({ receiptLineId, documentId })),
          },
        },
      })
      return { createdCount, duplicatedCount }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    const replayBatch = async () => {
      const existing = await prisma.upstreamReceiptLineEvidenceDocument.findMany({
        where: { tenantId: req.user.tenantId, linkRequestKey: { in: rows.map(row => row.linkRequestKey) } },
      })
      const byKey = new Map(existing.map(row => [row.linkRequestKey, row]))
      return rows.every(row => {
        const saved = byKey.get(row.linkRequestKey)
        return saved?.receiptLineId === row.receiptLineId && saved?.documentId === row.documentId && saved?.linkRequestFingerprint === row.linkRequestFingerprint
      })
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await writeBatch()
        return reply.status(result.createdCount > 0 ? 201 : 200).send({ linked: result.createdCount, duplicated: result.duplicatedCount })
      } catch (error: any) {
        if (error?.statusCode === 409) return reply.status(409).send({ error: error.message })
        if (error?.code === 'P2034' && attempt < 2) continue
        if (error?.code === 'P2002' || error?.code === 'P2034') {
          if (await replayBatch()) return reply.status(200).send({ linked: 0, duplicated: rows.length })
          return reply.status(409).send({ error: '证明关联正在被其他操作更新，或请求标识已用于不同内容' })
        }
        throw error
      }
    }
  })

  app.patch('/upstream/receipts/:receiptId/evidence-links/:linkId/void', auth(app), async (req: any, reply: any) => {
    if (!canManageSupplierEvidence(req.user.role)) return reply.status(403).send({ error: '无权作废到货证明关联' })
    const receiptId = idSchema.safeParse(req.params.receiptId)
    const linkId = idSchema.safeParse(req.params.linkId)
    const parsed = voidLinkSchema.safeParse(req.body)
    if (!receiptId.success || !linkId.success || !parsed.success) return reply.status(400).send({ error: '请求参数不正确' })
    const link = await prisma.upstreamReceiptLineEvidenceDocument.findFirst({
      where: { tenantId: req.user.tenantId, id: linkId.data, receiptLine: { receiptId: receiptId.data } },
      include: { receiptLine: { include: { receipt: { include: { supplier: { select: { businessScopes: true } } } } } } },
    })
    if (!link || (req.user.role === 'SUPPLY_CHAIN' && !link.receiptLine.receipt.supplier.businessScopes.includes('WAREHOUSE_UPSTREAM'))) {
      return reply.status(404).send({ error: '证明关联不存在' })
    }
    if (link.receiptLine.receipt.status === 'POSTED' && !link.linkedAfterPosted) return reply.status(409).send({ error: '过账前形成的原始随货资料关联已冻结，不可作废或改写' })
    if (link.receiptLine.receipt.status === 'REVERSED') return reply.status(409).send({ error: '已冲销到货单不能修改证明关联' })
    const voidRequestFingerprint = createHash('sha256').update(JSON.stringify({
      receiptId: receiptId.data,
      linkId: link.id,
      reason: parsed.data.reason,
    })).digest('hex')
    if (link.voidedAt) {
      if (link.voidRequestKey === parsed.data.requestKey && link.voidRequestFingerprint === voidRequestFingerprint) {
        return { id: link.id, voidedAt: link.voidedAt, duplicated: true }
      }
      return reply.status(409).send({ error: '该关联已由另一请求作废，不能改写历史原因' })
    }
    const actor = await actorOf(req.user)
    if (!actor) return reply.status(401).send({ error: '当前用户不存在' })
    const voidOnce = async () => prisma.$transaction(async tx => {
      const voidedAt = new Date()
      const claimed = await tx.upstreamReceiptLineEvidenceDocument.updateMany({
        where: { tenantId: req.user.tenantId, id: link.id, voidedAt: null },
        data: {
          voidedAt,
          voidedById: actor.id,
          voidedByNameSnapshot: actor.name,
          voidedByRoleSnapshot: actor.role,
          voidReason: parsed.data.reason,
          voidRequestKey: parsed.data.requestKey,
          voidRequestFingerprint,
        },
      })
      if (claimed.count === 1) await tx.opLog.create({
        data: {
          tenantId: req.user.tenantId,
          userId: actor.id,
          role: actor.role,
          action: '作废到货行证明关联',
          entityType: 'UpstreamReceiptLineEvidenceDocument',
          targetId: link.id,
          metadata: { receiptId: receiptId.data, reason: parsed.data.reason },
        },
      })
      const current = claimed.count === 0
        ? await tx.upstreamReceiptLineEvidenceDocument.findFirst({ where: { tenantId: req.user.tenantId, id: link.id } })
        : null
      if (current && (current.voidRequestKey !== parsed.data.requestKey || current.voidRequestFingerprint !== voidRequestFingerprint)) {
        const conflict: any = new Error('该关联已由另一请求作废，不能改写历史原因')
        conflict.statusCode = 409
        throw conflict
      }
      return { voidedAt: current?.voidedAt || voidedAt, duplicated: claimed.count === 0 }
    })
    try {
      const result = await voidOnce()
      return { id: link.id, ...result }
    } catch (error: any) {
      if (error?.statusCode === 409) return reply.status(409).send({ error: error.message })
      if (error?.code === 'P2002' || error?.code === 'P2034') {
        const winner = await prisma.upstreamReceiptLineEvidenceDocument.findFirst({ where: { tenantId: req.user.tenantId, id: link.id } })
        if (winner?.voidRequestKey === parsed.data.requestKey && winner.voidRequestFingerprint === voidRequestFingerprint) {
          return { id: winner.id, voidedAt: winner.voidedAt, duplicated: true }
        }
        return reply.status(409).send({ error: '该关联已由另一请求作废，或请求标识已用于其他关联' })
      }
      throw error
    }
  })

  app.get('/deliveries/:deliveryId/evidence-documents', auth(app), async (req: any, reply: any) => {
    if (!STORE_PROOF_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看门店到货证明' })
    const deliveryId = idSchema.safeParse(req.params.deliveryId)
    if (!deliveryId.success) return reply.status(400).send({ error: '配送单 ID 格式不正确' })
    const storeScope = storeScopeOf(req.user)
    const delivery = await prisma.deliveryOrder.findFirst({
      where: {
        tenantId: req.user.tenantId,
        id: deliveryId.data,
        status: { in: ['SHIPPED', 'DELIVERED', 'RECEIVED'] },
        ...(isStoreScoped(req.user.role) ? { storeId: { in: storeScope?.length ? storeScope : ['__NONE__'] } } : {}),
      },
      select: {
        id: true,
        no: true,
        storeId: true,
        warehouseId: true,
        status: true,
        pickerNameSnapshot: true,
        driverNameSnapshot: true,
        shippedBy: { select: { name: true } },
        deliveredBy: { select: { name: true } },
      },
    })
    if (!delivery) return reply.status(404).send({ error: '配送单不存在' })
    const movements = await prisma.warehouseLedgerMovement.findMany({
      where: {
        tenantId: req.user.tenantId,
        warehouseId: delivery.warehouseId || '__NONE__',
        type: 'ORDER_OUTBOUND',
        sourceType: 'DeliveryOrder',
        sourceId: delivery.id,
        physicalDelta: { lt: 0 },
      },
      select: {
        id: true,
        warehouseId: true,
        productId: true,
        lotAllocations: {
          where: { quantity: { gt: 0 } },
          select: {
            warehouseId: true,
            productId: true,
            lot: {
              select: {
                warehouseId: true,
                productId: true,
                sourceMovement: {
                  select: {
                    type: true,
                    physicalDelta: true,
                    warehouseId: true,
                    productId: true,
                    upstreamReceiptLine: {
                      select: {
                        id: true,
                        productId: true,
                        receipt: {
                          select: {
                            id: true,
                            no: true,
                            status: true,
                            arrivedAt: true,
                            evidenceCompletenessSnapshot: true,
                            inspectorId: true,
                            purchaseOrder: { select: { createdById: true } },
                            supplier: { select: { id: true, name: true } },
                          },
                        },
                        evidenceDocumentLinks: {
                          where: { voidedAt: null },
                          include: { document: { include: { products: { include: { product: { select: { id: true, code: true, name: true, spec: true } } } } } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })
    const items = collectTraceableDeliveryEvidence(movements)
    const tracedReceipts = movements.flatMap(movement => (movement.lotAllocations || []).map((allocation: any) => allocation.lot?.sourceMovement?.upstreamReceiptLine?.receipt).filter(Boolean))
    const frozenLicenseIds = uniqueSorted(tracedReceipts
      .map((receipt: any) => receipt.evidenceCompletenessSnapshot?.businessLicense?.documentId)
      .filter(Boolean))
    const businessLicenses = frozenLicenseIds.length > 0
      ? await prisma.supplierEvidenceDocument.findMany({
        where: { tenantId: req.user.tenantId, id: { in: frozenLicenseIds }, type: 'BUSINESS_LICENSE' },
        include: { supplier: { select: { name: true } } },
        orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
      })
      : []
    const supplierLicenseItems = businessLicenses.flatMap(document => {
      const dates = tracedReceipts
        .filter((receipt: any) => receipt.evidenceCompletenessSnapshot?.businessLicense?.documentId === document.id)
        .map((receipt: any) => businessDayUtc(receipt.arrivedAt || new Date()))
      if (dates.length === 0) return []
      return [{
        scope: 'SUPPLIER',
        supplierName: document.supplier.name,
        type: document.type,
        title: document.title,
        version: document.version,
        validFrom: document.validFrom,
        validUntil: document.validUntil,
        expired: isExpired(document.validUntil),
        archived: Boolean(document.archivedAt),
        fileName: document.fileName,
        fileMime: document.fileMime,
        fileSize: document.fileSize,
        fileUrl: signOssKey(document.objectKey),
        supplierBusinessDates: uniqueSorted(dates.map((day: Date) => day.toISOString().slice(0, 10))),
        actualProducts: [],
        originalAssociations: [],
        backfillAssociations: [],
      }]
    })
    const responsibilityIds = uniqueSorted(tracedReceipts.flatMap((receipt: any) => [receipt.purchaseOrder?.createdById, receipt.inspectorId].filter(Boolean)))
    const responsibilityUsers = responsibilityIds.length > 0
      ? await prisma.user.findMany({ where: { tenantId: req.user.tenantId, id: { in: responsibilityIds } }, select: { id: true, name: true } })
      : []
    const userName = new Map(responsibilityUsers.map(user => [user.id, user.name]))
    const named = (ids: string[]) => uniqueSorted(ids).map(id => userName.get(id) || '未记录')
    const purchaseOrderCreators = named(tracedReceipts.map((receipt: any) => receipt.purchaseOrder?.createdById).filter(Boolean))
    const warehouseInspectors = named(tracedReceipts.map((receipt: any) => receipt.inspectorId).filter(Boolean))
    return {
      delivery: { id: delivery.id, no: delivery.no, storeId: delivery.storeId, warehouseId: delivery.warehouseId, status: delivery.status },
      items: [...supplierLicenseItems, ...items],
      responsibilities: {
        purchaseOrderCreators: purchaseOrderCreators.length > 0 ? purchaseOrderCreators : ['未记录'],
        warehouseInspectors: warehouseInspectors.length > 0 ? warehouseInspectors : ['未记录'],
        sorter: delivery.pickerNameSnapshot || '未记录',
        deliveryPerson: delivery.driverNameSnapshot || '未记录',
        shippingOperator: delivery.shippedBy?.name || '未记录',
        deliveredOperator: delivery.deliveredBy?.name || '未记录',
      },
      message: supplierLicenseItems.length + items.length > 0 ? null : '暂无可追溯证明',
      tracePolicy: '仅展示由本配送单实际出库批次追溯到的供应商业务日有效营业执照和到货行产品资料，不按供应商名称泛查',
    }
  })
}
