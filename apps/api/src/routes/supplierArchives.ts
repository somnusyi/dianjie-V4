import { createHash } from 'node:crypto'
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import {
  assertSupplierArchiveObject,
  canManageSupplierArchiveGeneral,
  canManageSupplierArchiveSensitive,
  signOssKey,
} from './upload'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const idSchema = z.string().trim().min(1).max(64)
const sectionSchema = z.enum(['QUALIFICATION', 'FINANCE', 'INVOICE'])
const attachmentSchema = z.object({
  key: z.string().trim().min(1).max(1024),
  name: z.string().trim().min(1).max(255),
  mime: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  size: z.number().int().min(1).max(10 * 1024 * 1024),
}).strict()
const createSchema = z.object({
  section: sectionSchema,
  title: z.string().trim().min(1).max(160),
  note: z.string().trim().max(1000).optional().default(''),
  validFrom: z.string().date().nullable().optional(),
  validUntil: z.string().date().nullable().optional(),
  attachment: attachmentSchema.nullable().optional(),
  requestKey: z.string().trim().min(8).max(160),
}).strict().superRefine((value, ctx) => {
  if (value.validFrom && value.validUntil && value.validFrom > value.validUntil) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validUntil'], message: '有效期截止日不能早于开始日' })
  }
})

const VIEW_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPLY_CHAIN'])
const listQuerySchema = z.object({
  includeArchived: z.enum(['0', '1']).optional().default('0').transform(value => value === '1'),
}).strict()

export function supplierArchivePermissions(role: string) {
  return {
    canView: VIEW_ROLES.has(role),
    canManageGeneral: canManageSupplierArchiveGeneral(role),
    canViewSensitive: canManageSupplierArchiveSensitive(role),
    canManageSensitive: canManageSupplierArchiveSensitive(role),
  }
}

function fingerprint(supplierId: string, input: z.infer<typeof createSchema>) {
  return createHash('sha256').update(JSON.stringify({
    supplierId,
    section: input.section,
    title: input.title,
    note: input.note || '',
    validFrom: input.validFrom || null,
    validUntil: input.validUntil || null,
    attachment: input.attachment ? {
      key: input.attachment.key,
      name: input.attachment.name,
      mime: input.attachment.mime,
      size: input.attachment.size,
    } : null,
  })).digest('hex')
}

function archiveRecordView(record: any) {
  return {
    id: record.id,
    section: record.section,
    title: record.title,
    note: record.note || '',
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    fileName: record.fileName,
    fileMime: record.fileMime,
    fileSize: record.fileSize,
    fileUrl: signOssKey(record.objectKey),
    createdByName: record.createdByNameSnapshot,
    createdByRole: record.createdByRoleSnapshot,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
  }
}

async function loadSupplierForRole(input: { tenantId: string; role: string; supplierId: string }) {
  const supplier = await prisma.supplier.findFirst({
    where: { tenantId: input.tenantId, id: input.supplierId },
    select: {
      id: true,
      no: true,
      name: true,
      category: true,
      status: true,
      businessScopes: true,
      contactName: true,
      contactPhone: true,
      address: true,
      creditType: true,
      creditDays: true,
      bankName: true,
      bankAccount: true,
      bankAccountName: true,
      bankCode: true,
    },
  })
  if (!supplier) return null
  if (input.role === 'SUPPLY_CHAIN' && !supplier.businessScopes.includes('WAREHOUSE_UPSTREAM')) return null
  return supplier
}

