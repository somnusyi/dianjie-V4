// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Page from './page'
import { apiFetch } from '@/lib/v2-auth'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
vi.mock('../_topnav',()=>({default:()=>null}))
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('@/lib/ui-dialogs',()=>({confirmDialog:vi.fn()}))
const first=Array.from({length:200},(_,i)=>({id:`statement-${i}`,no:`UST-SCALE-${i}`,status:'SENT_TO_SUPPLIER',periodStart:'2026-10-01',periodEnd:'2026-10-31',receiptAmount:'0',deductionAmount:'0',payableAmount:'13.01',version:i+1,supplier:{id:'s',no:'A',name:'云岭食材'},_count:{lines:1,invoiceAllocations:0}}))
let root:ReturnType<typeof createRoot>,host:HTMLDivElement
async function render(){host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);await act(async()=>root.render(<Page/>))}
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML='';vi.resetAllMocks()})
describe('财务上游对账完整汇总',()=>{
 it('第二页完成前不展示半份统计，完成后可搜索第201条并精确保留四位金额',async()=>{
  let resolve!:(value:any)=>void;const later=new Promise(a=>{resolve=a})
  vi.mocked(apiFetch).mockResolvedValueOnce(first as any).mockReturnValueOnce(later as any)
  await render()
  expect(host.querySelector('section')?.textContent).toBe('待财务锁定—待锁定应付—已锁定/已开票—')
  expect(host.textContent).not.toContain('UST-SCALE-')
  await act(async()=>resolve([{...first[0],id:'old-confirmed',no:'UST-OLD001',status:'CONFIRMED',payableAmount:'211.2278'}]))
  expect(host.querySelector('section')?.textContent).toContain('待财务锁定1 单待锁定应付¥211.2278')
  expect(host.querySelectorAll('tbody tr')).toHaveLength(201)
  await act(async()=>{const input=host.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'UST-OLD001');input.dispatchEvent(new Event('input',{bubbles:true}))})
  expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
  expect(host.querySelector('tbody')?.textContent).toContain('UST-OLD001')
 })
 it('第二页失败明确报错且汇总为未知，重试真实空列表才显示0',async()=>{
  vi.mocked(apiFetch).mockResolvedValueOnce(first as any).mockRejectedValueOnce(new Error('第二页读取失败'))
  await render()
  expect(host.textContent).toContain('第二页读取失败');expect(host.textContent).toContain('加载失败，请刷新重试')
  expect(host.querySelector('section')?.textContent).not.toContain('0 单')
  const refresh=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='刷新')!
  expect(refresh.disabled).toBe(false)
  vi.mocked(apiFetch).mockResolvedValueOnce([])
  await act(async()=>refresh.click())
  expect(host.querySelector('section')?.textContent).toContain('待财务锁定0 单')
  expect(host.textContent).toContain('暂无上游采购对账单')
 })
})
