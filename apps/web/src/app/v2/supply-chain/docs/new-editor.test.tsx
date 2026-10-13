// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WarehouseDocumentEditor } from './warehouse-document-editor'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), flush: vi.fn(), completed: vi.fn(), draft: vi.fn(), created: vi.fn(),pending:false,snapshot:{version:1,warehouse:{id:'warehouse',code:'WH',name:'测试仓'},products:[{id:'product',name:'测试土豆',code:'P001',spec:null,category:null,enabled:true,displayMatched:true,units:{purchaseUnit:'箱',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:10,status:'VERIFIED',structured:{purchase:true}}}]} }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: (...args: any[]) => mocks.fetch(...args) }))
vi.mock('@/lib/use-warehouse-inbound-draft', () => ({ useWarehouseInboundDraft: (...args: any[]) => {
  mocks.draft(...args)
  return { reconfirmPending:mocks.pending,snapshot:mocks.snapshot,status: '草稿已同步', failure: '', ready: true, submittedDocId: '', flush: mocks.flush, completed: mocks.completed, reload: vi.fn() }
} }))
vi.mock('@/components/v2/responsive-data-table', () => ({ ResponsiveDataTable: ({children}: any) => <div>{children}</div> }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot>, host: HTMLDivElement
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!
const change = async (input: HTMLInputElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(input,value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', {bubbles:true}))
  })
}
beforeEach(() => {
  mocks.pending=false;mocks.snapshot.products[0].displayMatched=true
  vi.clearAllMocks(); localStorage.setItem('tenant',JSON.stringify({name:'测试机构'}))
  mocks.flush.mockResolvedValue({id:'draft-original',version:4})
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/warehouse-inventory/inbound-candidates')) return {items:[{id:'product',code:'P001',name:'测试土豆',purchaseUnit:'箱',inventoryUnit:'kg',purchaseToInventoryFactor:10}]}
    if (url.startsWith('/api/warehouse-inventory?page')) return {warehouse:{id:'warehouse',code:'WH',name:'测试仓'}}
    if (url.startsWith('/api/suppliers')) return [{id:'supplier',no:'SUP001',name:'测试上游'}]
    if (url.endsWith('/submit')) return {doc:{id:'created-doc',docNo:'RK-NEW',status:'POSTED'},gateWarnings:[]}
    throw Error(`Unexpected ${url}`)
  })
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
it('stale display metadata blocks submitting until the explicit recheck action',async()=>{
 mocks.snapshot.products[0].displayMatched=false
 await ready()
 expect(button('提交').disabled).toBe(true)
 expect(button('审核').disabled).toBe(true)
 expect(host.textContent).toContain('尚未核对')
 await act(async()=>button('重新核对仓库与单位').click())
 await act(async()=>Array.from(host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(item=>item.textContent==='重新核对')!.click())
 expect(mocks.flush).toHaveBeenCalledWith(true)
 expect(mocks.fetch.mock.calls.some(call=>call[1]?.method==='POST')).toBe(false)
})
it('an unknown recheck freezes business fields but retains its original retry entry',async()=>{
 await ready();mocks.pending=true
 await act(async()=>root.render(<WarehouseDocumentEditor canEdit canAudit canReview fullPage onClose={()=>{}} onChanged={()=>{}} onCreated={mocks.created}/>))
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆数量"]')!.disabled).toBe(true)
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆金额"]')!.disabled).toBe(true)
 expect(button('保存').disabled).toBe(true)
 expect(button('提交').disabled).toBe(true)
 expect(button('核对原请求').disabled).toBe(false)
})
it('remote candidate search keeps the current draft inputs and exposes a later source',async()=>{
 await ready()
 const initial=mocks.fetch.getMockImplementation()!
 mocks.fetch.mockImplementation(async(path:string,init:any)=>String(path).includes('q=遥远物料')||String(path).includes('q=%E9%81%A5%E8%BF%9C%E7%89%A9%E6%96%99')?{items:[{id:'far-source',code:'FAR',name:'遥远物料',purchaseUnit:'箱',inventoryUnit:'kg',purchaseToInventoryFactor:5}]}:initial(path,init))
 await change(host.querySelector('input[aria-label="查询可用物品"]')!,'遥远物料')
 await act(async()=>button('查询物品').click())
 expect(host.querySelector<HTMLSelectElement>('select[aria-label="添加入库物品"]')!.textContent).toContain('遥远物料')
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆数量"]')!.value).toBe('2')
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆金额"]')!.value).toBe('6')
})
afterEach(async () => {await act(async()=>root.unmount());host.remove();localStorage.clear()})
async function ready() {
  await act(async () => root.render(<WarehouseDocumentEditor fullPage canEdit canAudit canReview onClose={()=>{}} onChanged={()=>{}} onCreated={mocks.created} />))
  await change(host.querySelector('select[aria-label="添加入库物品"]')!,'product')
  await act(async()=>button('添加物品').click())
  await change(host.querySelector<HTMLSelectElement>('select[aria-label="供应商"]')!,'supplier')
  await change(host.querySelector('input[aria-label="测试土豆数量"]')!,'2')
  await change(host.querySelector('input[aria-label="测试土豆金额"]')!,'6')
}
it('new editor has four independent footer actions; save does not submit',async()=>{
  await ready()
  expect(Array.from(host.querySelectorAll('footer button')).map(item=>item.textContent)).toEqual(['取消','保存','提交','审核'])
  await act(async()=>button('保存').click())
  expect(mocks.flush).toHaveBeenCalledTimes(1)
  expect(mocks.fetch.mock.calls.some(call=>call[1]?.method==='POST')).toBe(false)
  expect(mocks.draft.mock.calls.at(-1)![2].rows[0]).toMatchObject({productId:'product',purchaseQuantity:'2',amount:'6'})
})
it('Submit confirmation cancel does not write; confirming sends auditOnSubmit=false',async()=>{
  await ready()
  await act(async()=>button('提交').click());await act(async()=>button('取消').click())
  expect(mocks.fetch.mock.calls.some(call=>call[1]?.method==='POST')).toBe(false)
  await act(async()=>button('提交').click());await act(async()=>button('确认提交').click())
  expect(mocks.fetch).toHaveBeenCalledWith('/api/warehouse-inventory/inbound-drafts/draft-original/submit',expect.objectContaining({body:JSON.stringify({version:4,auditOnSubmit:false})}))
  expect(mocks.created).toHaveBeenCalledWith('created-doc',expect.stringContaining('待审核'))
})
it('unknown response retries the original request without creating or flushing a replacement',async()=>{
  await ready()
  const fetch=mocks.fetch.getMockImplementation()!;let first=true
  mocks.fetch.mockImplementation(async(url:string,options:any)=>{
    if(url.endsWith('/submit')&&first){first=false;throw Error('模拟响应丢失')}
    return fetch(url,options)
  })
  await act(async()=>button('提交').click());await act(async()=>button('确认提交').click())
  expect(host.textContent).toContain('核对原提交')
  expect((host.querySelector('input[aria-label="测试土豆数量"]') as HTMLInputElement).disabled).toBe(true)
  await act(async()=>button('核对原提交').click())
  const requests=mocks.fetch.mock.calls.filter(call=>call[0].endsWith('/submit'))
  expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1])
  expect(mocks.flush).toHaveBeenCalledTimes(1)
  expect(mocks.created).toHaveBeenCalledTimes(1)
})

