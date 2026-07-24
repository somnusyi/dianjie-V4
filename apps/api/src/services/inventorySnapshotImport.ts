import {
  convertQuantityToInventoryUnit,
  type InventoryUnitNormalization,
  type ProductInventoryUnitLike,
} from './inventoryUnits'

export type InventorySnapshotSourceItem = {
  section: string | null
  name: string
  spec: string | null
  unit: string
  quantity: number
  unitPrice: number
  amount: number
  sortOrder: number
}

export type InventorySnapshotImportProduct = ProductInventoryUnitLike & {
  id: string
  tenantId: string
  code: string
  name: string
  spec: string | null
  status: string
}

export type PreviousInventorySnapshotItem = {
  sortOrder: number
  rawName: string
  rawSpec: string | null
  unit: string
  productId: string | null
  normalizedUnit: string | null
  normalizationFactor: number | string | { toString(): string } | null
}

export type ReviewedInventorySnapshotBinding = {
  sortOrder: number
  rawName: string
  productCode: string
  normalizedUnit?: string
  factorOverride?: number
  note: string
}

export type InventorySnapshotPlannedItem = InventorySnapshotSourceItem & {
  productId?: string
  productCode?: string
  productName?: string
  matchSource: 'REVIEWED' | 'PREVIOUS_SNAPSHOT' | 'EXACT_NAME' | 'UNMATCHED' | 'AMBIGUOUS'
  normalization?: InventoryUnitNormalization
  normalizationNote?: string
  candidates?: Array<{ code: string; name: string }>
  blockingIssue?: string
}

export type InventorySnapshotImportPlan = {
  items: InventorySnapshotPlannedItem[]
  matchedCount: number
  unmatchedCount: number
  ambiguousCount: number
  normalizationPendingCount: number
  reviewedCount: number
  previousSnapshotCount: number
  exactNameCount: number
  configurationIssues: string[]
  canCommit: boolean
}

const IMPORTABLE_PRODUCT_STATUSES = new Set(['ENABLED', 'PENDING_DISABLE'])

function cleanText(value: string | null | undefined) {
  return String(value || '').trim()
}

function cleanUnit(value: string | null | undefined) {
  return cleanText(value).toLowerCase()
    .replace('公斤', 'kg')
    .replace('千克', 'kg')
    .replace('毫升', 'ml')
}

export function normalizeInventorySnapshotName(value: string) {
  return value.normalize('NFKC')
    .replace(/[\s·・]/g, '')
    .replace(/[（）]/g, character => character === '（' ? '(' : ')')
    .toLowerCase()
}

function sourceSignature(item: Pick<InventorySnapshotSourceItem, 'sortOrder' | 'name' | 'spec' | 'unit'>) {
  return [
    item.sortOrder,
    normalizeInventorySnapshotName(item.name),
    cleanText(item.spec).normalize('NFKC').toLowerCase(),
    cleanUnit(item.unit),
  ].join('|')
}

function positiveNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function currentInventoryUnit(product: InventorySnapshotImportProduct) {
  return cleanText(product.inventoryUnit) || cleanText(product.unit)
}

function reviewedBindingKey(binding: Pick<ReviewedInventorySnapshotBinding, 'sortOrder' | 'rawName'>) {
  return `${binding.sortOrder}|${normalizeInventorySnapshotName(binding.rawName)}`
}

