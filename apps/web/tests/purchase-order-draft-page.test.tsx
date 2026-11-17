// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPurchaseDraftSession, purchaseDraftKey } from '../src/lib/purchase-order-draft'
import Page from '../src/app/v2/chef/purchase/new/page'
const {api,push}=vi.hoisted(()=>({api:vi.fn(),push:vi.fn()}))
vi.mock('next/navigation',()=>({usePathname:()=>'/v2/chef/purchase/new',useRouter:()=>({push,back:vi.fn()})}))
vi.mock('@/lib/v2-auth',()=>({apiFetch:api,getUser:()=>({id:'user-a',tenantId:'tenant-a',storeId:'default-store'}),getActiveStoreId:()=> 'selected-store'}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=>React.createElement('span',null,children)}))
vi.mock('@/components/v2/order-product-image',()=>({OrderProductImage:()=>null}))
vi.mock('@/lib/order-entry-cost-pricing',()=>({calculateOrderEntryLineAmount:(q:number,p:string)=>String(q*Number(p)),resolveOrderEntryCostPricing:()=>({status:'READY',orderUnitPrice:'10'}),sumOrderEntryLineAmounts:(xs:string[])=>String(xs.reduce((n,x)=>n+Number(x),0))}))
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})
let root:any,host:HTMLElement
const owner={tenantId:'tenant-a',userId:'user-a',storeId:'selected-store'}
const draft={supplierId:'supplier-a',expectedDate:'2026-10-30',note:'',items:[{productId:'p1',quantity:2,unitPrice:10}]}
beforeEach(()=>{vi.useFakeTimers();const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k),clear:()=>values.clear()});localStorage.clear();api.mockReset();push.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals()})
it('submits for selected store, keeps failed retry key, and prevents successful draft resurrection through timer and unmount',async()=>{
 const initial=createPurchaseDraftSession(localStorage,owner);const originalKey=initial.beginSubmission(draft);initial.failSubmission();initial.dispose();localStorage.setItem('dj:po-new:draft:v1',JSON.stringify({...draft,savedAt:Date.now()}))
 let finish:(value:any)=>void=()=>{},attempt=0
 api.mockImplementation((path:string)=>{
  if(path==='/api/orders'){attempt++;return attempt===1?Promise.reject(new Error('synthetic network failure')):new Promise(r=>finish=r)}
  if(path==='/api/suppliers')return Promise.resolve([{id:'supplier-a',name:'Supplier',category:null,bankAccount:null,inventoryMode:'NOT_TRACKED'}])
  if(path==='/api/products')return Promise.resolve({items:[{id:'p1',name:'Product',unit:'箱',price:'10',supplierId:'supplier-a',status:'ENABLED',minOrderQty:1,stepQty:1}]})
  return Promise.resolve({rule:null})
 })
 await act(async()=>{root.render(React.createElement(Page));await Promise.resolve()})
 expect(host.textContent).toContain('已恢复上次未提交的草稿')
 const submit=()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
 await act(async()=>{submit();await Promise.resolve()})
 const first=JSON.parse(api.mock.calls.find(([path]:any)=>path==='/api/orders')![1].body);expect(first.storeId).toBe('selected-store');expect(first.idempotencyKey).toBe(originalKey)
 await act(async()=>{submit();await Promise.resolve()});const posts=api.mock.calls.filter(([path]:any)=>path==='/api/orders');expect(JSON.parse(posts[1][1].body).idempotencyKey).toBe(originalKey)
 await act(async()=>{finish({id:'order-a',no:'PO-A'});await Promise.resolve();vi.advanceTimersByTime(1000);window.dispatchEvent(new Event('pagehide'))})
 expect(push).toHaveBeenCalledWith('/v2/chef/purchase/po-success/order-a');expect(localStorage.getItem(purchaseDraftKey(owner))).toBeNull()
 await act(async()=>{root.unmount();vi.advanceTimersByTime(1000)});root=createRoot(host)
 expect(createPurchaseDraftSession(localStorage,owner).restored).toBeNull()
})
