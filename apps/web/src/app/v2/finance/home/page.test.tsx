// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import Page from './page'
import { apiFetch } from '@/lib/v2-auth'
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/invoice-list', () => ({ loadInvoices: vi.fn(async () => []) }))
vi.mock('@/components/v2', () => ({ BottomNav: () => null, StoreAvatar: () => null, Chip: ({ children }: any) => <span>{children}</span> }))
vi.mock('@/components/v2/glance-strip', () => ({ GlanceStrip: () => null }))
vi.mock('@/components/v2/sparkline', () => ({ Sparkline: () => null }))
vi.mock('@/components/v2/user-menu', () => ({ UserMenu: () => null }))
vi.mock('@/components/v2/use-dashboard', () => ({ useDashboard: () => ({ data: { user: { name: '财务经办' }, hero: {} }, error: null }), greetingFor: () => ({ greeting: '早上好', today: '10/22' }), LoadingScreen: () => null, ErrorScreen: () => null }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
function schedule(status: string, amount: string) { return { id: status, amount, dueAt: '2026-10-20T00:00:00Z', status, supplier: { name: '青禾食材' }, receipt: { no: `RK-${status}`, store: { name: '清源一店' } } } }
async function render(rows: any[]) {
  vi.mocked(apiFetch).mockImplementation(async url => {
    if (url === '/api/schedules?days=1') return rows as any
    if (String(url).includes('/api/finance/reports/')) return null as any
    return [] as any
  })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); await act(async () => root.render(<Page />))
  return { host, root }
}
it('keeps unpaid and overdue rows while removing paid and non-payable history', async () => {
  const { host, root } = await render([
    schedule('PENDING', '1'), schedule('APPROVED', '2'), schedule('NOTIFIED', '3'), schedule('OVERDUE', '4'),
    schedule('PAID', '524'), schedule('CANCELLED', '777'), schedule('ON_HOLD', '888'), schedule('PROCESSING', '999'), schedule('REJECTED', '111'),
  ])
  try {
    const section = Array.from(host.querySelectorAll('section')).find(x => x.textContent?.includes('今日 + 逾期应付'))!
    expect(section.textContent).toContain('4 笔 · ¥10')
    for (const status of ['PENDING', 'APPROVED', 'NOTIFIED', 'OVERDUE']) expect(section.textContent).toContain(`RK-${status}`)
    for (const status of ['PAID', 'CANCELLED', 'ON_HOLD', 'PROCESSING', 'REJECTED']) expect(section.textContent).not.toContain(`RK-${status}`)
  } finally { await act(async () => root.unmount()); host.remove() }
})
it('an entirely paid history does not appear as a new due-payment section', async () => {
  const { host, root } = await render([schedule('PAID', '523.99')])
  try {
    expect(host.textContent).not.toContain('今日 + 逾期应付')
    expect(host.textContent).not.toContain('RK-PAID')
  } finally { await act(async () => root.unmount()); host.remove() }
})