it('explicit gift fixes price and amount at zero and preserves the flag in the saved draft',async()=>{
 await ready()
 await act(async()=>host.querySelector<HTMLInputElement>('input[aria-label="测试土豆是否赠品"]')!.click())
 const amount=host.querySelector<HTMLInputElement>('input[aria-label="测试土豆金额"]')!
 expect(amount.value).toBe('0');expect(amount.disabled).toBe(true)
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆入库单价"]')!.value).toBe('0')
 expect(mocks.draft.mock.calls.at(-1)![2].rows[0]).toMatchObject({isGift:true,amount:'0',purchaseQuantity:'2'})
 await act(async()=>button('提交').click());await act(async()=>button('确认提交').click())
 expect(mocks.created).toHaveBeenCalledTimes(1)
})

it('new editor saves batch/date fields and restores them from server draft without dropping them',async()=>{
 await ready()
 await change(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆批次号"]')!,'QA-DATE-20261010')
 await change(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆生产日期"]')!,'2026-10-10')
 await change(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆到期日期"]')!,'2026-11-10')
 const payload=mocks.draft.mock.calls.at(-1)![2]
 expect(payload.rows[0]).toMatchObject({batchNo:'QA-DATE-20261010',manufactureDate:'2026-10-10',expiryDate:'2026-11-10'})
 await act(async()=>mocks.draft.mock.calls.at(-1)![3](payload))
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆批次号"]')!.value).toBe('QA-DATE-20261010')
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆生产日期"]')!.value).toBe('2026-10-10')
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆到期日期"]')!.value).toBe('2026-11-10')
 await act(async()=>button('保存').click())
 expect(mocks.fetch.mock.calls.some(call=>call[1]?.method==='POST')).toBe(false)
})
it('restores the exact draft timestamp and raw date representation until the user changes the date',async()=>{
 await ready()
 const saved={...mocks.draft.mock.calls.at(-1)![2],effectiveAt:'2026-10-12T10:52',effectiveAtIso:'2026-10-12T17:52:40.104Z'}
 await act(async()=>mocks.draft.mock.calls.at(-1)![3](saved))
 expect(mocks.draft.mock.calls.at(-1)![2]).toMatchObject({effectiveAt:saved.effectiveAt,effectiveAtIso:saved.effectiveAtIso})
 await change(host.querySelector<HTMLInputElement>('input[aria-label="单据备注"]')!,'只改备注')
 expect(mocks.draft.mock.calls.at(-1)![2]).toMatchObject({effectiveAt:saved.effectiveAt,effectiveAtIso:saved.effectiveAtIso})
 await change(host.querySelector<HTMLInputElement>('input[aria-label="入库日期"]')!,'2026-10-14')
 expect(mocks.draft.mock.calls.at(-1)![2]).toMatchObject({effectiveAt:'2026-10-13T16:00:00.000Z',effectiveAtIso:'2026-10-13T16:00:00.000Z'})
})

it('does not invent a saved timestamp when restoring unfinished empty ISO input',async()=>{
 await ready()
 const saved={...mocks.draft.mock.calls.at(-1)![2],effectiveAt:'未完成日期',effectiveAtIso:''}
 await act(async()=>mocks.draft.mock.calls.at(-1)![3](saved))
 expect(mocks.draft.mock.calls.at(-1)![2]).toMatchObject({effectiveAt:saved.effectiveAt,effectiveAtIso:''})
 await change(host.querySelector<HTMLInputElement>('input[aria-label="单据备注"]')!,'只改备注')
 expect(mocks.draft.mock.calls.at(-1)![2]).toMatchObject({effectiveAt:saved.effectiveAt,effectiveAtIso:''})
 await change(host.querySelector<HTMLInputElement>('input[aria-label="入库日期"]')!,'2026-10-14')
 expect(mocks.draft.mock.calls.at(-1)![2].effectiveAtIso).toBe('2026-10-13T16:00:00.000Z')
})

it('invalid date range keeps input and rejects Submit before any posting request',async()=>{
 await ready()
 await change(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆生产日期"]')!,'2026-10-10')
 await change(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆到期日期"]')!,'2026-10-09')
 await act(async()=>button('提交').click());await act(async()=>button('确认提交').click())
 expect(host.textContent).toContain('到期日期不能早于生产日期')
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆到期日期"]')!.value).toBe('2026-10-09')
 expect(mocks.fetch.mock.calls.some(call=>call[1]?.method==='POST')).toBe(false)
})

it('outbound uses the same four footer actions and restores base-unit quantity/reason while allowing automatic cost',async()=>{
 await act(async()=>root.render(<WarehouseDocumentEditor newType="MANUAL_OUTBOUND" fullPage canEdit canAudit canReview onClose={()=>{}} onChanged={()=>{}} onCreated={mocks.created}/>))
 await change(host.querySelector('select[aria-label="添加出库物品"]')!,'product');await act(async()=>button('添加物品').click())
 await change(host.querySelector('input[aria-label="测试土豆数量"]')!,'2')
 await change(host.querySelector('select[aria-label="出库用途"]')!,'SAMPLE_ISSUE')
 await change(host.querySelector('input[aria-label="出库原因/去向"]')!,'合成样品领用')
 expect(Array.from(host.querySelectorAll('footer button')).map(b=>b.textContent)).toEqual(['取消','保存','提交','审核'])
 expect(host.textContent).toContain('提交时计算')
 const payload=mocks.draft.mock.calls.at(-1)![2]
 expect(mocks.draft.mock.calls.at(-1)![0]).toBe('OUTBOUND')
 expect(payload.rows[0]).toMatchObject({inventoryQuantity:'2',totalAmount:''})
 await act(async()=>mocks.draft.mock.calls.at(-1)![3](payload))
 expect(host.querySelector<HTMLInputElement>('input[aria-label="测试土豆数量"]')!.value).toBe('2')
 expect(host.querySelector<HTMLInputElement>('input[aria-label="出库原因/去向"]')!.value).toBe('合成样品领用')
 await act(async()=>button('保存').click());expect(mocks.fetch.mock.calls.some(c=>c[1]?.method==='POST')).toBe(false)
 await act(async()=>button('提交').click());await act(async()=>button('确认提交').click())
 expect(mocks.fetch).toHaveBeenCalledWith('/api/warehouse-inventory/inbound-drafts/draft-original/submit',expect.objectContaining({body:JSON.stringify({version:4,auditOnSubmit:false})}))
})
