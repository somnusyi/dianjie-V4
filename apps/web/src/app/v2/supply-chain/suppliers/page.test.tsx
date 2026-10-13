// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'

import SuppliersPage from './page'
import { SENSITIVE_SUPPLIER_FIELDS } from '@/lib/supply-supplier-pc'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))

vi.mock('@/components/v2/skeleton', () => ({
  SkeletonList: ({ count }: { count?: number }) => <div data-skeleton="true">骨架 ×{count}</div>,
  EmptyState: ({ title, hint }: { title: string; hint?: string }) => (
    <div data-empty="true">
      <div data-empty-title="true">{title}</div>
      {hint && <div data-empty-hint="true">{hint}</div>}
    </div>
  ),
  FriendlyError: ({ message, onRetry }: { message?: string; onRetry?: () => void }) => (
    <div data-error="true">
      <span data-error-message="true">{message}</span>
      {onRetry && (
        <button data-retry="true" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  ),
}))

vi.mock('@/components/v2/confirm-sheet', () => ({
  useConfirmSheet: () => [
    { open: false, title: '', close: vi.fn() },
    vi.fn(),
  ],
  ConfirmSheet: () => null,
}))

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(ui))
  return { container, root }
}

function cleanup(container: HTMLElement, root: ReturnType<typeof createRoot>) {
  act(() => root.unmount())
  container.remove()
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await act(async () => { await sleep(10) })
  }
}

function findButton(container: HTMLElement, text: string) {
  return Array.from((container.getRootNode() as Document | ShadowRoot).querySelectorAll('button')).find(
    b => b.textContent?.trim() === text,
  )
}

function getInputByLabel(_container: HTMLElement, labelText: string) {
  const label = Array.from(document.body.querySelectorAll('label')).find(
    l => l.querySelector('span')?.textContent?.includes(labelText),
  )
  if (!label) throw new Error(`Label not found: ${labelText}`)
  const input = label.querySelector('input, select')
  if (!input) throw new Error(`Input not found for label: ${labelText}`)
  return input as HTMLInputElement | HTMLSelectElement
}

function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  Simulate.change(input, { target: { value } as any })
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  Simulate.change(select, { target: { value } as any })
}

function resourceCalls(prefix: string) {
  return mockFetch.mock.calls.filter(([path]) => String(path).startsWith(prefix))
}

function methodCalls(method: string, prefix: string) {
  return mockFetch.mock.calls.filter(
    ([path, init]) =>
      String(path).startsWith(prefix) &&
      (init?.method ?? 'GET').toUpperCase() === method.toUpperCase(),
  )
}

function lastCallBody(pathPrefix: string, method: string) {
  const call = [...mockFetch.mock.calls]
    .reverse()
    .find(([path, init]) => String(path).startsWith(pathPrefix) && (init?.method ?? 'GET').toUpperCase() === method.toUpperCase())
  if (!call) return undefined
  const init = call[1]
  if (typeof init?.body !== 'string') return undefined
  try { return JSON.parse(init.body) } catch { return undefined }
}

const SUPPLIERS = [
  {
    id: 'sup-1',
    no: 'SUP001',
    name: '昆明蔬菜批发',
    status: 'ENABLED',
    contactName: '张三',
    contactPhone: '13800138000',
    creditType: 'FIXED_DAYS',
    creditDays: 30,
    category: '蔬菜',
    createdAt: '2026-07-01T00:00:00Z',
  },
  {
    id: 'sup-2',
    no: 'SUP002',
    name: '大理水产',
    status: 'DISABLED',
    contactName: null,
    contactPhone: null,
    creditType: 'FIXED_DAYS',
    creditDays: null,
    category: null,
    createdAt: '2026-07-02T00:00:00Z',
  },
]

const SENSITIVE_SUBSTRINGS = ['银行', '账号', '密钥', 'autoPay', '付款', '对账']

