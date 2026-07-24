import { describe, expect, it } from 'vitest'
import {
  buildInventorySnapshotImportPlan,
  type InventorySnapshotImportProduct,
  type InventorySnapshotSourceItem,
  type PreviousInventorySnapshotItem,
} from '../../src/services/inventorySnapshotImport'

const sourceItem = (overrides: Partial<InventorySnapshotSourceItem> = {}): InventorySnapshotSourceItem => ({
  section: '测试岗',
  name: '测试商品',
  spec: '18个/箱',
  unit: '箱',
  quantity: 2,
  unitPrice: 180,
  amount: 360,
  sortOrder: 1,
  ...overrides,
})

const product = (overrides: Partial<InventorySnapshotImportProduct> = {}): InventorySnapshotImportProduct => ({
  id: 'product-a',
  tenantId: 'tenant-a',
  code: 'SKU-A',
  name: '测试商品',
  spec: '18个/箱',
  unit: '箱',
  inventoryUnit: '个',
  inventoryUnitsPerPurchaseUnit: 18,
  unitConversionStatus: 'VERIFIED',
  status: 'ENABLED',
  ...overrides,
})

const previousItem = (overrides: Partial<PreviousInventorySnapshotItem> = {}): PreviousInventorySnapshotItem => ({
  sortOrder: 1,
  rawName: '测试商品',
  rawSpec: '18个/箱',
  unit: '箱',
  productId: 'product-a',
  normalizedUnit: '个',
  normalizationFactor: 18,
  ...overrides,
})

