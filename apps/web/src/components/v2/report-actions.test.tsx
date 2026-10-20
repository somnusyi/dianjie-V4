// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {TableReportHost} from './report-actions'
import {showTableReport} from '@/lib/table-report'
import {procurementDocumentReport} from '@/lib/procurement-document-report'
vi.mock('@/lib/v2-auth',()=>({getUser:()=>({id:'template-test'})}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
let root:ReturnType<typeof createRoot>|undefined
afterEach(()=>{act(()=>{root?.unmount();showTableReport(null)});root=undefined;document.body.innerHTML='';localStorage.clear();vi.restoreAllMocks()})
it('opens a usable default receiving document, with editor hidden and real bound fields and totals',()=>{
 const container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
 act(()=>{showTableReport(procurementDocumentReport('RECEIPT',{no:'RC-SAMPLE',createdAt:'2026-10-18T00:00:00Z',supplier:{name:'供应商甲'},warehouse:{name:'总仓'},organizationName:'总部',note:'本批备注',lines:[{product:{code:'A01',name:'样品',spec:'1kg/袋'},purchaseUnit:'袋',acceptedQty:3,unitPrice:'33.333333',payableAmount:100}]}));root!.render(<TableReportHost/>)})
 expect(container.querySelector('[aria-label="采购入库单打印模板设计器"]')).toBeNull()
 expect(container.querySelector('[data-receipt-template-grid]')?.textContent).toContain('RC-SAMPLE')
 expect(container.querySelector('[data-receipt-template-grid]')?.textContent).toContain('供应商甲')
 expect(container.querySelector('[data-receipt-template-grid]')?.textContent).toContain('本批备注')
 expect(container.querySelectorAll('table')).toHaveLength(1)
 const previewPaper=container.querySelector('[data-receipt-paper]') as HTMLElement
 expect(previewPaper.style.width).toBe('210mm')
 expect(previewPaper.style.minHeight).toBe('297mm')
 expect(container.querySelector('[data-receipt-letterhead]')?.textContent).toContain('总部')
 expect(container.querySelectorAll('thead th')).toHaveLength(7)
 expect(container.querySelector('thead')?.textContent).not.toContain('批次号')
 expect(container.querySelector('tfoot')?.textContent).toContain('100')
 expect(container.querySelectorAll('[data-receipt-signature]')).toHaveLength(1)
 expect(container.querySelector('tfoot')?.textContent).toContain('收货人签字 / 日期')
 expect(container.querySelector('tfoot')?.textContent).not.toMatch(/制单|审核|复审/)
 expect((container.querySelector('#print-report-host') as HTMLElement).style.fontFamily).toContain('PingFang SC')
 vi.spyOn(window,'print').mockImplementation(()=>{})
 const print=Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='打印')!
 act(()=>print.click())
 const paper=document.querySelector('[data-table-print-document]') as HTMLElement
 expect(paper.style.getPropertyValue('font-family')).toContain('PingFang SC')
 expect(paper.style.getPropertyPriority('font-family')).toBe('important')
 expect(paper.querySelectorAll('[data-receipt-signature]')).toHaveLength(1)
 expect(paper.querySelector('tfoot')?.textContent).not.toMatch(/制单|审核|复审/)
 act(()=>window.dispatchEvent(new Event('afterprint')))
 const edit=Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='编辑模板')!
 act(()=>edit.click());expect(container.querySelector('[aria-label="采购入库单打印模板设计器"]')).not.toBeNull()
})
