// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SupplierEvidencePage from './page'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from '@/components/v2/supply-chain-shell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'supplier-1' }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/ui-dialogs', () => ({ confirmDialog: vi.fn(), promptDialog: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'
import { confirmDialog, promptDialog } from '@/lib/ui-dialogs'

const mockFetch = vi.mocked(apiFetch)
const mockConfirm = vi.mocked(confirmDialog)
const mockPrompt = vi.mocked(promptDialog)
const product = { id: 'product-1', code: 'P001', name: '牛肉', evidenceRequirement: 'PENDING', requiredEvidenceTypes: [], evidenceRequirementVersion: 0 }

function installFetch() {
  mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.includes('/evidence-documents') && !options?.method) return { supplier: { id: 'supplier-1', no: 'S001', name: '测试供应商' }, permissions: { canManage: true }, items: [] } as any
    if (url.includes('/upstream-products')) return { items: [{ product }] } as any
    if (url.includes('/evidence-requirements/') && options?.method === 'PATCH') return { evidenceRequirement: 'REQUIRED', requiredEvidenceTypes: ['SLAUGHTER_CERTIFICATE', 'THIRD_PARTY_TEST_REPORT', 'QUARANTINE_CERTIFICATE'], evidenceRequirementVersion: 1 } as any
    throw new Error(`unexpected fetch ${url}`)
  })
}

async function waitFor(assertion: () => void) {
  for (let index = 0; index < 40; index += 1) {
    try { assertion(); return } catch { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
  }
  assertion()
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<SupplierEvidencePage />))
  return { container, root }
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string | boolean) {
  act(() => {
    if (element instanceof HTMLInputElement && element.type === 'checkbox') {
      if (element.checked !== Boolean(value)) element.click()
      return
    }
    else element.value = String(value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('商品随货资料规则编辑', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfirm.mockResolvedValue(true)
    mockPrompt.mockResolvedValue('牛肉到货需三类资料')
    installFetch()
  })

  it('选必须提供并勾选3类后只确认、填原因和PATCH一次', async () => {
    const { container, root } = renderPage()
    await waitFor(() => expect(container.textContent).toContain('商品随货资料规则'))
    change(container.querySelector('select[aria-label="牛肉资料规则"]') as HTMLSelectElement, 'REQUIRED')
    for (const label of ['牛肉-检疫证明', '牛肉-屠宰证', '牛肉-第三方检测报告']) change(container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement, true)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存规则')?.click())
    await waitFor(() => expect(mockFetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1))
    const patchCall = mockFetch.mock.calls.find(([, options]) => options?.method === 'PATCH')!
    expect(JSON.parse(String(patchCall[1]?.body))).toMatchObject({ status: 'REQUIRED', requiredTypes: ['QUARANTINE_CERTIFICATE', 'SLAUGHTER_CERTIFICATE', 'THIRD_PARTY_TEST_REPORT'] })
    expect(mockConfirm).toHaveBeenCalledTimes(1)
    expect(mockPrompt).toHaveBeenCalledTimes(1)
    act(() => root.unmount()); container.remove()
  })

  it('必须提供未勾类型时不能保存', async () => {
    const { container, root } = renderPage()
    await waitFor(() => expect(container.textContent).toContain('商品随货资料规则'))
    change(container.querySelector('select[aria-label="牛肉资料规则"]') as HTMLSelectElement, 'REQUIRED')
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存规则')?.click())
    expect(container.textContent).toContain('请至少勾选一种所需随货资料')
    expect(mockFetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(0)
    act(() => root.unmount()); container.remove()
  })

  it('取消站内离开后保留未保存规则草稿', async () => {
    mockConfirm.mockResolvedValue(false)
    const { container, root } = renderPage()
    await waitFor(() => expect(container.textContent).toContain('商品随货资料规则'))
    change(container.querySelector('select[aria-label="牛肉资料规则"]') as HTMLSelectElement, 'REQUIRED')
    const checkbox = container.querySelector('input[aria-label="牛肉-屠宰证"]') as HTMLInputElement
    change(checkbox, true)
    const event = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true })
    let allowed = true
    act(() => { allowed = window.dispatchEvent(event) })
    expect(allowed).toBe(false)
    expect(checkbox.checked).toBe(true)
    expect(mockConfirm).toHaveBeenCalledTimes(1)
    act(() => root.unmount()); container.remove()
  })
})
