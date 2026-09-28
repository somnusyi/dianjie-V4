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
  beforeEach(() => { mockFetch.mockReset() })

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
})