describe('上游供应商管理 PC 页面', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.clear()
    localStorage.setItem('user', JSON.stringify({ id: 'supply-test' }))
    localStorage.setItem('tenant', JSON.stringify({ id: 'tenant-test' }))
  })

  it('首次加载只请求上游供应商并渲染编号、名称、状态、联系人、电话、账期', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const calls = resourceCalls('/api/suppliers')
    expect(calls.length).toBe(1)
    expect(String(calls[0][0])).toBe('/api/suppliers?businessScope=WAREHOUSE_UPSTREAM')

    expect(container.textContent).toContain('SUP001')
    expect(container.textContent).toContain('昆明蔬菜批发')
    expect(container.textContent).toContain('启用中')
    expect(container.textContent).toContain('张三')
    expect(container.textContent).toContain('13800138000')
    expect(container.textContent).toContain('30 天')

    expect(container.textContent).toContain('SUP002')
    expect(container.textContent).toContain('大理水产')
    expect(container.textContent).toContain('已停用')

    cleanup(container, root)
  })

  it('按名称搜索后本地过滤，不重新请求', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    mockFetch.mockClear()
    const keywordInput = getInputByLabel(container, '关键字') as HTMLInputElement
    act(() => { setInputValue(keywordInput, '水产') })

    await waitFor(() => !container.textContent?.includes('昆明蔬菜批发'))
    expect(container.textContent).toContain('大理水产')
    expect(resourceCalls('/api/suppliers')).toHaveLength(0)

    cleanup(container, root)
  })

  it('按状态筛选后本地过滤，不重新请求', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('大理水产') ?? false)

    mockFetch.mockClear()
    const statusSelect = getInputByLabel(container, '状态') as HTMLSelectElement
    act(() => { setSelectValue(statusSelect, 'ENABLED') })

    await waitFor(() => !container.textContent?.includes('大理水产'))
    expect(container.textContent).toContain('昆明蔬菜批发')
    expect(resourceCalls('/api/suppliers')).toHaveLength(0)

    cleanup(container, root)
  })

  it('缺失联系人与账期时展示占位符', async () => {
    mockFetch.mockResolvedValue([SUPPLIERS[1]])

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('大理水产') ?? false)

    const cells = Array.from(container.querySelectorAll('td'))
    const contactCell = cells.find(td => td.textContent?.includes('联系人') === false && td.textContent?.trim() === '—')
    expect(contactCell).toBeDefined()
    expect(container.textContent).toContain('—')

    cleanup(container, root)
  })

  it('点击列表行展示详情区，供货关系入口指向供货商品管理页', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const row = Array.from(container.querySelectorAll('tr')).find(
      tr => tr.textContent?.includes('昆明蔬菜批发'),
    )!
    act(() => { Simulate.click(row) })

    await waitFor(() => container.textContent?.includes('供应商档案'))
    expect(container.textContent).toContain('供货关系')
    const link = Array.from(container.querySelectorAll('a')).find(
      a => a.textContent?.includes('管理供货商品'),
    )
    expect(link?.getAttribute('href')).toBe(`/v2/supply-chain/suppliers/${SUPPLIERS[0].id}/products`)

    cleanup(container, root)
  })

  it('不渲染银行账号、密钥、付款等敏感字段', async () => {
    mockFetch.mockResolvedValue([
      {
        ...SUPPLIERS[0],
        bankName: '测试银行',
        bankAccount: 'TEST-FAKE-ACCOUNT-NUMBER',
        bankAccountName: '测试户名',
        bankCode: 'TEST-FAKE-CODE',
        autoPay: true,
      },
    ])

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const text = container.textContent ?? ''
    for (const term of SENSITIVE_SUBSTRINGS) {
      expect(text).not.toContain(term)
    }
    expect(text).not.toContain('6222')
    expect(text).not.toContain('测试银行')

    cleanup(container, root)
  })

  it('空列表展示空态', async () => {
    mockFetch.mockResolvedValue([])

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.querySelector('[data-empty-title]') !== null)
    expect(container.querySelector('[data-empty-title]')?.textContent).toContain('暂无总仓上游供应商')

    cleanup(container, root)
  })

  it('搜索无匹配时展示空态并提示调整筛选', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const keywordInput = getInputByLabel(container, '关键字') as HTMLInputElement
    act(() => { setInputValue(keywordInput, '不存在') })

    await waitFor(() => container.querySelector('[data-empty-title]') !== null)
    expect(container.querySelector('[data-empty-title]')?.textContent).toContain('没有匹配的上游供应商')
    expect(container.querySelector('[data-empty-hint]')?.textContent).toContain('调整筛选条件')

    cleanup(container, root)
  })

  it('加载失败展示错误态并可重试', async () => {
    let shouldFail = true
    mockFetch.mockImplementation(() => {
      if (shouldFail) return Promise.reject(new Error('network failure'))
      return Promise.resolve(SUPPLIERS)
    })

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.querySelector('[data-error-message]') !== null)
    expect(container.querySelector('[data-error-message]')?.textContent).toContain('network failure')

    shouldFail = false
    act(() => (container.querySelector('[data-retry]') as HTMLButtonElement).click())
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    expect(resourceCalls('/api/suppliers').length).toBeGreaterThanOrEqual(2)

    cleanup(container, root)
  })

  it('卸载时取消未完成的请求', async () => {
    let abortReason: string | undefined
    mockFetch.mockImplementation((_path, init) => {
      const signal = init?.signal
      if (signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          abortReason = String(signal.reason)
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    })

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => resourceCalls('/api/suppliers').length >= 1)

    cleanup(container, root)
    await sleep(30)
    expect(abortReason).toBeDefined()
  })

  it('点击新增上游供应商打开抽屉，保存后发起 POST 并刷新列表', async () => {
    const created = {
      id: 'sup-3',
      no: 'SUP003',
      name: '曲靖肉禽',
      status: 'ENABLED',
      contactName: '李四',
      contactPhone: '13900139000',
      creditType: 'FIXED_DAYS',
      creditDays: 45,
      category: '肉禽',
      createdAt: '2026-07-03T00:00:00Z',
    }
    let createdSaved = false
    mockFetch.mockImplementation((path, init) => {
      if (path === '/api/products') return Promise.resolve([{ id: 'p-valid', code: 'P-VALID', name: '有效商品', category: '测试', unit: 'kg', purchaseUnit: '箱', inventoryUnitsPerPurchaseUnit: 10, price: 30, status: 'ENABLED' }])
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && path === '/api/suppliers/create-with-products') {
        createdSaved = true
        return Promise.resolve(created)
      }
      return Promise.resolve(createdSaved ? [...SUPPLIERS, created] : SUPPLIERS)
    })

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    act(() => findButton(container, '新增上游供应商')?.click())
    await waitFor(() => document.body.textContent?.includes('新增上游供应商') ?? false)

    act(() => setInputValue(getInputByLabel(container, '编号'), 'SUP003'))
    act(() => setInputValue(getInputByLabel(container, '名称'), '曲靖肉禽'))
    act(() => setInputValue(getInputByLabel(container, '联系人'), '李四'))
    act(() => setInputValue(getInputByLabel(container, '联系电话'), '13900139000'))
    act(() => setInputValue(getInputByLabel(container, '类目'), '肉禽'))
    act(() => setInputValue(getInputByLabel(container, '账期天数'), '45'))

    await waitFor(() => document.body.textContent?.includes('P-VALID') ?? false)
    const validProduct = Array.from(document.body.querySelectorAll('label')).find(label => label.textContent?.includes('P-VALID'))?.querySelector('input') as HTMLInputElement
    act(() => validProduct.click())
    act(() => findButton(container, '保存')?.click())
    await waitFor(() => methodCalls('POST', '/api/suppliers/create-with-products').length === 1)

    const body = lastCallBody('/api/suppliers/create-with-products', 'POST').supplier
    expect(body).toMatchObject({
      no: 'SUP003',
      name: '曲靖肉禽',
      contactName: '李四',
      contactPhone: '13900139000',
      category: '肉禽',
      creditType: 'FIXED_DAYS',
      creditDays: 45,
    })
    expect(SENSITIVE_SUPPLIER_FIELDS.some(field => field in body)).toBe(false)

    await waitFor(() => container.textContent?.includes('上游供应商新增成功') ?? false)
    expect(methodCalls('GET', '/api/suppliers').length).toBeGreaterThanOrEqual(2)
    await waitFor(() =>
      Array.from(container.querySelectorAll('tr')).some(
        row => row.textContent?.includes('曲靖肉禽') && row.className.includes('bg-accent/5'),
      ),
    )

    cleanup(container, root)
  })

  it('点击编辑档案打开抽屉，保存后发起 PATCH 并刷新列表', async () => {
    const updated = { ...SUPPLIERS[0], name: '昆明蔬菜批发（新名）', creditDays: 60 }
    mockFetch.mockImplementation((path, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'PATCH' && String(path).startsWith('/api/suppliers/')) return Promise.resolve(updated)
      return Promise.resolve(SUPPLIERS)
    })

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const row = Array.from(container.querySelectorAll('tr')).find(
      tr => tr.textContent?.includes('昆明蔬菜批发'),
    )!
    act(() => { Simulate.click(row) })
    await waitFor(() => container.textContent?.includes('供应商档案') ?? false)

    act(() => findButton(container, '编辑档案')?.click())
    await waitFor(() => document.body.textContent?.includes('编辑上游供应商档案') ?? false)

    const nameInput = getInputByLabel(container, '名称') as HTMLInputElement
    expect(nameInput.value).toBe('昆明蔬菜批发')
    const noInput = getInputByLabel(container, '编号') as HTMLInputElement
    expect(noInput.readOnly).toBe(true)

    act(() => setInputValue(nameInput, '昆明蔬菜批发（新名）'))
    act(() => setInputValue(getInputByLabel(container, '账期天数'), '60'))

    act(() => findButton(container, '保存')?.click())
    await waitFor(() => methodCalls('PATCH', '/api/suppliers/').length === 1)

    const body = lastCallBody('/api/suppliers/', 'PATCH')
    expect(body).toMatchObject({ name: '昆明蔬菜批发（新名）', creditDays: 60 })
    expect(body).not.toHaveProperty('no')
    expect(SENSITIVE_SUPPLIER_FIELDS.some(field => field in body)).toBe(false)

    await waitFor(() => container.textContent?.includes('档案已更新') ?? false)

    cleanup(container, root)
  })

  it('必填校验阻断保存，不发起写入请求', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    act(() => findButton(container, '新增上游供应商')?.click())
    await waitFor(() => document.body.textContent?.includes('新增上游供应商') ?? false)

    // 清空默认账期天数，触发必填
    act(() => setInputValue(getInputByLabel(container, '账期天数'), ''))
    act(() => findButton(container, '保存')?.click())

    await sleep(50)
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    expect(document.body.textContent).toContain('请输入供应商编号')
    expect(document.body.textContent).toContain('请输入供应商名称')
    expect(document.body.textContent).toContain('请输入账期天数')

    cleanup(container, root)
  })

  it('保存失败时保留输入并展示错误', async () => {
    mockFetch.mockImplementation((path, init) => {
      if (path === '/api/products') return Promise.resolve([{ id: 'p-valid', code: 'P-VALID', name: '有效商品', category: '测试', unit: 'kg', purchaseUnit: '箱', inventoryUnitsPerPurchaseUnit: 10, price: 30, status: 'ENABLED' }])
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && path === '/api/suppliers/create-with-products') {
        return Promise.reject(Object.assign(new Error('编号已存在'), { status: 409 }))
      }
      return Promise.resolve(SUPPLIERS)
    })

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    act(() => findButton(container, '新增上游供应商')?.click())
    await waitFor(() => document.body.textContent?.includes('新增上游供应商') ?? false)

    act(() => setInputValue(getInputByLabel(container, '编号'), 'SUP003'))
    act(() => setInputValue(getInputByLabel(container, '名称'), '失败供应商'))

    await waitFor(() => document.body.textContent?.includes('P-VALID') ?? false)
    const validProduct = Array.from(document.body.querySelectorAll('label')).find(label => label.textContent?.includes('P-VALID'))?.querySelector('input') as HTMLInputElement
    act(() => validProduct.click())
    act(() => findButton(container, '保存')?.click())
    await waitFor(() => document.body.textContent?.includes('编号已存在') ?? false)

    expect((getInputByLabel(container, '编号') as HTMLInputElement).value).toBe('SUP003')
    expect((getInputByLabel(container, '名称') as HTMLInputElement).value).toBe('失败供应商')
    expect(methodCalls('POST', '/api/suppliers/create-with-products')).toHaveLength(1)

    cleanup(container, root)
  })

  it('取消新增时不发起写入请求', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    act(() => findButton(container, '新增上游供应商')?.click())
    await waitFor(() => document.body.textContent?.includes('新增上游供应商') ?? false)

    act(() => setInputValue(getInputByLabel(container, '编号'), 'SUP003'))
    act(() => setInputValue(getInputByLabel(container, '名称'), '未保存供应商'))

    act(() => findButton(container, '取消')?.click())
    await sleep(50)

    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('未保存供应商')

    cleanup(container, root)
  })

  it('新增供应商时可在同一抽屉选择商品并自动建立供货关系', async () => {
    const created = { ...SUPPLIERS[0], id: 'sup-3', no: 'SUP003', name: '新供应商' }
    const product = { id: 'p-1', code: 'P001', name: '土豆', category: '蔬菜', spec: '500g', unit: 'kg', purchaseUnit: '箱', inventoryUnit: 'kg', inventoryUnitsPerPurchaseUnit: 10, price: 30, status: 'ENABLED' }
    mockFetch.mockImplementation((path, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (path === '/api/products') return Promise.resolve([product])
      if (method === 'POST' && path === '/api/suppliers/create-with-products') return Promise.resolve(created)
      if (method === 'POST' && path === '/api/suppliers/sup-3/upstream-products') return Promise.resolve({ boundCount: 1 })
      return Promise.resolve(SUPPLIERS)
    })
    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)
    act(() => findButton(container, '新增上游供应商')?.click())
    await waitFor(() => document.body.textContent?.includes('全选分类：蔬菜（1）') ?? false)

    act(() => setInputValue(getInputByLabel(container, '编号'), 'SUP003'))
    act(() => setInputValue(getInputByLabel(container, '名称'), '新供应商'))
    const productCheckbox = Array.from(document.body.querySelectorAll('label')).find(label => label.textContent?.includes('P001'))?.querySelector('input') as HTMLInputElement
    act(() => productCheckbox.click())
    act(() => findButton(container, '保存')?.click())

    await waitFor(() => methodCalls('POST', '/api/suppliers/create-with-products').length === 1)
    expect(lastCallBody('/api/suppliers/create-with-products', 'POST')).toMatchObject({ items: [{ productId: 'p-1', purchaseUnit: '箱', inventoryUnitsPerPurchaseUnit: 10, quotedUnitPrice: 30, isPrimary: false }] })
    await waitFor(() => container.textContent?.includes('已绑定 1 个供货商品') ?? false)
    expect(container.textContent).toContain('已绑定 1 个供货商品')
    cleanup(container, root)
  })
  it('未选商品或缺换算时保留表单，不创建半完成供应商', async () => {
    mockFetch.mockImplementation(path => Promise.resolve(path === '/api/products'
      ? [{ id: 'p-missing', code: 'P-MISSING', name: '缺换算商品', category: '测试', unit: '箱', purchaseUnit: '箱', inventoryUnitsPerPurchaseUnit: null, price: 30, status: 'ENABLED' }]
      : SUPPLIERS))
    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)
    act(() => findButton(container, '新增上游供应商')?.click())
    await waitFor(() => document.body.textContent?.includes('P-MISSING') ?? false)
    act(() => setInputValue(getInputByLabel(container, '编号'), 'SUP-GUARD'))
    act(() => setInputValue(getInputByLabel(container, '名称'), '校验供应商'))
    act(() => findButton(container, '保存')?.click())
    expect(document.body.textContent).toContain('必须至少选择一个供货商品')
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    const product = Array.from(document.body.querySelectorAll('label')).find(label => label.textContent?.includes('P-MISSING'))?.querySelector('input') as HTMLInputElement
    act(() => product.click())
    act(() => findButton(container, '保存')?.click())
    expect(document.body.textContent).toContain('请先补齐 缺换算商品')
    expect(getInputByLabel(container, '名称').value).toBe('校验供应商')
    expect(product.checked).toBe(true)
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    cleanup(container, root)
  })

  it('网络结果未知后刷新恢复同账号原请求，不重复生成请求编号', async () => {
    let attempts = 0
    const product = { id: 'p-replay', code: 'P-REPLAY', name: '重放商品', category: '测试', unit: 'kg', purchaseUnit: '箱', inventoryUnitsPerPurchaseUnit: 10, price: 30, status: 'ENABLED' }
    mockFetch.mockImplementation((path, init) => {
      if (path === '/api/products') return Promise.resolve([product])
      if (init?.method === 'POST') return ++attempts === 1
        ? Promise.reject(new Error('网络结果未知'))
        : Promise.resolve({ ...SUPPLIERS[0], id: 'created-replay', no: 'SUP-REPLAY' })
      return Promise.resolve(SUPPLIERS)
    })
    let view = render(<SuppliersPage />)
    await waitFor(() => view.container.textContent?.includes('昆明蔬菜批发') ?? false)
    act(() => findButton(view.container, '新增上游供应商')?.click())
    await waitFor(() => document.body.textContent?.includes('P-REPLAY') ?? false)
    act(() => setInputValue(getInputByLabel(view.container, '编号'), 'SUP-REPLAY'))
    act(() => setInputValue(getInputByLabel(view.container, '名称'), '恢复原请求'))
    const productBox = Array.from(document.body.querySelectorAll('label')).find(label => label.textContent?.includes('P-REPLAY'))?.querySelector('input') as HTMLInputElement
    act(() => productBox.click())
    act(() => findButton(view.container, '保存')?.click())
    await waitFor(() => document.body.textContent?.includes('网络结果未知') ?? false)
    const first = lastCallBody('/api/suppliers/create-with-products', 'POST')
    expect(getInputByLabel(view.container, '名称').matches(':disabled')).toBe(true)
    cleanup(view.container, view.root)
    view = render(<SuppliersPage />)
    await waitFor(() => view.container.textContent?.includes('昆明蔬菜批发') ?? false)
    act(() => findButton(view.container, '新增上游供应商')?.click())
    await waitFor(() => document.body.textContent?.includes('上次创建结果待确认') ?? false)
    expect(getInputByLabel(view.container, '名称').value).toBe('恢复原请求')
    act(() => findButton(view.container, '保存')?.click())
    await waitFor(() => view.container.textContent?.includes('已绑定 1 个供货商品') ?? false)
    expect(lastCallBody('/api/suppliers/create-with-products', 'POST')).toEqual(first)
    expect(Object.keys(localStorage).some(key => key.startsWith('dj:supplier-create:'))).toBe(false)
    cleanup(view.container, view.root)
  })

  it('迟到的建议编号不覆盖手工填写', async () => {
    let resolveNumber!: (value: { no: string }) => void
    mockFetch.mockImplementation(path => path === '/api/suppliers/next-number'
      ? new Promise(resolve => { resolveNumber = resolve })
      : Promise.resolve(path === '/api/products' ? [] : SUPPLIERS))
    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)
    act(() => findButton(container, '新增上游供应商')?.click())
    act(() => setInputValue(getInputByLabel(container, '编号'), 'MANUAL-SUP'))
    await act(async () => resolveNumber({ no: 'SUP777' }))
    expect(getInputByLabel(container, '编号').value).toBe('MANUAL-SUP')
    cleanup(container, root)
  })

})
