import { describe, expect, it } from 'vitest'
import {
  buildBindItems,
  categoriesOfProducts,
  filterRelations,
  filterUnboundProducts,
  groupRelationsByProduct,
  groupRelationsBySupplier,
  groupUnboundByCategory,
  type SupplyRelation,
  type UnboundProduct,
} from './supply-relations'

const productA = { id: 'p1', code: 'P001', name: '舞茸菇', category: '常见菌类', spec: null, unit: '件', purchaseUnit: '件', inventoryUnit: 'g', inventoryUnitsPerPurchaseUnit: 6, price: 100, status: 'ENABLED' }
const productB = { id: 'p2', code: 'P002', name: '大米', category: '干货类', spec: null, unit: '袋', purchaseUnit: '袋', inventoryUnit: 'g', inventoryUnitsPerPurchaseUnit: 2500, price: 50, status: 'ENABLED' }
const supplierX = { id: 's1', no: 'GYS002', name: '井育苗菇', status: 'ENABLED' }
const supplierY = { id: 's2', no: 'GYS001', name: '瑶海行', status: 'ENABLED' }

const relations: SupplyRelation[] = [
  { id: 'r1', productId: 'p1', supplierId: 's1', isPrimary: false, supplierSku: null, purchaseUnit: '件', inventoryUnitsPerPurchaseUnit: 6, quotedUnitPrice: 100, minOrderQty: 1, leadTimeDays: 0, note: null, product: productA, supplier: supplierX },
  { id: 'r2', productId: 'p1', supplierId: 's2', isPrimary: true, supplierSku: null, purchaseUnit: '件', inventoryUnitsPerPurchaseUnit: 6, quotedUnitPrice: 98, minOrderQty: 1, leadTimeDays: 0, note: null, product: productA, supplier: supplierY },
  { id: 'r3', productId: 'p2', supplierId: 's1', isPrimary: true, supplierSku: null, purchaseUnit: '袋', inventoryUnitsPerPurchaseUnit: 2500, quotedUnitPrice: 50, minOrderQty: 1, leadTimeDays: 0, note: null, product: productB, supplier: supplierX },
]

describe('filterRelations', () => {
  it('matches keyword against product name, code and supplier name', () => {
    expect(filterRelations(relations, { q: '舞茸', category: '' })).toHaveLength(2)
    expect(filterRelations(relations, { q: 'P002', category: '' })).toHaveLength(1)
    expect(filterRelations(relations, { q: '瑶海', category: '' })).toHaveLength(1)
    expect(filterRelations(relations, { q: '', category: '' })).toHaveLength(3)
  })

  it('filters by product category with 其他 fallback', () => {
    expect(filterRelations(relations, { q: '', category: '干货类' })).toHaveLength(1)
    const noCategory = [{ ...relations[0], product: { ...productA, category: null } }]
    expect(filterRelations(noCategory, { q: '', category: '其他' })).toHaveLength(1)
  })
})

describe('groupRelationsBySupplier / ByProduct', () => {
  it('groups by supplier sorted by supplier no, primary first inside', () => {
    const groups = groupRelationsBySupplier(relations)
    expect(groups.map(g => g.supplier.name)).toEqual(['瑶海行', '井育苗菇'])
    const jingyu = groups[1]
    expect(jingyu.rows.map(r => r.id)).toEqual(['r3', 'r1']) // 主供置顶
  })

  it('groups by product sorted by category then code', () => {
    const groups = groupRelationsByProduct(relations)
    expect(groups.map(g => g.product.name)).toEqual(['舞茸菇', '大米'])
    expect(groups[0].rows[0].isPrimary).toBe(true)
  })
})

describe('unbound list helpers', () => {
  const unbound: UnboundProduct[] = [
    { ...productA, id: 'p9', code: 'P009', name: '虫草花' },
    { ...productB, id: 'p8', code: 'P008', name: '木耳' },
    { ...productA, id: 'p7', code: 'P007', name: '松茸' },
  ]

  it('groups unbound products by category with code order inside', () => {
    const groups = groupUnboundByCategory(unbound)
    expect(groups.map(g => g.category)).toEqual(['常见菌类', '干货类'])
    expect(groups[0].rows.map(r => r.code)).toEqual(['P007', 'P009'])
  })

  it('filters unbound by keyword', () => {
    expect(filterUnboundProducts(unbound, { q: '木耳', category: '' })).toHaveLength(1)
    expect(filterUnboundProducts(unbound, { q: '', category: '干货类' })).toHaveLength(1)
  })
})

describe('buildBindItems', () => {
  it('prefills archive unit, factor and price as quoted price', () => {
    const { items, missingConversion } = buildBindItems([productA, productB])
    expect(missingConversion).toEqual([])
    expect(items).toEqual([
      { productId: 'p1', purchaseUnit: '件', inventoryUnitsPerPurchaseUnit: 6, quotedUnitPrice: 100, isPrimary: false },
      { productId: 'p2', purchaseUnit: '袋', inventoryUnitsPerPurchaseUnit: 2500, quotedUnitPrice: 50, isPrimary: false },
    ])
  })

  it('skips products without conversion instead of guessing 1', () => {
    const broken = { ...productA, id: 'p0', inventoryUnitsPerPurchaseUnit: null }
    const { items, missingConversion } = buildBindItems([broken, productB])
    expect(items).toHaveLength(1)
    expect(missingConversion).toEqual(['p0'])
  })

  it('falls back to product unit when purchaseUnit missing and respects isPrimary', () => {
    const noPurchaseUnit = { ...productA, purchaseUnit: null }
    const { items } = buildBindItems([noPurchaseUnit], { isPrimary: true })
    expect(items[0]).toMatchObject({ purchaseUnit: '件', isPrimary: true })
  })
})

describe('categoriesOfProducts', () => {
  it('dedupes in first-seen order with 其他 fallback', () => {
    expect(categoriesOfProducts([productA, productB, { ...productA, category: null }])).toEqual(['常见菌类', '干货类', '其他'])
  })
})