export function buildInventorySnapshotImportPlan(input: {
  tenantId: string
  items: InventorySnapshotSourceItem[]
  products: InventorySnapshotImportProduct[]
  previousItems?: PreviousInventorySnapshotItem[]
  reviewedBindings?: ReviewedInventorySnapshotBinding[]
}): InventorySnapshotImportPlan {
  const configurationIssues: string[] = []
  const products = input.products.filter(product =>
    product.tenantId === input.tenantId && IMPORTABLE_PRODUCT_STATUSES.has(product.status)
  )
  const productById = new Map(products.map(product => [product.id, product]))
  const productByCode = new Map<string, InventorySnapshotImportProduct>()
  const productsByName = new Map<string, InventorySnapshotImportProduct[]>()
  for (const product of products) {
    if (productByCode.has(product.code)) {
      configurationIssues.push(`商品编码重复: ${product.code}`)
    } else {
      productByCode.set(product.code, product)
    }
    const key = normalizeInventorySnapshotName(product.name)
    productsByName.set(key, [...(productsByName.get(key) || []), product])
  }

  const previousBySignature = new Map<string, PreviousInventorySnapshotItem>()
  for (const previous of input.previousItems || []) {
    const signature = sourceSignature({
      sortOrder: previous.sortOrder,
      name: previous.rawName,
      spec: previous.rawSpec,
      unit: previous.unit,
    })
    if (previousBySignature.has(signature)) {
      configurationIssues.push(`上一基线模板行重复: ${previous.sortOrder} ${previous.rawName}`)
    } else {
      previousBySignature.set(signature, previous)
    }
  }

  const bindingByRow = new Map<string, ReviewedInventorySnapshotBinding>()
  for (const binding of input.reviewedBindings || []) {
    const key = reviewedBindingKey(binding)
    if (bindingByRow.has(key)) {
      configurationIssues.push(`复核绑定重复: ${binding.sortOrder} ${binding.rawName}`)
    } else {
      bindingByRow.set(key, binding)
    }
  }
  const consumedBindings = new Set<string>()

  const items = input.items.map<InventorySnapshotPlannedItem>(item => {
    const rowBindingKey = reviewedBindingKey({ sortOrder: item.sortOrder, rawName: item.name })
    const reviewed = bindingByRow.get(rowBindingKey)
    const previous = previousBySignature.get(sourceSignature(item))
    let product: InventorySnapshotImportProduct | undefined
    let matchSource: InventorySnapshotPlannedItem['matchSource'] = 'UNMATCHED'
    let candidates: InventorySnapshotPlannedItem['candidates']

    if (reviewed) {
      consumedBindings.add(rowBindingKey)
      product = productByCode.get(reviewed.productCode)
      if (!product) {
        return {
          ...item,
          matchSource: 'REVIEWED',
          blockingIssue: `复核绑定商品不可用于新基线: ${reviewed.productCode}`,
        }
      }
      matchSource = 'REVIEWED'
    } else if (previous?.productId && productById.has(previous.productId)) {
      product = productById.get(previous.productId)
      matchSource = 'PREVIOUS_SNAPSHOT'
    } else {
      const nameMatches = productsByName.get(normalizeInventorySnapshotName(item.name)) || []
      if (nameMatches.length === 1) {
        product = nameMatches[0]
        matchSource = 'EXACT_NAME'
      } else if (nameMatches.length > 1) {
        candidates = nameMatches.map(candidate => ({ code: candidate.code, name: candidate.name }))
        return {
          ...item,
          matchSource: 'AMBIGUOUS',
          candidates,
          blockingIssue: `商品名称匹配不唯一: ${candidates.map(candidate => candidate.code).join(', ')}`,
        }
      }
    }

    if (!product) {
      return {
        ...item,
        matchSource,
        blockingIssue: previous?.productId
          ? '上一基线绑定商品已停用或不存在，必须复核后绑定到存续商品'
          : '没有匹配到可用于新基线的存续商品',
      }
    }

    let normalization: InventoryUnitNormalization
    let normalizationNote: string | undefined
    if (reviewed && (reviewed.factorOverride != null || reviewed.normalizedUnit != null)) {
      const factor = positiveNumber(reviewed.factorOverride)
      const normalizedUnit = cleanText(reviewed.normalizedUnit)
      const expectedUnit = currentInventoryUnit(product)
      if (!factor || !normalizedUnit) {
        return {
          ...item,
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          matchSource,
          blockingIssue: '人工换算必须同时提供正数 factorOverride 和 normalizedUnit',
        }
      }
      if (cleanUnit(normalizedUnit) !== cleanUnit(expectedUnit)) {
        return {
          ...item,
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          matchSource,
          blockingIssue: `人工换算目标单位 ${normalizedUnit} 与商品库存单位 ${expectedUnit} 不一致`,
        }
      }
      if (!cleanText(reviewed.note)) {
        return {
          ...item,
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          matchSource,
          blockingIssue: '人工换算必须记录确认依据',
        }
      }
      normalization = {
        status: cleanUnit(item.unit) === cleanUnit(normalizedUnit) && factor === 1 ? 'EXACT' : 'CONVERTED',
        normalizedQuantity: item.quantity * factor,
        normalizedUnit,
        factor,
        note: `复核换算：${reviewed.note}`,
      }
      normalizationNote = normalization.note
    } else {
      const previousFactor = previous?.productId === product.id ? positiveNumber(previous.normalizationFactor) : null
      const previousUnit = cleanText(previous?.normalizedUnit)
      const expectedUnit = currentInventoryUnit(product)
      if (previousFactor && cleanUnit(previousUnit) === cleanUnit(expectedUnit)) {
        normalization = {
          status: cleanUnit(item.unit) === cleanUnit(expectedUnit) && previousFactor === 1 ? 'EXACT' : 'CONVERTED',
          normalizedQuantity: item.quantity * previousFactor,
          normalizedUnit: expectedUnit,
          factor: previousFactor,
          note: '沿用上一份同模板实盘已冻结的换算系数',
        }
        normalizationNote = normalization.note
      } else {
        normalization = convertQuantityToInventoryUnit({
          quantity: item.quantity,
          sourceUnit: item.unit,
          product,
          productSpec: product.spec,
        })
        normalizationNote = reviewed
          ? `${normalization.note}; 复核绑定：${reviewed.note}`
          : normalization.note
      }
    }

    return {
      ...item,
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      matchSource,
      normalization,
      normalizationNote,
      blockingIssue: normalization.status === 'PENDING' || normalization.normalizedQuantity == null
        ? normalization.note
        : undefined,
    }
  })

  for (const [key, binding] of bindingByRow) {
    if (!consumedBindings.has(key)) {
      configurationIssues.push(`复核绑定未命中源文件行: ${binding.sortOrder} ${binding.rawName}`)
    }
  }

  const matchedCount = items.filter(item => item.productId).length
  const unmatchedCount = items.filter(item => item.matchSource === 'UNMATCHED').length
  const ambiguousCount = items.filter(item => item.matchSource === 'AMBIGUOUS').length
  const normalizationPendingCount = items.filter(item =>
    item.productId && (!item.normalization || item.normalization.status === 'PENDING' || item.normalization.normalizedQuantity == null)
  ).length
  const blockingRows = items.filter(item => item.blockingIssue).length

  return {
    items,
    matchedCount,
    unmatchedCount,
    ambiguousCount,
    normalizationPendingCount,
    reviewedCount: items.filter(item => item.matchSource === 'REVIEWED' && !item.blockingIssue).length,
    previousSnapshotCount: items.filter(item => item.matchSource === 'PREVIOUS_SNAPSHOT' && !item.blockingIssue).length,
    exactNameCount: items.filter(item => item.matchSource === 'EXACT_NAME' && !item.blockingIssue).length,
    configurationIssues,
    canCommit: configurationIssues.length === 0 && blockingRows === 0,
  }
}
