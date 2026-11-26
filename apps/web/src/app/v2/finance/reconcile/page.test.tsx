// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from './page'
import { apiFetch } from '@/lib/v2-auth'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('next/navigation',()=>({useRouter:()=>({back:vi.fn()})}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>}))
const rows=(v:number)=>[{storeId:'s',name:'春城门店',no:'001',revenue:0,foodCost:v,loss:0,net:-v}]
function deferred(){let resolve!:(v:any)=>void;let reject!:(v:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
let host:HTMLDivElement,root:ReturnType<typeof createRoot>
let downloads:Array<{name:string;blob:Blob}>,currentBlob:Blob
async function render(){host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);await act(async()=>root.render(<Page/>))}
function exportButton(){return Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='⬇ 导出 CSV')!}
async function previous(){await act(async()=>{const select=host.querySelector('select')!;select.value=select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}))})}
beforeEach(()=>{
 vi.mocked(apiFetch).mockReset();downloads=[]
 Object.defineProperty(URL,'createObjectURL',{configurable:true,writable:true,value:vi.fn((blob)=>{currentBlob=blob;return 'blob:report'})})
 Object.defineProperty(URL,'revokeObjectURL',{configurable:true,writable:true,value:vi.fn()})
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){downloads.push({name:this.download,blob:currentBlob})})
})
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML='';vi.restoreAllMocks()})
describe('手机月度对账数据归属',()=>{
 it('切月加载时隐藏旧值，禁止导出；新CSV与所选月份一致',async()=>{
  const fresh=deferred();vi.mocked(apiFetch).mockResolvedValueOnce(rows(111) as any).mockReturnValue(fresh.promise)
  await render();await previous()
  expect(exportButton().disabled).toBe(true);expect(host.textContent).not.toContain('¥111')
  await act(async()=>fresh.resolve(rows(444.27)))
  await act(async()=>exportButton().click())
  expect(downloads).toHaveLength(1)
  expect(downloads[0].name).toBe(`门店对账-${host.querySelector('select')!.value}.csv`)
  const content=await new Promise<string>(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.readAsText(downloads[0].blob)})
  expect(content).toContain('444.27');expect(content).not.toContain('111.00')
 })
 it.each(['resolve','reject'] as const)('旧月份晚到%s不能覆盖新月份',async kind=>{
  const old=deferred();vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockResolvedValue(rows(444) as any)
  await render();await previous()
  await act(async()=>kind==='resolve'?old.resolve(rows(111)):old.reject(new Error('旧月失败')))
  expect(host.textContent).toContain('¥444');expect(host.textContent).not.toContain('¥111');expect(host.textContent).not.toContain('旧月失败')
 })
 it('当前月份读取失败后不能导出旧月份记录',async()=>{
  vi.mocked(apiFetch).mockResolvedValueOnce(rows(111) as any).mockRejectedValue(new Error('当前账目加载失败'))
  await render();await previous();await act(async()=>exportButton().click())
  expect(exportButton().disabled).toBe(true);expect(downloads).toHaveLength(0);expect(host.textContent).toContain('当前账目加载失败')
 })
})

it('mobile monthly amounts keep cents instead of rounded integers or ten-thousand abbreviations',async()=>{
 vi.mocked(apiFetch).mockResolvedValue([{storeId:'s',name:'清源一店',no:'M001',revenue:12345.67,foodCost:12369.38,loss:0,net:-23.71}] as any)
 await render()
 for(const amount of ['¥12,345.67','¥12,369.38','¥-23.71'])expect(host.textContent).toContain(amount)
 expect(host.textContent).not.toContain('万')
})
