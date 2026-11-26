// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from './page'
import { apiFetch } from '@/lib/v2-auth'
import { exportXlsx } from '@/lib/exportXlsx'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('@/lib/exportXlsx',()=>({exportXlsx:vi.fn().mockResolvedValue(undefined)}))
vi.mock('../_topnav',()=>({default:()=>null}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>,MonthPicker:({value,onChange}:any)=><input aria-label="月份" value={value} onChange={e=>onChange(e.target.value)}/>}))
const store=(value:number)=>[{storeId:'s',name:'春城门店',no:'001',revenue:0,foodCost:value,loss:0,net:-value}]
const supplier=(value:number)=>[{supplierId:'p',name:'云岭供应商',delivered:value,paid:0,unpaid:0,loss:0}]
const deferred=()=>{let resolve!:(v:any)=>void;let reject!:(e:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
let root:ReturnType<typeof createRoot>,host:HTMLDivElement
async function render(){host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);await act(async()=>root.render(<Page/>))}
function button(text:string){return Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text)!}
async function click(text:string){await act(async()=>button(text).click())}
async function month(value:string){await act(async()=>{const input=host.querySelector('input[aria-label="月份"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
beforeEach(()=>{history.replaceState(null,'','/?month=2026-10');vi.mocked(apiFetch).mockReset();vi.mocked(exportXlsx).mockClear();vi.mocked(apiFetch).mockImplementation(async path=>{const u=new URL(String(path),'http://localhost');return (u.searchParams.get('view')==='store'?store(u.searchParams.get('month')==='2026-10'?111:444):supplier(u.searchParams.get('month')==='2026-10'?222:333)) as any})})
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML='';vi.restoreAllMocks()})
describe('财务月度对账导出',()=>{
 it('跨月双表导出读取同一月份的两份数据',async()=>{
  await render();await click('按供应商');await month('2026-09');await click('📊 Excel')
  expect(exportXlsx).toHaveBeenCalledTimes(1)
  const [filename,sheets]=vi.mocked(exportXlsx).mock.calls[0]
  expect(filename).toBe('月度对账-2026-09.xlsx')
  expect(sheets.map(x=>x.name)).toEqual(['门店对账 2026-09','供应商对账 2026-09'])
  expect(sheets[0].rows[3][3]).toBe(444);expect(sheets[1].rows[3][1]).toBe(333)
  expect(JSON.stringify(sheets)).not.toContain('111');expect(JSON.stringify(sheets)).not.toContain('222')
 })
 it('新月份加载期间不展示旧金额且禁用两种导出',async()=>{
  await render();const pending=deferred();vi.mocked(apiFetch).mockReturnValue(pending.promise)
  await month('2026-09')
  expect(button('📊 Excel').disabled).toBe(true);expect(button('⬇ CSV').disabled).toBe(true)
  expect(host.textContent).not.toContain('¥111')
  await act(async()=>pending.resolve(store(444)))
  expect(button('📊 Excel').disabled).toBe(false);expect(host.textContent).toContain('¥444')
 })
 it.each(['resolve','reject'] as const)('旧月份晚到的%s不能覆盖新月份或错误状态',async kind=>{
  const old=deferred();vi.mocked(apiFetch).mockImplementation(path=>String(path).includes('2026-10')?old.promise:Promise.resolve(store(444)) as any)
  await render();await month('2026-09')
  await act(async()=>kind==='resolve'?old.resolve(store(111)):old.reject(new Error('旧月份失败')))
  expect(host.textContent).toContain('¥444');expect(host.textContent).not.toContain('¥111');expect(host.textContent).not.toContain('旧月份失败')
  expect(button('📊 Excel').disabled).toBe(false)
 })
 it('双表取数失败不下载，重试可恢复，双击只下载一次',async()=>{
  await render();vi.mocked(apiFetch).mockImplementation(path=>String(path).includes('view=supplier')?Promise.reject(new Error('供应商对账暂不可用')):Promise.resolve(store(111)) as any)
  await click('📊 Excel');expect(exportXlsx).not.toHaveBeenCalled();expect(host.textContent).toContain('供应商对账暂不可用')
  const pending=deferred();vi.mocked(apiFetch).mockImplementation(path=>String(path).includes('view=supplier')?pending.promise:Promise.resolve(store(111)) as any)
  await act(async()=>{button('📊 Excel').click();button('📊 Excel').click()})
  expect(vi.mocked(apiFetch).mock.calls.filter(([p])=>String(p).includes('view=supplier'))).toHaveLength(2)
  await act(async()=>pending.resolve(supplier(222)))
  expect(exportXlsx).toHaveBeenCalledTimes(1);expect(button('📊 Excel').disabled).toBe(false)
 })
 it('生成文件失败后恢复控件并允许重试，导出期间锁月份和视角',async()=>{
  await render();const download=deferred();vi.mocked(exportXlsx).mockReturnValueOnce(download.promise)
  await click('📊 Excel')
  expect(host.querySelector('fieldset')?.disabled).toBe(true)
  expect(button('按门店').disabled).toBe(true);expect(button('按供应商').disabled).toBe(true)
  expect(button('📊 Excel').disabled).toBe(true);expect(button('⬇ CSV').disabled).toBe(true)
  await act(async()=>download.reject(new Error('文件生成失败')))
  expect(host.textContent).toContain('文件生成失败');expect(button('📊 Excel').disabled).toBe(false)
  expect(host.querySelector('fieldset')?.disabled).toBe(false)
  expect(button('按供应商').disabled).toBe(false)
  await click('📊 Excel');expect(exportXlsx).toHaveBeenCalledTimes(2)
 })
 it('同月切视角后旧响应不会提前结束当前请求',async()=>{
  const old=deferred(),fresh=deferred();vi.mocked(apiFetch).mockImplementation(path=>String(path).includes('view=store')?old.promise:fresh.promise)
  await render();await click('按供应商')
  await act(async()=>old.resolve(store(111)))
  expect(button('📊 Excel').disabled).toBe(true);expect(host.textContent).toContain('加载中')
  await act(async()=>fresh.resolve(supplier(222)))
  expect(button('📊 Excel').disabled).toBe(false);expect(host.textContent).toContain('¥222')
 })
})

it('shows exact cents in store and supplier totals and rows, including large values',async()=>{
 vi.mocked(apiFetch).mockImplementation(async path=>String(path).includes('view=supplier')?[{supplierId:'p',name:'青禾食材',delivered:12345.67,paid:111.11,unpaid:12234.56,loss:1.23}]:[{storeId:'s',name:'清源一店',no:'M001',revenue:12345.67,foodCost:76.54,loss:1.23,net:12267.90}] as any)
 await render()
 for(const amount of ['¥12,345.67','¥76.54','¥1.23','¥12,267.90'])expect(host.textContent).toContain(amount)
 expect(host.textContent).not.toContain('万')
 await click('按供应商')
 for(const amount of ['¥12,345.67','¥111.11','¥12,234.56','¥1.23'])expect(host.textContent).toContain(amount)
 expect(host.textContent).not.toContain('万')
})

it.each(['store','supplier'])('unknown %s summaries never show successful zero balances',async view=>{
 const pending=deferred();vi.mocked(apiFetch).mockReturnValue(pending.promise)
 await render();if(view==='supplier')await click('按供应商')
 expect(host.textContent).toContain('加载中');expect(host.textContent).not.toContain('¥0.00')
 expect(button('📊 Excel').disabled).toBe(true);expect(button('⬇ CSV').disabled).toBe(true)
 await act(async()=>pending.reject(new Error('当前对账读取失败')))
 expect(host.textContent).toContain('当前对账读取失败');expect(host.textContent).not.toContain('¥0.00')
 expect(button('📊 Excel').disabled).toBe(true);expect(host.querySelector('tbody')).toBeNull()
})
it('successful empty store and supplier reports keep genuine zero summaries',async()=>{
 vi.mocked(apiFetch).mockResolvedValue([] as any);await render()
 expect(host.textContent).toContain('¥0.00');expect(host.textContent).not.toContain('读取失败')
 await click('按供应商');expect(host.textContent).toContain('¥0.00')
})
