// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {InventoryRules} from './inventory-rules'
import {InventoryRuleSelector} from './inventory-rule-selector'
const mock=vi.hoisted(()=>({api:vi.fn(),confirm:vi.fn(),push:vi.fn(),role:'SUPPLY_CHAIN',actorId:'same-test-user'}))
vi.mock('@/lib/v2-auth',()=>({apiFetch:mock.api,getUser:()=>({id:mock.actorId,role:mock.role})}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:mock.push})}))
vi.mock('next/link',()=>({default:({href,children,...props}:any)=><a href={href} {...props}>{children}</a>}))
vi.mock('@/lib/ui-dialogs',()=>({confirmDialog:mock.confirm}))
vi.mock('./management-tabs',()=>({ManagementTabs:()=>null}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
let root:ReturnType<typeof createRoot>,host:HTMLDivElement
const warehouse={id:'w1',code:'WH1',name:'原仓',isDefault:true}
const row={productId:'p1',code:'RULE1',name:'规则物料',inventoryUnit:'kg',currentQty:10,minQty:5,maxQty:20,effectiveMin:5,effectiveMax:20,stagnantDays:30,source:'configured',alertStatus:'正常',active:true,rowVersion:2,unitChanged:false,hasPolicy:true,revision:{id:'r1',status:'DRAFT',rowVersion:3,cycleNumber:1,payload:{inventoryUnitSnapshot:'kg',minQty:5,maxQty:25,active:true,stagnantDays:30}}}
const result=(value:any=row)=>({warehouse,warehouses:[warehouse],items:[value],total:1,page:1,pageSize:1,organizationName:'隔离机构'})
const footer=()=>host.querySelector('[aria-label="库存规则编辑操作"]')!
const button=(name:string)=>Array.from(footer().querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===name)!
function change(input:HTMLInputElement,value:string){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('change',{bubbles:true}))}
beforeEach(()=>{vi.clearAllMocks();mock.role='SUPPLY_CHAIN';mock.actorId='same-test-user';mock.confirm.mockResolvedValue(true);host=document.createElement('div');document.body.append(host);root=createRoot(host);mock.api.mockImplementation(async(url:string)=>url.includes('/history?')?{items:[],total:0}:result())})
afterEach(()=>{act(()=>root.unmount());host.remove()})
it('the full editor uses the existing controller and exact scope reader, with four independent footer actions',async()=>{
 await act(async()=>root.render(<InventoryRules editor={{productId:'p1',warehouseId:'w1'}}/>))
 expect(mock.api.mock.calls.filter(([url])=>!url.includes('/history?')).map(([url])=>url)).toEqual(['/api/inventory-reports/policies/p1?warehouseId=w1'])
 expect(Array.from(footer().querySelectorAll('button')).map(b=>b.textContent)).toEqual(['取消','保存','提交','审核'])
 expect(host.textContent).toContain('机构：隔离机构')
 expect(host.querySelector('select[aria-label="仓库"]')).toBeNull()
 expect(mock.api.mock.calls.every(([,init])=>!init?.method)).toBe(true)
 await act(async()=>root.render(<InventoryRules key="p2:w2" editor={{productId:'p2',warehouseId:'w2'}}/>))
 expect(mock.api.mock.calls.some(([url])=>url==='/api/inventory-reports/policies/p2?warehouseId=w2')).toBe(true)
 expect(button('保存').disabled).toBe(true) // mismatched response must not yield a writable row.
})
it('Save does not submit, Submit does not audit, and Audit locks the proposal using existing versions',async()=>{
 let current=structuredClone(row)
 mock.api.mockImplementation(async(url:string,init:any)=>{
  if(url.includes('/history?'))return {items:[],total:0}
  if(init?.method==='PATCH'){
   const body=JSON.parse(init.body);expect(body).toMatchObject({warehouseId:'w1',rowVersion:2,draftVersion:3,revisionId:'r1',minQty:5,maxQty:30,inventoryUnitSnapshot:'kg'})
   current={...current,revision:{...current.revision,rowVersion:4,payload:{...current.revision.payload,maxQty:30}}};return {revision:current.revision}
  }
  if(init?.method==='POST'){
   const action=url.split('/').at(-1);expect(action).toMatch(/^(submit|audit)$/)
   expect(JSON.parse(init.body)).toMatchObject({warehouseId:'w1',revisionId:'r1',rowVersion:action==='submit'?4:5})
   current={...current,revision:{...current.revision,rowVersion:current.revision.rowVersion+1,status:action==='submit'?'PENDING':'AUDITED'}}
   return {revision:current.revision}
  }
  return result(current)
 })
 await act(async()=>root.render(<InventoryRules editor={{productId:'p1',warehouseId:'w1'}}/>))
 await act(async()=>change(host.querySelector('input[aria-label="规则物料库存上限"]')!,'30'))
 await act(async()=>button('保存').click())
 expect(mock.api.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0)
 await act(async()=>button('提交').click())
 expect(mock.api.mock.calls.filter(([,init])=>init?.method==='POST').map(([url])=>url)).toEqual(['/api/inventory-reports/policies/p1/submit'])
 expect(button('审核').disabled).toBe(false)
 await act(async()=>button('审核').click())
 expect(host.querySelector<HTMLInputElement>('input[aria-label="规则物料库存上限"]')!.disabled).toBe(true)
 expect(button('保存').disabled).toBe(true)
 expect(mock.api.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(2)
})
it('read-only role sees the same four actions but cannot save or progress',async()=>{
 mock.role='FINANCE'
 await act(async()=>root.render(<InventoryRules editor={{productId:'p1',warehouseId:'w1'}}/>))
 for(const name of ['保存','提交','审核'])expect(button(name).disabled).toBe(true)
 expect(mock.api.mock.calls.every(([,init])=>!init?.method)).toBe(true)
})
it('new-rule selection reads the requested warehouse and links its actual product without creating anything',async()=>{
 mock.api.mockResolvedValue({warehouse:{...warehouse,id:'w2'},warehouses:[{...warehouse,id:'w2'}],items:[{productId:'actual-product',code:'SKU-2',name:'规则商品'}],total:1,page:1,pageSize:50})
 await act(async()=>root.render(<InventoryRuleSelector initialWarehouseId="w2"/>))
 expect(mock.api.mock.calls.every(([url])=>url.includes('warehouseId=w2'))).toBe(true)
 const select=host.querySelector<HTMLSelectElement>('select[aria-label="规则商品"]')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(select,'actual-product');select.dispatchEvent(new Event('change',{bubbles:true}))})
 expect(host.querySelector('a[href="/v2/supply-chain/inventory-management/limits/actual-product/edit?warehouseId=w2"]')).not.toBeNull()
 expect(mock.api.mock.calls.every(([,init])=>!init?.method)).toBe(true)
})

