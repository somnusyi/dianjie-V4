// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SupplierArchivePage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'supplier-1' }) }))
vi.mock('@/components/v2', () => ({ Chip: ({ children }: any) => <span>{children}</span> }))
vi.mock('@/components/v2/confirm-sheet', () => ({
  useConfirmSheet: () => [{ open: false }, vi.fn()],
  ConfirmSheet: () => null,
}))
vi.mock('@/components/v2/skeleton', () => ({
  SkeletonList: () => <div>加载中</div>,
  EmptyState: ({ title, hint }: any) => <div>{title}{hint}</div>,
  FriendlyError: ({ message }: any) => <div>{message}</div>,
}))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'
const mockFetch = vi.mocked(apiFetch)

async function waitFor(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('供应商集中档案页', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    sessionStorage.clear()
    localStorage.setItem('user', JSON.stringify({ id: 'qa-user' }))
    localStorage.setItem('tenant', JSON.stringify({ id: 'qa-tenant' }))
  })

  it('按四分区展示，合同复用现有合同，供应链不渲染敏感内容', async () => {
    mockFetch.mockResolvedValue({
      supplier: { id: 'supplier-1', no: 'SUP027', name: '云南世通', status: 'ENABLED', contactName: '张三', contactPhone: '13800138000', address: '昆明市', creditType: 'MONTHLY' },
      permissions: { canManageGeneral: true, canViewSensitive: false, canManageSensitive: false },
      sections: {
        qualifications: { restricted: false, count: 1, records: [{ id: 'q1', section: 'QUALIFICATION', title: '营业执照', createdAt: '2026-09-28T00:00:00Z' }] },
        contracts: { restricted: false, count: 1, source: 'UpstreamSupplierContract', records: [{ id: 'c1', contractNo: 'HT001', version: 1, title: '年度合同', startsAt: '2026-01-01', endsAt: null, status: 'ACTIVE', attachmentCount: 1 }] },
        finance: { restricted: true, count: null },
        invoice: { restricted: true, count: null },
      },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<SupplierArchivePage />))
    await waitFor(() => container.textContent?.includes('云南世通') ?? false)
    const text = container.textContent || ''
    expect(text).toContain('企业资质')
    expect(text).toContain('供应商合同')
    expect(text).toContain('财务信息')
    expect(text).toContain('开票资料')
    expect(text).toContain('年度合同')
    expect(text).toContain('直接复用采购中的合同真相')
    expect(text).toContain('每次来货检疫证明在到货单独关联')
    expect(text).toContain('内容已受保护')
    expect(text).not.toContain('FAKE-ACCOUNT')
    expect(mockFetch).toHaveBeenCalledWith('/api/suppliers/supplier-1/archive')
    act(() => root.unmount())
    container.remove()
  })

  it('响应丢失后重放同一请求及附件，同步重复点击只写一次', async () => {
    const fixture = {
      supplier: { id: 'supplier-1', no: 'SUP001', name: '测试档案', status: 'ENABLED' },
      permissions: { canManageGeneral: true, canViewSensitive: false, canManageSensitive: false },
      sections: { qualifications: { restricted: false, count: 0, records: [] }, contracts: { restricted: false, count: 0, records: [] }, finance: { restricted: true, count: null }, invoice: { restricted: true, count: null } },
    }
    const writes: string[] = []
    let uploads = 0
    mockFetch.mockImplementation(async (url, options) => {
      if (String(url).startsWith('/api/upload')) {
        uploads++
        return { key: 'supplier-archive-general/t/a.png', name: '模拟附件.png', mime: 'image/png', size: 10 } as any
      }
      if (options?.method === 'POST') {
        writes.push(String(options.body))
        if (writes.length === 1) throw Object.assign(new Error('response lost'), { status: 503 })
        return { id: 'record-1', duplicated: true } as any
      }
      return fixture as any
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<SupplierArchivePage />))
    await waitFor(() => container.textContent?.includes('测试档案') ?? false)
    const button = (name: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === name)!
    act(() => button('+新增条目').click())
    const input = container.querySelector('input:not([type])') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '营业执照测试')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const fileInput = container.querySelector('input[type="file"]')!
      Object.defineProperty(fileInput, 'files', { value: [new File(['test'], '模拟附件.png', { type: 'image/png' })] })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { button('保存').click(); button('保存').click() })
    await waitFor(() => container.textContent?.includes('保存结果待确认') ?? false)
    expect(writes).toHaveLength(1)
    expect(input.matches(':disabled')).toBe(true)
    act(() => button('取消').click())
    expect(container.textContent).toContain('请重试原请求后再关闭')
    act(() => root.unmount())
    const recoveredRoot = createRoot(container)
    act(() => recoveredRoot.render(<SupplierArchivePage />))
    await waitFor(() => container.textContent?.includes('已恢复上次待确认请求') ?? false)
    await act(async () => button('重试原请求').click())
    await waitFor(() => container.textContent?.includes('档案条目已新增') ?? false)
    expect(uploads).toBe(1)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe(writes[0])
    expect(sessionStorage.length).toBe(0)
    act(() => recoveredRoot.unmount())
    container.remove()
  })

})
