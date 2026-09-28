import { Prisma } from '@dianjie/db'
import { businessDateKey } from '../lib/businessTime'

export const PRODUCT_EVIDENCE_TYPES = [
  'QUARANTINE_CERTIFICATE',
  'INSPECTION_REPORT',
  'SLAUGHTER_CERTIFICATE',
  'PRODUCTION_INSPECTION_REPORT',
  'THIRD_PARTY_TEST_REPORT',
  'PESTICIDE_RESIDUE_REPORT',
  'OTHER_PRODUCT_EVIDENCE',
] as const

type ProductEvidenceType = typeof PRODUCT_EVIDENCE_TYPES[number]

type ReceiptEvidenceLine = {
  id: string
  productId: string
  acceptedQty: Prisma.Decimal | number | string
  arrivedQty: Prisma.Decimal | number | string
  product?: {
    evidenceRequirement?: 'PENDING' | 'REQUIRED' | 'NOT_REQUIRED' | null
    requiredEvidenceTypes?: string[] | null
  } | null
  purchaseOrderLine?: { productNameSnapshot?: string | null } | null
}

type ReceiptEvidenceInput = {
  tenantId: string
  supplierId: string
  businessAt: Date
  lines: ReceiptEvidenceLine[]
}

export function businessDayUtc(value: Date) {
  return new Date(`${businessDateKey(value)}T00:00:00.000Z`)
}

function activeAtWhere(businessAt: Date) {
  const day = businessDayUtc(businessAt)
  return {
    archivedAt: null,
    AND: [
      { OR: [{ validFrom: null }, { validFrom: { lte: day } }] },
      { OR: [{ validUntil: null }, { validUntil: { gte: day } }] },
    ],
  }
}

/**
 * 只读评估来货资料完整性。本轮只做缺件提示与补传，不增加未经授权的过账阻断。
 */
export async function evaluateReceiptEvidenceCompleteness(tx: any, input: ReceiptEvidenceInput) {
  const arrivedLines = input.lines.filter(line => Number(line.arrivedQty) > 0)
  const businessLicense = await tx.supplierEvidenceDocument.findFirst({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      type: 'BUSINESS_LICENSE',
      ...activeAtWhere(input.businessAt),
    },
    select: { id: true, version: true, createdAt: true },
  })
  const links = arrivedLines.length > 0 ? await tx.upstreamReceiptLineEvidenceDocument.findMany({
    where: {
      tenantId: input.tenantId,
        receiptLineId: { in: arrivedLines.map(line => line.id) },
      voidedAt: null,
      document: {
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        type: { not: 'BUSINESS_LICENSE' },
        ...activeAtWhere(input.businessAt),
      },
    },
    select: {
      receiptLineId: true,
      document: { select: { id: true, type: true, products: { select: { productId: true } } } },
    },
  }) : []
  const productByLine = new Map(arrivedLines.map(line => [line.id, line.productId]))
  const evidenceTypesByLine = new Map<string, Set<ProductEvidenceType>>()
  for (const link of links) {
    const productId = productByLine.get(link.receiptLineId)
    if (productId && link.document.products.some((row: any) => row.productId === productId)) {
      const types = evidenceTypesByLine.get(link.receiptLineId) || new Set<ProductEvidenceType>()
      types.add(link.document.type as ProductEvidenceType)
      evidenceTypesByLine.set(link.receiptLineId, types)
    }
  }
  const lines = arrivedLines.map(line => {
    const requirement = line.product?.evidenceRequirement || 'PENDING'
    const requiredTypes = [...new Set(line.product?.requiredEvidenceTypes || [])]
      .filter((type): type is ProductEvidenceType => PRODUCT_EVIDENCE_TYPES.includes(type as ProductEvidenceType))
    const providedTypes = [...(evidenceTypesByLine.get(line.id) || new Set<ProductEvidenceType>())]
    const missingTypes = requiredTypes.filter(type => !providedTypes.includes(type))
    const evidenceCount = providedTypes.length
    const status = requirement === 'PENDING'
      ? 'PENDING_CONFIGURATION'
      : requirement === 'NOT_REQUIRED'
        ? 'NOT_REQUIRED'
        : requiredTypes.length === 0
          ? 'PENDING_CONFIGURATION'
          : missingTypes.length === 0 ? 'COMPLETE' : 'MISSING'
    return {
      receiptLineId: line.id,
      productId: line.productId,
      productName: line.purchaseOrderLine?.productNameSnapshot || line.productId,
      requirement,
      status,
      evidenceCount,
      requiredTypes,
      providedTypes,
      missingTypes,
    }
  })
  return {
    evaluatedAt: new Date(),
    businessDate: businessDayUtc(input.businessAt),
    businessLicense: businessLicense
      ? { status: 'COMPLETE', documentId: businessLicense.id, version: businessLicense.version, recordedAt: businessLicense.createdAt }
      : { status: 'MISSING', documentId: null, version: null, recordedAt: null },
    lines,
    missingCount: lines.reduce((count, line) => count + line.missingTypes.length, 0) + (businessLicense ? 0 : 1),
    pendingConfigurationCount: lines.filter(line => line.status === 'PENDING_CONFIGURATION').length,
    blocksPosting: false,
  }
}
