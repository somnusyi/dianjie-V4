import { describe, expect, it } from 'vitest'
import { previewWarehouseStocktakeImportRows } from './warehouse-stocktake-import'

const items = [
  { id: 'i1', productCodeSnapshot: 'P-01', productNameSnapshot: '土豆', inventoryUnit: 'kg', bookQuantity: '10' },
  { id: 'i2', productCodeSnapshot: 'P-02', productNameSnapshot: '白菜', inventoryUnit: 'kg', bookQuantity: '6.5' },
  { id: 'i3', productCodeSnapshot: 'P-03', productNameSnapshot: '大米', inventoryUnit: '袋', bookQuantity: '2', unitPending: true },
  { id: 'i4', productCodeSnapshot: 'P-04', productNameSnapshot: '萝卜', inventoryUnit: 'kg', bookQuantity: '3' },
]

describe('盘点结果导入预览', () => {
  it('只按物品编码和库存单位映射，零差异可无原因，差异必须有说明', () => {
    const result = previewWarehouseStocktakeImportRows([
      { 物品编码: 'P-01', 库存单位: 'kg', 实盘数量: 10, 差异说明: '' },
      { 商品编码: 'P-02', 单位: 'kg', 盘点数量: '0', 差异原因: '现场为零' },
      { 编码: '', 实盘数量: '' },
    ], items)
    expect(result).toMatchObject({ validCount: 2, errorCount: 0 })
    expect(result.rows.map(row => ({ itemId: row.itemId, quantity: row.countedQuantity, reason: row.reason }))).toEqual([
      { itemId: 'i1', quantity: '10', reason: '' },
      { itemId: 'i2', quantity: '0', reason: '现场为零' },
    ])
  })

  it('在预览阶段阻止重复、未知编码、单位不符、缺原因、非法数量和待核验换算', () => {
    const result = previewWarehouseStocktakeImportRows([
      { 物品编码: 'P-01', 实盘数量: '9' },
      { 物品编码: 'P-01', 实盘数量: '9', 差异说明: '重复' },
      { 物品编码: 'P-X', 实盘数量: '1' },
      { 物品编码: 'P-02', 库存单位: '箱', 实盘数量: '6.5' },
      { 物品编码: 'P-03', 实盘数量: '2' },
      { 物品编码: 'P-04', 实盘数量: '-1', 差异说明: '非法' },
    ], items)
    expect(result).toMatchObject({ validCount: 0, errorCount: 6 })
    expect(result.rows.map(row => row.error)).toEqual([
      '同一物品编码不能重复导入',
      '同一物品编码不能重复导入',
      '物品编码不在当前盘点分区',
      '库存单位应为kg',
      '该物品库存单位换算待核验',
      '实盘数量格式不正确，最多10位整数及6位小数',
    ])
  })
})
