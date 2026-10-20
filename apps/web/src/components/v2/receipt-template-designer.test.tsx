// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {describe,it,expect} from 'vitest'
import {ReceiptTemplateGrid} from './receipt-template-designer'
import {DEFAULT_RECEIPT_TEMPLATE,resizeReceiptGrid} from '@/lib/receipt-print-template'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
describe('safe receipt header grid rendering',()=>{
 it('renders text and bindings as div grid, never another detail table or HTML injection',()=>{
  const template=resizeReceiptGrid(DEFAULT_RECEIPT_TEMPLATE,1,2);template.grid.cells[0]=[{text:'供应商：',field:'supplier'},{text:'<img src=x onerror=alert(1)>',field:''}]
  const container=document.createElement('div'),root=createRoot(container)
  act(()=>root.render(<ReceiptTemplateGrid template={template} fields={{supplier:'甲公司'}}/>))
  expect(container.textContent).toContain('供应商：甲公司');expect(container.textContent).toContain('<img src=x onerror=alert(1)>');expect(container.querySelector('table,thead,tbody,img,script')).toBeNull();expect(container.querySelector('[data-receipt-template-grid]')).not.toBeNull()
  act(()=>root.unmount())
 })
 it('shows the default three-row header without opening editing controls',()=>{
  const container=document.createElement('div'),root=createRoot(container)
  act(()=>root.render(<ReceiptTemplateGrid template={DEFAULT_RECEIPT_TEMPLATE} fields={{}}/>));expect(container.textContent).toContain('单据编号');expect(container.textContent).toContain('供应商');expect(container.querySelector('input,select,button,table')).toBeNull();act(()=>root.unmount())
 })
})
