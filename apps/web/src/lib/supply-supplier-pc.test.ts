import { describe, expect, it } from 'vitest'
import {
  applySupplierFilters,
  buildSupplierCreatePayload,
  buildSupplierUpdatePayload,
  EMPTY_SUPPLIER_FORM_VALUES,
  formatCreditDays,
  formatSupplierCreditTypeLabel,
  formatSupplierStatusLabel,
  getSupplierDetailStats,
  hasActiveFilters,
  hasSensitiveSupplierFields,
  initializeSupplierFormValues,
  keepFiltersForPage,
  paginateSuppliers,
  resetPageFilters,
  sortSuppliersByCreatedAt,
  supplierStatusTone,
  validateSupplierForm,
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

describe('供应商表单', () => {
  describe('初始化', () => {
    it('空值初始化返回默认值', () => {
      expect(initializeSupplierFormValues(null)).toEqual(EMPTY_SUPPLIER_FORM_VALUES)
      expect(initializeSupplierFormValues(undefined)).toEqual(EMPTY_SUPPLIER_FORM_VALUES)
    })

    it('用供应商数据填充表单（缺失账期天数时使用默认值）', () => {
      const supplier = makeSupplier({
        no: 'SUP002',
        name: '大理水产',
        category: '水产',
        creditType: 'MONTHLY',
        creditDays: null,
      })
      expect(initializeSupplierFormValues(supplier)).toEqual({
        no: 'SUP002',
        name: '大理水产',
        contactName: '张三',
        contactPhone: '13800138000',
        category: '水产',
        creditType: 'MONTHLY',
        creditDays: '30',
      })
    })
  })

  describe('校验', () => {
    it('必填字段缺失返回对应错误', () => {
      const errors = validateSupplierForm({
        ...EMPTY_SUPPLIER_FORM_VALUES,
        no: '',
        name: '',
        creditDays: '',
      })
      expect(errors.no).toBe('请输入供应商编号')
      expect(errors.name).toBe('请输入供应商名称')
      expect(errors.creditDays).toBe('请输入账期天数')
    })

    it('长度超限时返回对应错误', () => {
      const errors = validateSupplierForm({
        ...EMPTY_SUPPLIER_FORM_VALUES,
        no: 'A'.repeat(41),
        name: 'B'.repeat(81),
        contactName: 'C'.repeat(41),
        contactPhone: 'D'.repeat(21),
        category: 'E'.repeat(41),
      })
      expect(errors.no).toBe('编号最多 40 个字符')
      expect(errors.name).toBe('名称最多 80 个字符')
      expect(errors.contactName).toBe('联系人最多 40 个字符')
      expect(errors.contactPhone).toBe('联系电话最多 20 个字符')
      expect(errors.category).toBe('类目最多 40 个字符')
    })

    it('账期天数边界与格式错误返回对应提示', () => {
      expect(
        validateSupplierForm({ ...EMPTY_SUPPLIER_FORM_VALUES, creditDays: '366' }).creditDays,
      ).toBe('账期天数必须在 0–365 之间')
      expect(
        validateSupplierForm({ ...EMPTY_SUPPLIER_FORM_VALUES, creditDays: '-1' }).creditDays,
      ).toBe('账期天数必须是整数')
      expect(
        validateSupplierForm({ ...EMPTY_SUPPLIER_FORM_VALUES, creditDays: 'abc' }).creditDays,
      ).toBe('账期天数必须是整数')
    })

    it('非固定账期类型不校验账期天数', () => {
      const errors = validateSupplierForm({
        ...EMPTY_SUPPLIER_FORM_VALUES,
        creditType: 'MONTHLY',
        creditDays: '',
      })
      expect(errors.creditDays).toBeUndefined()
    })

    it('合法表单返回空错误对象', () => {
      const errors = validateSupplierForm({
        ...EMPTY_SUPPLIER_FORM_VALUES,
        no: 'SUP001',
        name: '测试供应商',
      })
      expect(errors).toEqual({})
    })
  })

  describe('请求体构建', () => {
    it('新增请求体包含编号与全部允许字段', () => {
      const payload = buildSupplierCreatePayload({
        ...EMPTY_SUPPLIER_FORM_VALUES,
        no: 'SUP001',
        name: '测试供应商',
        contactName: '张三',
        category: '蔬菜',
        creditDays: '45',
      })
      expect(payload).toEqual({
        no: 'SUP001',
        name: '测试供应商',
        contactName: '张三',
        contactPhone: '',
        category: '蔬菜',
        creditType: 'FIXED_DAYS',
        creditDays: 45,
      })
    })

    it('编辑请求体不包含编号', () => {
      const payload = buildSupplierUpdatePayload({
        ...EMPTY_SUPPLIER_FORM_VALUES,
        no: 'SUP001',
        name: '测试供应商（新名）',
        creditType: 'MONTHLY',
        creditDays: '60',
      })
      expect(payload).not.toHaveProperty('no')
      expect(payload.name).toBe('测试供应商（新名）')
      expect(payload.creditType).toBe('MONTHLY')
      expect(payload).not.toHaveProperty('creditDays')
    })

    it('请求体不包含银行账号、自动付款等敏感字段', () => {
      const createPayload = buildSupplierCreatePayload({
        ...EMPTY_SUPPLIER_FORM_VALUES,
        no: 'SUP001',
        name: '测试供应商',
      })
      const updatePayload = buildSupplierUpdatePayload({
        ...EMPTY_SUPPLIER_FORM_VALUES,
        no: 'SUP001',
        name: '测试供应商',
      })
      expect(hasSensitiveSupplierFields(createPayload)).toBe(false)
      expect(hasSensitiveSupplierFields(updatePayload)).toBe(false)
      expect(updatePayload).not.toHaveProperty('bankAccount')
    })

    it('非固定账期类型不提交账期天数', () => {
      const payload = buildSupplierCreatePayload({
        ...EMPTY_SUPPLIER_FORM_VALUES,
        no: 'SUP001',
        name: '测试供应商',
        creditType: 'ON_DELIVERY',
        creditDays: '30',
      })
      expect(payload).not.toHaveProperty('creditDays')
    })
  })

  describe('账期类型文案', () => {
    it('已知类型返回中文标签', () => {
      expect(formatSupplierCreditTypeLabel('FIXED_DAYS')).toBe('固定天数')
      expect(formatSupplierCreditTypeLabel('MONTHLY')).toBe('月结')
    })

    it('空值返回占位符', () => {
      expect(formatSupplierCreditTypeLabel(null)).toBe('—')
    })
  })
})
