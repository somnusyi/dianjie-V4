// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ReportActions, TableReportHost } from './report-actions'
import { showTableReport } from '@/lib/table-report'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
it('打印先加载完整明细供预览，系统打印仅由用户按钮调用且可关闭', async () => {
  const print = vi.spyOn(window, 'print').mockImplementation(() => {})
  const rootEl = document.createElement('div'); document.body.appendChild(rootEl); const root = createRoot(rootEl)
  const load = vi.fn(async () => ({ title: '采购合同-C001', headers: ['商品', '金额'], rows: [['牛肝菌', 125]] }))
  act(() => root.render(<><ReportActions printOnly loadReport={load} /><TableReportHost /></>))
  await act(async () => (rootEl.querySelector('button') as HTMLButtonElement).click())
  expect(load).toHaveBeenCalledTimes(1); expect(rootEl.querySelector('[role="dialog"]')?.textContent).toContain('牛肝菌'); expect(print).not.toHaveBeenCalled()
  act(() => Array.from(rootEl.querySelectorAll('button')).find(button => button.textContent === '保存 PDF')!.click())
  expect(print).toHaveBeenCalledTimes(1)
  act(() => Array.from(rootEl.querySelectorAll('button')).find(button => button.textContent === '关闭预览')!.click())
  expect(rootEl.querySelector('[role="dialog"]')).toBeNull()
  act(() => root.unmount()); rootEl.remove(); showTableReport(null); print.mockRestore()
})