export const supplierArchiveRoutes: FastifyPluginAsync = async app => {
  app.get('/:supplierId/archive', auth(app), async (req: any, reply: any) => {
    const permissions = supplierArchivePermissions(req.user.role)
    if (!permissions.canView) return reply.status(403).send({ error: '无权查看供应商集中档案' })
    const parsedId = idSchema.safeParse(req.params.supplierId)
    if (!parsedId.success) return reply.status(400).send({ error: '供应商 ID 格式不正确' })
    const query = listQuerySchema.safeParse(req.query || {})
    if (!query.success) return reply.status(400).send({ error: query.error.issues[0].message })
    if (query.data.includeArchived && !permissions.canViewSensitive) {
      return reply.status(403).send({ error: '只有财务或管理员可查看已归档历史' })
    }
    const supplier = await loadSupplierForRole({
      tenantId: req.user.tenantId,
      role: req.user.role,
      supplierId: parsedId.data,
    })
    if (!supplier) return reply.status(404).send({ error: '供应商不存在' })

    const [records, groupedCounts, contracts] = await Promise.all([
      prisma.supplierArchiveRecord.findMany({
        where: {
          tenantId: req.user.tenantId,
          supplierId: supplier.id,
          ...(!query.data.includeArchived ? { archivedAt: null } : {}),
          ...(!permissions.canViewSensitive ? { section: 'QUALIFICATION' as const } : {}),
        },
        orderBy: [{ section: 'asc' }, { createdAt: 'desc' }],
      }),
      prisma.supplierArchiveRecord.groupBy({
        by: ['section'],
        where: {
          tenantId: req.user.tenantId,
          supplierId: supplier.id,
          ...(!query.data.includeArchived ? { archivedAt: null } : {}),
          ...(!permissions.canViewSensitive ? { section: 'QUALIFICATION' as const } : {}),
        },
        _count: { _all: true },
      }),
      prisma.upstreamSupplierContract.findMany({
        where: { tenantId: req.user.tenantId, supplierId: supplier.id },
        select: {
          id: true,
          contractNo: true,
          version: true,
          title: true,
          startsAt: true,
          endsAt: true,
          settlementCycle: true,
          settlementDays: true,
          status: true,
          attachments: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
    ])
    const counts = Object.fromEntries(groupedCounts.map(row => [row.section, row._count._all]))
    const qualifications = records.filter(row => row.section === 'QUALIFICATION').map(archiveRecordView)
    const financialRecords = permissions.canViewSensitive
      ? records.filter(row => row.section === 'FINANCE').map(archiveRecordView)
      : undefined
    const invoiceRecords = permissions.canViewSensitive
      ? records.filter(row => row.section === 'INVOICE').map(archiveRecordView)
      : undefined

    return {
      supplier: {
        id: supplier.id,
        no: supplier.no,
        name: supplier.name,
        category: supplier.category,
        status: supplier.status,
        contactName: supplier.contactName,
        contactPhone: supplier.contactPhone,
        address: supplier.address,
        creditType: supplier.creditType,
        creditDays: supplier.creditDays,
        ...(permissions.canViewSensitive ? {
          bankName: supplier.bankName,
          bankAccount: supplier.bankAccount,
          bankAccountName: supplier.bankAccountName,
          bankCode: supplier.bankCode,
        } : {}),
      },
      permissions,
      sections: {
        qualifications: { restricted: false, count: counts.QUALIFICATION || 0, records: qualifications },
        contracts: {
          restricted: false,
          count: contracts.length,
          records: contracts.map(contract => ({
            ...contract,
            attachmentCount: Array.isArray(contract.attachments) ? contract.attachments.length : 0,
            attachments: undefined,
          })),
          source: 'UpstreamSupplierContract',
        },
        finance: {
          restricted: !permissions.canViewSensitive,
          ...(permissions.canViewSensitive ? { count: counts.FINANCE || 0, records: financialRecords } : { count: null }),
        },
        invoice: {
          restricted: !permissions.canViewSensitive,
          ...(permissions.canViewSensitive ? { count: counts.INVOICE || 0, records: invoiceRecords } : { count: null }),
        },
      },
    }
  })

  app.post('/:supplierId/archive', auth(app), async (req: any, reply: any) => {
    const parsedId = idSchema.safeParse(req.params.supplierId)
    if (!parsedId.success) return reply.status(400).send({ error: '供应商 ID 格式不正确' })
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const isSensitive = parsed.data.section !== 'QUALIFICATION'
    const allowed = isSensitive
      ? canManageSupplierArchiveSensitive(req.user.role)
      : canManageSupplierArchiveGeneral(req.user.role)
    if (!allowed) return reply.status(403).send({ error: isSensitive ? '无权维护财务或开票档案' : '无权维护供应商资质' })
    const supplier = await loadSupplierForRole({
      tenantId: req.user.tenantId,
      role: req.user.role,
      supplierId: parsedId.data,
    })
    if (!supplier) return reply.status(404).send({ error: '供应商不存在' })
    if (parsed.data.attachment) {
      await assertSupplierArchiveObject({
        tenantId: req.user.tenantId,
        sensitive: isSensitive,
        attachment: parsed.data.attachment,
      })
    }
    const requestFingerprint = fingerprint(supplier.id, parsed.data)
    const existing = await prisma.supplierArchiveRecord.findUnique({
      where: { tenantId_requestKey: { tenantId: req.user.tenantId, requestKey: parsed.data.requestKey } },
    })
    if (existing) {
      if (existing.supplierId !== supplier.id || existing.section !== parsed.data.section || existing.requestFingerprint !== requestFingerprint) {
        return reply.status(409).send({ error: '同一请求标识已用于不同的档案内容' })
      }
      return { ...archiveRecordView(existing), duplicated: true }
    }
    const actor = await prisma.user.findFirst({
      where: { tenantId: req.user.tenantId, id: req.user.userId },
      select: { id: true, name: true, role: true },
    })
    if (!actor) return reply.status(401).send({ error: '当前用户不存在' })
    try {
      const created = await prisma.$transaction(async tx => {
        const record = await tx.supplierArchiveRecord.create({
          data: {
            tenantId: req.user.tenantId,
            supplierId: supplier.id,
            section: parsed.data.section,
            title: parsed.data.title,
            note: parsed.data.note || null,
            validFrom: parsed.data.validFrom ? new Date(`${parsed.data.validFrom}T00:00:00.000Z`) : null,
            validUntil: parsed.data.validUntil ? new Date(`${parsed.data.validUntil}T00:00:00.000Z`) : null,
            objectKey: parsed.data.attachment?.key || null,
            fileName: parsed.data.attachment?.name || null,
            fileMime: parsed.data.attachment?.mime || null,
            fileSize: parsed.data.attachment?.size || null,
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
            action: '新增供应商档案条目',
            entityType: 'SupplierArchiveRecord',
            targetId: record.id,
            metadata: { supplierId: supplier.id, section: record.section, hasAttachment: Boolean(record.objectKey) },
          },
        })
        return record
      })
      return reply.status(201).send({ ...archiveRecordView(created), duplicated: false })
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const replay = await prisma.supplierArchiveRecord.findUnique({
          where: { tenantId_requestKey: { tenantId: req.user.tenantId, requestKey: parsed.data.requestKey } },
        })
        if (replay?.supplierId === supplier.id && replay.section === parsed.data.section && replay.requestFingerprint === requestFingerprint) {
          return { ...archiveRecordView(replay), duplicated: true }
        }
        return reply.status(409).send({ error: '同一请求标识已用于不同的档案内容' })
      }
      throw error
    }
  })

  app.patch('/:supplierId/archive/:recordId/archive', auth(app), async (req: any, reply: any) => {
    const supplierId = idSchema.safeParse(req.params.supplierId)
    const recordId = idSchema.safeParse(req.params.recordId)
    if (!supplierId.success || !recordId.success) return reply.status(400).send({ error: '档案 ID 格式不正确' })
    const record = await prisma.supplierArchiveRecord.findFirst({
      where: { tenantId: req.user.tenantId, supplierId: supplierId.data, id: recordId.data },
    })
    if (!record) return reply.status(404).send({ error: '档案条目不存在' })
    const isSensitive = record.section !== 'QUALIFICATION'
    const allowed = isSensitive
      ? canManageSupplierArchiveSensitive(req.user.role)
      : canManageSupplierArchiveGeneral(req.user.role)
    if (!allowed) return reply.status(403).send({ error: '无权归档该条目' })
    const supplier = await loadSupplierForRole({ tenantId: req.user.tenantId, role: req.user.role, supplierId: supplierId.data })
    if (!supplier) return reply.status(404).send({ error: '供应商不存在' })
    if (record.archivedAt) return { id: record.id, archivedAt: record.archivedAt, duplicated: true }
    const actor = await prisma.user.findFirst({
      where: { tenantId: req.user.tenantId, id: req.user.userId },
      select: { id: true, name: true, role: true },
    })
    if (!actor) return reply.status(401).send({ error: '当前用户不存在' })
    const result = await prisma.$transaction(async tx => {
      const archivedAt = new Date()
      const claimed = await tx.supplierArchiveRecord.updateMany({
        where: { tenantId: req.user.tenantId, id: record.id, archivedAt: null },
        data: {
          archivedAt,
          archivedById: actor.id,
          archivedByNameSnapshot: actor.name,
          archivedByRoleSnapshot: actor.role,
        },
      })
      if (claimed.count === 1) {
        await tx.opLog.create({
          data: {
            tenantId: req.user.tenantId,
            userId: actor.id,
            role: actor.role,
            action: '归档供应商档案条目',
            entityType: 'SupplierArchiveRecord',
            targetId: record.id,
            metadata: { supplierId: supplier.id, section: record.section },
          },
        })
      }
      const latest = await tx.supplierArchiveRecord.findFirst({
        where: { tenantId: req.user.tenantId, id: record.id },
        select: { archivedAt: true },
      })
      return { archivedAt: latest?.archivedAt || archivedAt, duplicated: claimed.count === 0 }
    })
    return { id: record.id, ...result }
  })
}
