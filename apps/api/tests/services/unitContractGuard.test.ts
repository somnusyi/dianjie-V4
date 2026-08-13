import { describe, expect, it } from 'vitest'
import {
  productInventoryUnitCost,
  costContractRepricingError,
  costOutlierError,
  inventoryUnitCost,
} from '../../src/services/unitContractGuard'

describe('inventoryUnitCost', () => {
  it('把采购价折算成每最小库存单位成本', () => {
    // ¥122/件，每件 1000g → ¥0.122/g
    expect(inventoryUnitCost({ price: 122, inventoryUnitsPerCostUnit: 1000 })!.toString()).toBe('0.122')
  })

  it('契约不完整时返回 null，不抢既有四单位校验的活', () => {
    expect(inventoryUnitCost({ price: 122, inventoryUnitsPerCostUnit: null })).toBeNull()
    expect(inventoryUnitCost({ price: null, inventoryUnitsPerCostUnit: 1000 })).toBeNull()
    expect(inventoryUnitCost({ price: 122, inventoryUnitsPerCostUnit: 0 })).toBeNull()
  })
})

describe('productInventoryUnitCost 成本兜底口径', () => {
  it('分母是每成本单位库存量，不是每采购单位库存量', () => {
    // 当两个换算率相等时(今天全部商品都是这样)，两种读法结果相同，
    // 所以历史上那几处写错的兜底一直没暴露。
    expect(productInventoryUnitCost({ price: 122, inventoryUnitsPerCostUnit: 1000 })).toBeCloseTo(0.122, 6)

    // 一旦成本单位与采购单位不同——项目规则「成本单位=最小库存单位」正是要求这么做——
    // 用每采购单位换算(1000)会算出 0.0244，真实值是 24.4，差 1000 倍。
    expect(productInventoryUnitCost({ price: 24.4, inventoryUnitsPerCostUnit: 1 })).toBeCloseTo(24.4, 6)
  })

  it('契约不完整时返回 null，交给调用方兜底为 0 而不是算出错数', () => {
    expect(productInventoryUnitCost({ price: 122, inventoryUnitsPerCostUnit: null })).toBeNull()
    expect(productInventoryUnitCost({ price: null, inventoryUnitsPerCostUnit: 1 })).toBeNull()
  })
})

describe('costContractRepricingError 护栏一', () => {
  it('拦下 2026-08 保乐肩事故:成本单位改成 g 但价格没跟着折算', () => {
    const error = costContractRepricingError({
      before: { price: 122, inventoryUnitsPerCostUnit: 1000 },
      next: { price: 122, inventoryUnitsPerCostUnit: 1 },
      priceExplicitlyProvided: false,
      productName: '保乐肩',
      inventoryUnit: 'g',
    })
    expect(error).toContain('保乐肩')
    expect(error).toContain('¥0.122/g')
    expect(error).toContain('¥122.00/g')
  })

  it('价格同步折算后放行', () => {
    expect(costContractRepricingError({
      before: { price: 122, inventoryUnitsPerCostUnit: 1000 },
      next: { price: 0.122, inventoryUnitsPerCostUnit: 1 },
      priceExplicitlyProvided: true,
    })).toBeNull()
  })

  it('只换订货包装(箱→托)不属于成本口径变动，不该被拦', () => {
    // 每托单价会翻 12 倍，但每库存单位成本没变，这是正确的算术。
    expect(costContractRepricingError({
      before: { price: 240, inventoryUnitsPerCostUnit: 1 },
      next: { price: 240, inventoryUnitsPerCostUnit: 1 },
      priceExplicitlyProvided: false,
    })).toBeNull()
  })

  it('成本换算没变时不干预', () => {
    expect(costContractRepricingError({
      before: { price: 122, inventoryUnitsPerCostUnit: 1000 },
      next: { price: 122, inventoryUnitsPerCostUnit: 1000 },
      priceExplicitlyProvided: false,
    })).toBeNull()
  })

  it('显式改价时交给护栏二判断，这里不拦', () => {
    expect(costContractRepricingError({
      before: { price: 122, inventoryUnitsPerCostUnit: 1000 },
      next: { price: 130, inventoryUnitsPerCostUnit: 1000 },
      priceExplicitlyProvided: true,
    })).toBeNull()
  })

  it('千分之一以内的舍入差不算变化', () => {
    expect(costContractRepricingError({
      before: { price: 10, inventoryUnitsPerCostUnit: 3 },
      next: { price: 10.002, inventoryUnitsPerCostUnit: 3 },
      priceExplicitlyProvided: false,
    })).toBeNull()
  })
})

describe('costOutlierError 护栏二', () => {
  it('每库存单位成本高出近期收货成本 5 倍以上时拦下', () => {
    const error = costOutlierError({
      nextInventoryUnitCost: inventoryUnitCost({ price: 122, inventoryUnitsPerCostUnit: 1 }),
      historicalAverageCost: 0.122,
      sampleCount: 11,
      productName: '保乐肩',
      inventoryUnit: 'g',
    })
    expect(error).toContain('保乐肩')
    expect(error).toContain('相差超过 5 倍')
  })

  it('低于历史成本 5 倍以上同样拦下', () => {
    expect(costOutlierError({
      nextInventoryUnitCost: inventoryUnitCost({ price: 1, inventoryUnitsPerCostUnit: 1 }),
      historicalAverageCost: 100,
      sampleCount: 5,
    })).toContain('相差超过 5 倍')
  })

  it('正常波动放行', () => {
    expect(costOutlierError({
      nextInventoryUnitCost: inventoryUnitCost({ price: 130, inventoryUnitsPerCostUnit: 1000 }),
      historicalAverageCost: 0.122,
      sampleCount: 11,
    })).toBeNull()
  })

  it('样本不足的新商品不拦，避免挡住正常建档', () => {
    expect(costOutlierError({
      nextInventoryUnitCost: inventoryUnitCost({ price: 99999, inventoryUnitsPerCostUnit: 1 }),
      historicalAverageCost: 10,
      sampleCount: 1,
    })).toBeNull()
  })

  it('没有历史收货成本时不拦', () => {
    expect(costOutlierError({
      nextInventoryUnitCost: inventoryUnitCost({ price: 99999, inventoryUnitsPerCostUnit: 1 }),
      historicalAverageCost: null,
      sampleCount: 9,
    })).toBeNull()
  })
})