describe('inventory snapshot import plan', () => {
  it('uses the current inventory-unit contract and ignores another tenant product', () => {
    const plan = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [sourceItem()],
      products: [
        product(),
        product({ id: 'product-b', tenantId: 'tenant-b', code: 'SKU-B' }),
      ],
    })

    expect(plan).toMatchObject({
      matchedCount: 1,
      unmatchedCount: 0,
      ambiguousCount: 0,
      normalizationPendingCount: 0,
      exactNameCount: 1,
      canCommit: true,
    })
    expect(plan.items[0]).toMatchObject({
      productId: 'product-a',
      matchSource: 'EXACT_NAME',
      normalization: {
        status: 'CONVERTED',
        normalizedQuantity: 36,
        normalizedUnit: '个',
        factor: 18,
      },
    })
  })

  it('reuses a frozen previous factor only for the same importable product and inventory unit', () => {
    const plan = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [sourceItem({ name: '盘点旧名称', spec: '24瓶/箱', unit: '瓶', quantity: 24 })],
      products: [product({
        name: '商品新名称',
        spec: '24瓶/箱',
        unit: '箱',
        inventoryUnit: '箱',
        inventoryUnitsPerPurchaseUnit: 1,
      })],
      previousItems: [previousItem({
        rawName: '盘点旧名称',
        rawSpec: '24瓶/箱',
        unit: '瓶',
        normalizedUnit: '箱',
        normalizationFactor: 1 / 24,
      })],
    })

    expect(plan.canCommit).toBe(true)
    expect(plan.previousSnapshotCount).toBe(1)
    expect(plan.items[0]).toMatchObject({
      matchSource: 'PREVIOUS_SNAPSHOT',
      normalization: {
        normalizedQuantity: 1,
        normalizedUnit: '箱',
        factor: 1 / 24,
      },
    })
  })

  it('does not reuse an obsolete factor after the product inventory unit changes', () => {
    const plan = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [sourceItem({
        name: '羽衣甘蓝果汁包',
        spec: '箱/100袋/150g',
        unit: '袋',
        quantity: 102,
      })],
      products: [product({
        name: '羽衣甘蓝汁（果汁包）',
        spec: '箱/100袋/150g',
        unit: '箱',
        inventoryUnit: '袋',
        inventoryUnitsPerPurchaseUnit: 100,
      })],
      previousItems: [previousItem({
        rawName: '羽衣甘蓝果汁包',
        rawSpec: '箱/100袋/150g',
        unit: '袋',
        normalizedUnit: '箱',
        normalizationFactor: 1 / 100,
      })],
    })

    expect(plan.canCommit).toBe(true)
    expect(plan.items[0]).toMatchObject({
      matchSource: 'PREVIOUS_SNAPSHOT',
      normalization: {
        status: 'EXACT',
        normalizedQuantity: 102,
        normalizedUnit: '袋',
        factor: 1,
      },
    })
  })

  it('requires a reviewed remap when the previous product is disabled', () => {
    const plan = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [sourceItem({ name: '胡萝卜果汁包', spec: '100袋/件', unit: '袋', quantity: 60 })],
      products: [
        product({
          id: 'disabled-product',
          code: 'OLD-SKU',
          name: '胡萝卜果汁包 [已并入]',
          status: 'DISABLED',
          unit: '件',
          inventoryUnit: '袋',
          inventoryUnitsPerPurchaseUnit: 100,
        }),
        product({
          id: 'survivor',
          code: 'SURVIVOR',
          name: '冷冻香橙胡萝卜汁',
          unit: '箱',
          inventoryUnit: '包',
          inventoryUnitsPerPurchaseUnit: 120,
        }),
      ],
      previousItems: [previousItem({
        rawName: '胡萝卜果汁包',
        rawSpec: '100袋/件',
        unit: '袋',
        productId: 'disabled-product',
        normalizedUnit: '袋',
        normalizationFactor: 1,
      })],
    })

    expect(plan.canCommit).toBe(false)
    expect(plan.unmatchedCount).toBe(1)
    expect(plan.items[0].blockingIssue).toContain('已停用或不存在')
  })

  it('accepts an auditable reviewed factor only when its target is the current inventory unit', () => {
    const item = sourceItem({ name: '腐乳酱', spec: '箱/2kg*8袋', unit: '袋', quantity: 7 })
    const target = product({
      code: 'FERMENTED-TOFU',
      name: '复合腐乳酱',
      spec: '箱/2kg*8袋',
      unit: '箱',
      inventoryUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 1,
    })
    const plan = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [item],
      products: [target],
      reviewedBindings: [{
        sortOrder: 1,
        rawName: '腐乳酱',
        productCode: 'FERMENTED-TOFU',
        normalizedUnit: '箱',
        factorOverride: 1 / 8,
        note: '采购确认每箱八袋',
      }],
    })

    expect(plan.canCommit).toBe(true)
    expect(plan.reviewedCount).toBe(1)
    expect(plan.items[0]).toMatchObject({
      productId: 'product-a',
      matchSource: 'REVIEWED',
      normalization: {
        normalizedQuantity: 0.875,
        normalizedUnit: '箱',
        factor: 0.125,
      },
    })

    const wrongUnit = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [item],
      products: [target],
      reviewedBindings: [{
        sortOrder: 1,
        rawName: '腐乳酱',
        productCode: 'FERMENTED-TOFU',
        normalizedUnit: '袋',
        factorOverride: 1,
        note: '错误目标单位',
      }],
    })
    expect(wrongUnit.canCommit).toBe(false)
    expect(wrongUnit.items[0].blockingIssue).toContain('与商品库存单位')
  })

  it('records the review basis when a remap can use the current unit contract', () => {
    const plan = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [sourceItem({ name: '盘点旧名称' })],
      products: [product({ name: '存续商品' })],
      reviewedBindings: [{
        sortOrder: 1,
        rawName: '盘点旧名称',
        productCode: 'SKU-A',
        note: '采购确认旧名称并入该存续商品',
      }],
    })

    expect(plan).toMatchObject({ reviewedCount: 1, canCommit: true })
    expect(plan.items[0].normalizationNote).toContain('复核绑定：采购确认旧名称并入该存续商品')
  })

  it('blocks ambiguous, pending and unused reviewed rows instead of producing a partial baseline', () => {
    const ambiguous = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [sourceItem()],
      products: [product(), product({ id: 'product-c', code: 'SKU-C' })],
    })
    expect(ambiguous).toMatchObject({ ambiguousCount: 1, canCommit: false })

    const pending = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [sourceItem({ unit: '袋', quantity: 7 })],
      products: [product({ inventoryUnit: '箱', inventoryUnitsPerPurchaseUnit: 1 })],
    })
    expect(pending).toMatchObject({ normalizationPendingCount: 1, canCommit: false })

    const unusedBinding = buildInventorySnapshotImportPlan({
      tenantId: 'tenant-a',
      items: [sourceItem()],
      products: [product()],
      reviewedBindings: [{
        sortOrder: 2,
        rawName: '不存在的行',
        productCode: 'SKU-A',
        note: '不应被静默忽略',
      }],
    })
    expect(unusedBinding.canCommit).toBe(false)
    expect(unusedBinding.configurationIssues[0]).toContain('未命中源文件行')
  })
})
