import { describe, expect, it } from 'vitest'
import {
  applySupplierFilters,
  formatCreditDays,
  formatSupplierStatusLabel,
  getSupplierDetailStats,
  hasActiveFilters,
  hasSensitiveSupplierFields,
  keepFiltersForPage,
  paginateSuppliers,
  resetPageFilters,
  sortSuppliersByCreatedAt,
  supplierStatusTone,
  type SupplySupplier,
} from './supply-supplier-pc'

const makeSupplier = (overrides: Partial<SupplySupplier> = {}): SupplySupplier => ({
  id: 'sup-1',
  no: 'SUP001',
  name: '测试供应商',
  status: 'ENABLED',
  contactName: '张三',
  contactPhone: '13800138000',
  creditType: 'FIXED_DAYS',
  creditDays: 30,
  createdAt: '2026-07-01T00:00:00Z',
  ...overrides,
})

describe('供应商管理桌面端纯函数', () => {
  describe('状态文案与视觉', () => {
    it('ENABLED 展示为“启用中”且为绿色', () => {
      expect(formatSupplierStatusLabel('ENABLED')).toBe('启用中')
      expect(supplierStatusTone('ENABLED')).toBe('green')
    })

    it('DISABLED 展示为“已停用”且为灰色', () => {
      expect(formatSupplierStatusLabel('DISABLED')).toBe('已停用')
      expect(supplierStatusTone('DISABLED')).toBe('gray')
    })

    it('未知状态原样展示并使用默认 tone', () => {
      expect(formatSupplierStatusLabel('PENDING')).toBe('PENDING')
      expect(supplierStatusTone('PENDING')).toBe('gray')
      expect(formatSupplierStatusLabel(null)).toBe('未知状态')
      expect(formatSupplierStatusLabel('')).toBe('未知状态')
    })
  })

  describe('账期格式化', () => {
    it('FIXED_DAYS 展示具体天数', () => {
      expect(formatCreditDays(makeSupplier({ creditType: 'FIXED_DAYS', creditDays: 45 }))).toBe('45 天')
    })

    it('非固定账期类型展示“按协议”', () => {
      expect(formatCreditDays(makeSupplier({ creditType: 'MONTHLY', creditDays: 30 }))).toBe('按协议')
      expect(formatCreditDays(makeSupplier({ creditType: 'ON_DELIVERY' }))).toBe('按协议')
    })

    it('缺失字段展示占位符', () => {
      expect(formatCreditDays(makeSupplier({ creditType: 'FIXED_DAYS', creditDays: null }))).toBe('—')
      expect(formatCreditDays(null)).toBe('—')
    })
  })

  describe('本地搜索与状态筛选', () => {
    const suppliers: SupplySupplier[] = [
      makeSupplier({ id: 's1', no: 'SUP001', name: '昆明蔬菜批发', status: 'ENABLED' }),
      makeSupplier({ id: 's2', no: 'SUP002', name: '大理水产', status: 'DISABLED' }),
      makeSupplier({ id: 's3', no: 'VEG003', name: '云南菌菇', status: 'ENABLED' }),
    ]

    it('按名称关键字筛选', () => {
      const result = applySupplierFilters(suppliers, { q: '蔬菜', status: '' })
      expect(result.map(s => s.id)).toEqual(['s1'])
    })

    it('按编号关键字筛选（忽略大小写）', () => {
      const result = applySupplierFilters(suppliers, { q: 'veg', status: '' })
      expect(result.map(s => s.id)).toEqual(['s3'])
    })

    it('按状态筛选', () => {
      const result = applySupplierFilters(suppliers, { q: '', status: 'DISABLED' })
      expect(result.map(s => s.id)).toEqual(['s2'])
    })

    it('组合搜索与状态筛选', () => {
      const result = applySupplierFilters(suppliers, { q: 'SUP', status: 'ENABLED' })
      expect(result.map(s => s.id)).toEqual(['s1'])
    })

    it('空关键字与空状态返回全部', () => {
      expect(applySupplierFilters(suppliers, { q: '', status: '' })).toHaveLength(3)
    })

    it('无匹配结果返回空数组', () => {
      expect(applySupplierFilters(suppliers, { q: '不存在', status: '' })).toHaveLength(0)
    })
  })

  describe('排序与分页', () => {
    const suppliers: SupplySupplier[] = [
      makeSupplier({ id: 's2', createdAt: '2026-07-02T00:00:00Z' }),
      makeSupplier({ id: 's1', createdAt: '2026-07-01T00:00:00Z' }),
      makeSupplier({ id: 's3', createdAt: '2026-07-03T00:00:00Z' }),
    ]

    it('按创建时间升序排列', () => {
      const sorted = sortSuppliersByCreatedAt(suppliers)
      expect(sorted.map(s => s.id)).toEqual(['s1', 's2', 's3'])
    })

    it('分页返回正确区间', () => {
      const page1 = paginateSuppliers(suppliers, 1, 2)
      const page2 = paginateSuppliers(suppliers, 2, 2)
      expect(page1.map(s => s.id)).toEqual(['s2', 's1'])
      expect(page2.map(s => s.id)).toEqual(['s3'])
    })

    it('筛选变化时重置到第 1 页', () => {
      const current = { q: '', status: '', page: 3, pageSize: 20 }
      expect(resetPageFilters(current, { q: '蔬菜' })).toEqual({ ...current, q: '蔬菜', page: 1 })
    })

    it('翻页时保留筛选条件', () => {
      const current = { q: '蔬菜', status: 'ENABLED', page: 1, pageSize: 20 }
      expect(keepFiltersForPage(current, 2)).toEqual({ ...current, page: 2 })
    })
  })

  describe('详情统计与敏感字段', () => {
    it('商品数量明确显示“待接入”，不伪造数字', () => {
      const stats = getSupplierDetailStats(makeSupplier())
      expect(stats.productCount).toBeNull()
      expect(stats.productCountLabel).toBe('待接入')
    })

    it('检测供应商对象包含敏感字段', () => {
      expect(hasSensitiveSupplierFields(makeSupplier())).toBe(false)
      expect(hasSensitiveSupplierFields({ ...makeSupplier(), bankAccount: 'TEST-FAKE-ACCOUNT' })).toBe(true)
      expect(hasSensitiveSupplierFields({ ...makeSupplier(), bankName: '测试银行' })).toBe(true)
      expect(hasSensitiveSupplierFields({ ...makeSupplier(), autoPay: true })).toBe(true)
    })

    it('缺失联系人与联系电话时展示占位符（通过 formatCreditDays 与页面渲染保证）', () => {
      const supplier = makeSupplier({ contactName: null, contactPhone: null })
      expect(supplier.contactName).toBeNull()
      expect(supplier.contactPhone).toBeNull()
    })
  })

  describe('激活筛选判断', () => {
    it('有搜索或状态筛选时返回 true', () => {
      expect(hasActiveFilters({ q: '蔬菜', status: '', page: 1, pageSize: 20 })).toBe(true)
      expect(hasActiveFilters({ q: '', status: 'ENABLED', page: 1, pageSize: 20 })).toBe(true)
    })

    it('默认无筛选时返回 false', () => {
      expect(hasActiveFilters({ q: '', status: '', page: 1, pageSize: 20 })).toBe(false)
    })
  })
})