it('an old session response cannot initialize a rule editor after an account change',async()=>{
 let finish!:(value:any)=>void
 mock.api.mockImplementation((url:string)=>url.includes('/history?')?Promise.resolve({items:[],total:0}):new Promise(resolve=>{finish=resolve}))
 await act(async()=>root.render(<InventoryRules editor={{productId:'p1',warehouseId:'w1'}}/>))
 mock.actorId='different-user'
 await act(async()=>{window.dispatchEvent(new StorageEvent('storage',{key:'user'}));finish(result())})
 expect(host.textContent).toContain('账号或租户已变化')
 expect(host.querySelector('input[aria-label="规则物料库存上限"]')).toBeNull()
 expect(button('保存').disabled).toBe(true)
 expect(mock.api.mock.calls.every(([,init])=>!init?.method)).toBe(true)
})
it('switching the tenant retains old inputs but disables saving in the old controller',async()=>{
 await act(async()=>root.render(<InventoryRules editor={{productId:'p1',warehouseId:'w1'}}/>))
 await act(async()=>change(host.querySelector('input[aria-label="规则物料库存上限"]')!,'30'))
 await act(async()=>{localStorage.setItem('tenant',JSON.stringify({id:'other-tenant'}));window.dispatchEvent(new StorageEvent('storage',{key:'tenant'}))})
 expect(host.querySelector<HTMLInputElement>('input[aria-label="规则物料库存上限"]')!.value).toBe('30')
 expect(button('保存').disabled).toBe(true)
 expect(mock.api.mock.calls.every(([,init])=>!init?.method)).toBe(true)
 localStorage.removeItem('tenant')
})

it('an awaiting approval confirmation cannot write after the reader is retargeted and unverified',async()=>{
 let finishConfirm!:(value:boolean)=>void
 mock.confirm.mockImplementation(()=>new Promise(resolve=>{finishConfirm=resolve}))
 mock.api.mockImplementation((url:string)=>url.includes('/history?')?Promise.resolve({items:[],total:0}):url.includes('warehouseId=w2')?new Promise(()=>{}):Promise.resolve(result()))
 await act(async()=>root.render(<InventoryRules editor={{productId:'p1',warehouseId:'w1'}}/>))
 await act(async()=>button('提交').click())
 expect(mock.confirm).toHaveBeenCalledTimes(1)
 await act(async()=>root.render(<InventoryRules editor={{productId:'p1',warehouseId:'w2'}}/>))
 await act(async()=>finishConfirm(true))
 expect(mock.api.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true)
 expect(button('审核').disabled).toBe(true)
})
