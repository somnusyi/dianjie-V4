// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  BottomNav: () => <nav data-testid="bottom-nav" />,
  StoreAvatar: ({ name }: { name: string }) => <span>{name}</span>,
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))
vi.mock('@/components/v2/glance-strip', () => ({ GlanceStrip: () => <div data-testid="glance-strip" /> }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'
import ChefDirectorLossPage from './page'

const mockFetch = vi.mocked(apiFetch)
const claims = [
  { id: 'pending', no: 'BS-PENDING', totalLossAmount: 50, description: '待供应商处理', status: 'PENDING', createdAt: '2026-09-28T08:00:00.000Z', store: { name: '一店' }, items: [] },
  { id: 'large', no: 'BS-LARGE', totalLossAmount: 250, description: '已处理大额', status: 'RESOLVED', createdAt: '2026-09-27T08:00:00.000Z', store: { name: '二店' }, items: [] },
  { id: 'normal', no: 'BS-NORMAL', totalLossAmount: 20, description: '普通已处理', status: 'APPROVED', createdAt: '2026-09-26T08:00:00.000Z', store: { name: '三店' }, items: [] },
]

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('总厨报损单列表筛选', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ items: claims, total: claims.length })
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('只渲染一份明细，并用待督导/大额筛选原列表', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<ChefDirectorLossPage />))
    await waitFor(() => container.textContent?.includes('BS-NORMAL') ?? false)

    expect(container.textContent).not.toContain('待督导报损')
    expect(container.textContent).toContain('BS-PENDING')
    expect(container.textContent).toContain('BS-LARGE')
    expect(container.textContent).toContain('BS-NORMAL')

    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '待督导 / 大额')?.click())
    expect(container.textContent).toContain('BS-PENDING')
    expect(container.textContent).toContain('BS-LARGE')
    expect(container.textContent).not.toContain('BS-NORMAL')

    act(() => root.unmount())
  })
})
