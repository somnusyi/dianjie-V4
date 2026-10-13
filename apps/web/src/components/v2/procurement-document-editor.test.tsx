// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {beforeEach,it,expect,vi} from 'vitest'
import {ProcurementDocumentEditor} from './procurement-document-editor'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn(),getUser:()=>({role:'SUPPLY_CHAIN'})}))
import {apiFetch} from '@/lib/v2-auth'
const mock=vi.mocked(apiFetch)
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
const original={id:'rc-1',no:'QC-RC-1',status:'DRAFT',approvalStatus:'DRAFT',approvalVersion:1,rowVersion:0,note:null,organizationName:'合成机构',createdAt:'2026-10-12T00:00:00Z',supplier:{no:'SUP1',name:'合成供应商'},warehouse:{code:'WH1',name:'合成仓'},lines:[{id:'line-1',purchaseUnit:'袋',inventoryUnit:'kg',inventoryUnitsPerPurchaseUnit:5,acceptedQty:2,arrivedQty:2,damagedQty:0,rejectedQty:0,unitPrice:10,payableAmount:20,batchNo:'LOT-1',manufactureDate:'2026-10-10T00:00:00Z',expiryDate:'2026-11-10T00:00:00Z',note:null,purchaseOrderLine:{productCodeSnapshot:'SKU1',productNameSnapshot:'合成物料',productSpecSnapshot:'5kg/袋'},product:{code:'SKU1',name:'合成物料',category:'合成分类'}}]}
function mount(kind:"RECEIPT"|"RETURN"="RECEIPT"){const element=document.createElement('div');document.body.append(element);const root=createRoot(element);const close=vi.fn();act(()=>root.render(<ProcurementDocumentEditor kind={kind} sourceId="rc-1" onClose={close}/>));return{element,root,close}}
async function wait(condition:()=>boolean){for(let i=0;i<100;i++){if(condition())return;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5))})}throw Error('wait failed')}
function change(field:HTMLInputElement,value:string){act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}))})}
const button=(element:HTMLElement,text:string)=>Array.from(element.querySelectorAll<HTMLButtonElement>('footer button')).find(button=>button.textContent===text)!
it('new return retains source price and quantity limit, then creates and submits the original once',async()=>{
 const context={...original,lines:[{...original.lines[0],purchaseQuantity:0,settlementUnitPrice:10,settlementAmount:0,returnableQuantity:2,receiptLine:{receipt:{no:'ORIGINAL-RC'}}}]}
 mock.mockImplementation((path,init)=>String(path).endsWith('/approval/submit')?Promise.resolve({approvalStatus:'PENDING'}):init?.method==='POST'?Promise.resolve({purchaseReturn:{id:'return-created',approvalStatus:'DRAFT',approvalVersion:1,rowVersion:0}}):Promise.resolve(context))
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element),created=vi.fn()
 act(()=>root.render(<ProcurementDocumentEditor kind="RETURN" sourceId="new" supplierId="sup-1" warehouseId="wh-1" onCreated={created} onClose={()=>{}}/>))
 await wait(()=>Boolean(element.querySelector('footer')))
 expect(element.textContent).toContain('ORIGINAL-RC')
 expect(element.querySelector<HTMLInputElement>('input[aria-label="1行unitPrice"]')?.value).toBe('10')
 expect(element.querySelector<HTMLInputElement>('input[aria-label="1行unitPrice"]')?.disabled).toBe(true)
 change(element.querySelector('input[aria-label="退货原因"]')!,'退回多送商品')
 change(element.querySelector('input[aria-label="1行quantity"]')!,'3')
 await act(async()=>button(element,'保存').click())
 expect(element.textContent).toContain('不能超过可退数量')
 expect(mock.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0)
 change(element.querySelector('input[aria-label="1行quantity"]')!,'1')
 act(()=>button(element,'提交').click())
 await act(async()=>Array.from(element.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button=>button.textContent==='提交')!.click())
 const calls=mock.mock.calls.filter(([,init])=>init?.method==='POST')
 expect(calls).toHaveLength(2)
 expect(calls[0][0]).toBe('/api/upstream/purchase-returns')
 expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({supplierId:'sup-1',warehouseId:'wh-1',reason:'退回多送商品',lines:[{receiptLineId:'line-1',purchaseQuantity:1}]})
 expect(calls[1][0]).toBe('/api/upstream/purchase-returns/return-created/approval/submit')
 expect(created).toHaveBeenCalledWith('return-created')
 act(()=>root.unmount());element.remove()
})
beforeEach(()=>{mock.mockReset();sessionStorage.clear();window.history.replaceState({},'','/v2/supply-chain/procurement/receipts/rc-1/edit')})
it('restores unknown creation inputs and retries the identical cached body',async()=>{
 const cached={key:'receipt-recover-123',body:{idempotencyKey:'receipt-recover-123',finalForShipment:true,note:'网络中断前备注',lines:[{shipmentLineId:'line-1',arrivedQty:4,acceptedQty:3,damagedQty:1,rejectedQty:0,unitPrice:12,batchNo:'RECOVER-LOT',manufactureDate:'2026-10-09',note:'原行备注'}]}}
 sessionStorage.setItem('dj:receipt-create:undefined:ship-recover',JSON.stringify(cached))
 mock.mockImplementation((_,init)=>init?.method==='POST'?Promise.resolve({id:'recovered-1'}):Promise.resolve(original))
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element),created=vi.fn()
 act(()=>root.render(<ProcurementDocumentEditor kind="RECEIPT" sourceId="new" shipmentId="ship-recover" onCreated={created} onClose={()=>{}}/>))
 await wait(()=>Boolean(element.querySelector('footer')))
 expect(element.querySelector<HTMLInputElement>('input[aria-label="1行quantity"]')?.value).toBe('3')
 expect(element.querySelector<HTMLInputElement>('input[aria-label="单据备注"]')?.value).toBe('网络中断前备注')
 expect(element.querySelector<HTMLInputElement>('input[aria-label="1行quantity"]')?.disabled).toBe(true)
 await act(async()=>Array.from(element.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='核对原保存')!.click())
 const call=mock.mock.calls.find(([,init])=>init?.method==='POST')!
 expect(JSON.parse(String(call[1]?.body))).toEqual(cached.body)
 expect(created).toHaveBeenCalledWith('recovered-1')
 act(()=>root.unmount());element.remove()
})
it('a stale confirmed creation cache cannot force a revoked receipt or reuse its body',async()=>{
 sessionStorage.setItem('dj:receipt-create:undefined:ship-revoked',JSON.stringify({key:'old-create-request',sourceId:'revoked-1',body:{note:'旧冲销内容',lines:[]}}))
 mock.mockImplementation((_,init)=>init?.method==='POST'?Promise.resolve({id:'fresh-receipt'}):Promise.resolve(original))
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element),created=vi.fn()
 act(()=>root.render(<ProcurementDocumentEditor kind="RECEIPT" sourceId="new" shipmentId="ship-revoked" onCreated={created} onClose={()=>{}}/>))
 await wait(()=>Boolean(element.querySelector('footer')))
 expect(created).not.toHaveBeenCalled()
 expect(mock.mock.calls[0][0]).toBe('/api/upstream/shipments/ship-revoked/receipt-context')
 expect(element.querySelector<HTMLInputElement>('input[aria-label="1行quantity"]')?.disabled).toBe(false)
 await act(async()=>button(element,'保存').click())
 const call=mock.mock.calls.find(([,init])=>init?.method==='POST')!
 expect(JSON.parse(String(call[1]?.body)).idempotencyKey).not.toBe('old-create-request')
 expect(created).toHaveBeenCalledWith('fresh-receipt')
 act(()=>root.unmount());element.remove()
})
it('a late creation response cannot replace another shipment cache or submit from the new page',async()=>{
 let resolveCreation!:(value:any)=>void
 mock.mockImplementation((_,init)=>init?.method==='POST'?new Promise(resolve=>{resolveCreation=resolve}):Promise.resolve(original))
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element),created=vi.fn(),close=()=>{}
 act(()=>root.render(<ProcurementDocumentEditor kind="RECEIPT" sourceId="new" shipmentId="ship-old" onCreated={created} onClose={close}/>))
 await wait(()=>Boolean(element.querySelector('footer')))
 act(()=>button(element,'提交').click())
 act(()=>Array.from(element.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button=>button.textContent==='提交')!.click())
 await wait(()=>Boolean(resolveCreation))
 act(()=>root.render(<ProcurementDocumentEditor kind="RECEIPT" sourceId="new" shipmentId="ship-next" onCreated={created} onClose={close}/>))
 await wait(()=>Boolean(element.querySelector('footer')))
 await act(async()=>resolveCreation({id:'old-created',approvalStatus:'DRAFT',approvalVersion:1,rowVersion:0}))
 expect(created).not.toHaveBeenCalled()
 expect(mock.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1)
 expect(JSON.parse(sessionStorage.getItem('dj:receipt-create:undefined:ship-old')!).sourceId).toBe('old-created')
 expect(sessionStorage.getItem('dj:receipt-create:undefined:ship-next')).toBeNull()
 await act(async()=>button(element,'保存').click())
 expect(mock.mock.calls.filter(([,init])=>init?.method==='POST')[1][0]).toBe('/api/upstream/shipments/ship-next/receipts')
 act(()=>root.unmount());element.remove()
})
it('business save sends full original rows and versions; cancel preserves fields without a write',async()=>{
 mock.mockResolvedValue(original)
 const {element,root,close}=mount();await wait(()=>Boolean(element.querySelector('input[aria-label="单据备注"]')))
 expect(['取消','保存','提交','审核'].every(label=>Boolean(button(element,label)))).toBe(true)
 expect(element.textContent).toContain('合成机构');expect(element.textContent).toContain('合成物料')
 change(element.querySelector('input[aria-label="单据备注"]')!,'修改备注')
 act(()=>button(element,'取消').click())
 expect(element.querySelector('[role="dialog"]')?.textContent).toContain('离开编辑页')
 act(()=>Array.from(element.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button=>button.textContent==='取消')!.click())
 expect(close).not.toHaveBeenCalled();expect(mock.mock.calls.every(([,init])=>!init?.method)).toBe(true)
 await act(async()=>button(element,'保存').click())
 const call=mock.mock.calls.find(([,init])=>init?.method==='PUT')!
 expect(JSON.parse(String(call[1]?.body))).toMatchObject({approvalVersion:1,sourceVersion:0,note:'修改备注',lines:[{id:'line-1',quantity:2,unitPrice:10,batchNo:'LOT-1',manufactureDate:'2026-10-10',expiryDate:'2026-11-10'}]})
 act(()=>root.unmount());element.remove()
})
it('unknown save response freezes fields and retries exactly the original request',async()=>{
 let attempts=0
 mock.mockImplementation((_,init)=>init?.method==='PUT'?(++attempts===1?Promise.reject(Error('网络中断')):Promise.resolve({success:true})):Promise.resolve(original))
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('input[aria-label="单据备注"]')))
 change(element.querySelector('input[aria-label="单据备注"]')!,'保留原保存')
 await act(async()=>button(element,'保存').click())
 expect(element.querySelector<HTMLInputElement>('input[aria-label="单据备注"]')?.disabled).toBe(true)
 expect(element.textContent).toContain('结果待核对')
 await act(async()=>Array.from(element.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='核对原保存')!.click())
 const calls=mock.mock.calls.filter(([,init])=>init?.method==='PUT');expect(calls).toHaveLength(2);expect(calls[0][1]?.body).toEqual(calls[1][1]?.body)
 act(()=>root.unmount());element.remove()
})
it('audited and posted documents lock business inputs and retain fixed printing and quality entries',async()=>{
 mock.mockResolvedValue({...original,status:'POSTED',approvalStatus:'REVIEWED'})
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('footer')))
 expect(element.querySelector<HTMLInputElement>('input[aria-label="1行quantity"]')?.disabled).toBe(true)
 expect(element.querySelector<HTMLInputElement>('input[aria-label="单据备注"]')?.disabled).toBe(false)
 change(element.querySelector<HTMLInputElement>('input[aria-label="单据备注"]')!,'补充备注')
 await act(async()=>button(element,'保存').click())
 const call=mock.mock.calls.find(([,init])=>init?.method==='PATCH')!
 expect(call[0]).toBe('/api/upstream/receipts/rc-1/note')
 const body=JSON.parse(String(call[1]?.body));expect(body).toMatchObject({note:'补充备注',sourceVersion:0});expect(body).not.toHaveProperty('lines')
 expect(element.textContent).toContain('打印');expect(element.textContent).toContain('质检');expect(element.textContent).not.toContain('取消复审')
 expect(Array.from(element.querySelectorAll<HTMLButtonElement>('button')).some(button=>button.textContent==='反审核')).toBe(false)
 act(()=>root.unmount());element.remove()
})
it('new receipt uses the same fields and four buttons, saves one durable draft without PASS/FAIL',async()=>{
 mock.mockImplementation((path,init)=>init?.method==='POST'?Promise.resolve({id:'created-1',approvalStatus:'DRAFT',approvalVersion:1,rowVersion:0}):Promise.resolve(original))
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element),created=vi.fn()
 act(()=>root.render(<ProcurementDocumentEditor kind="RECEIPT" sourceId="new" shipmentId="ship-1" onCreated={created} onClose={()=>{}}/>))
 await wait(()=>Boolean(element.querySelector('footer')))
 expect(['取消','保存','提交','审核'].every(label=>Boolean(button(element,label)))).toBe(true)
 expect(element.textContent).toContain('新建采购入库单');expect(element.textContent).not.toContain('不合格')
 await act(async()=>button(element,'保存').click())
 const calls=mock.mock.calls.filter(([,init])=>init?.method==='POST');expect(calls).toHaveLength(1)
 expect(calls[0][0]).toBe('/api/upstream/shipments/ship-1/receipts')
 const body=JSON.parse(String(calls[0][1]?.body));expect(body.lines[0]).toMatchObject({shipmentLineId:'line-1',acceptedQty:2,unitPrice:10,manufactureDate:'2026-10-10'})
 expect(body.lines[0]).not.toHaveProperty('qualityResult');expect(created).toHaveBeenCalledWith('created-1')
 act(()=>root.unmount());element.remove()
})
it('new receipt submit creates once then submits with the returned real versions',async()=>{
 mock.mockImplementation((path,init)=>String(path).endsWith('/approval/submit')?Promise.resolve({approvalStatus:'PENDING'}):init?.method==='POST'?Promise.resolve({id:'created-2',approvalStatus:'DRAFT',approvalVersion:1,rowVersion:0}):Promise.resolve(original))
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element),created=vi.fn()
 act(()=>root.render(<ProcurementDocumentEditor kind="RECEIPT" sourceId="new" shipmentId="ship-2" onCreated={created} onClose={()=>{}}/>))
 await wait(()=>Boolean(element.querySelector('footer')))
 act(()=>button(element,'提交').click())
 await act(async()=>Array.from(element.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button=>button.textContent==='提交')!.click())
 const calls=mock.mock.calls.filter(([,init])=>init?.method==='POST');expect(calls).toHaveLength(2)
 expect(calls[1][0]).toBe('/api/upstream/receipts/created-2/approval/submit');expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({approvalVersion:1,sourceVersion:0})
 expect(created).toHaveBeenCalledWith('created-2')
 act(()=>root.unmount());element.remove()
})
it('new receipt restores an existing server draft without another creation request',async()=>{
 mock.mockResolvedValue({existingSourceId:'original-draft',existingNo:'RC-OLD'})
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element),created=vi.fn()
 act(()=>root.render(<ProcurementDocumentEditor kind="RECEIPT" sourceId="new" shipmentId="ship-3" onCreated={created} onClose={()=>{}}/>))
 await wait(()=>created.mock.calls.length>0)
 expect(created).toHaveBeenCalledWith('original-draft');expect(mock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false)
 act(()=>root.unmount());element.remove()
})

it('a list audit link opens the existing confirmation without posting until confirmed',async()=>{
 window.history.replaceState({},'', '/?action=audit')
 mock.mockResolvedValue({...original,approvalStatus:'PENDING'} as any)
 const {element,root}=mount()
 try{
  await wait(()=>Boolean(element.querySelector('[role="dialog"]')))
  expect(element.querySelector('[role="dialog"]')?.textContent).toContain('本操作只改变进度')
  expect(mock.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true)
  await act(async()=>Array.from(element.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button=>button.textContent==='取消')!.click())
  expect(element.querySelector('[role="dialog"]')).toBeNull()
  expect(mock.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true)
 }finally{act(()=>root.unmount());element.remove();window.history.replaceState({},'','/')}
})

it.each(['保留','采用最新'])('409恢复展示对照，%s必须明确选择且不自动写入',async(choice)=>{
 let reads=0,writes=0
 const posted={...original,status:'POSTED',approvalStatus:'REVIEWED',note:'原备注'}
 let latest={...posted,note:'服务器另一页的新备注',rowVersion:9}
 mock.mockImplementation(async(path,init)=>{
  if(init?.method==='PATCH'){
   writes++
   if(writes===1)throw Object.assign(Error('备注已变化'),{status:409})
   const body=JSON.parse(String(init.body));expect(body).toMatchObject({note:'本页未保存备注',sourceVersion:9})
   latest={...latest,note:body.note,rowVersion:10};return {ok:true}
  }
  return ++reads===1?posted:latest
 })
 const {element,root}=mount()
 try{
  await wait(()=>Boolean(element.querySelector('footer')))
  change(element.querySelector('input[aria-label="单据备注"]')!,'本页未保存备注')
  await act(async()=>button(element,'保存').click())
  expect(button(element,'保存').disabled).toBe(true)
  await act(async()=>Array.from(element.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='重新加载最新单据')!.click())
  const comparison=element.querySelector('[aria-label="最新单据对照"]')!
  expect(comparison.textContent).toContain('服务器另一页的新备注')
  expect(comparison.textContent).toContain('本页未保存备注')
  expect(comparison.querySelectorAll('thead th')).toHaveLength(5)
  expect(comparison.querySelector('tfoot')).toBeNull()
  expect(button(element,'保存').disabled).toBe(true)
  expect(writes).toBe(1)
  if(choice==='保留'){
   await act(async()=>Array.from(comparison.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='确认保留本页修改')!.click())
   expect(writes).toBe(1)
   await act(async()=>button(element,'保存').click())
   expect(writes).toBe(2)
  }else{
   await act(async()=>Array.from(comparison.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='使用服务器最新内容')!.click())
   expect(element.querySelector<HTMLInputElement>('input[aria-label="单据备注"]')!.value).toBe('服务器另一页的新备注')
   expect(writes).toBe(1)
  }
 }finally{act(()=>root.unmount());element.remove()}
})

it('a query audit made legal by reload waits for the conflict comparison choice',async()=>{
 window.history.replaceState({},'','/?action=audit')
 let reads=0
 mock.mockImplementation(async(_path,init)=>{
  if(init?.method==='PUT')throw Object.assign(Error('单据已变化'),{status:409})
  return ++reads===1?original:{...original,approvalStatus:'PENDING',rowVersion:9}
 })
 const {element,root}=mount()
 try{
  await wait(()=>Boolean(element.querySelector('footer')))
  expect(element.querySelector('[role="dialog"]')).toBeNull()
  await act(async()=>button(element,'保存').click())
  await act(async()=>Array.from(element.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='重新加载最新单据')!.click())
  expect(element.querySelector('[aria-label="最新单据对照"]')).not.toBeNull()
  expect(element.querySelector('[role="dialog"]')).toBeNull()
  expect(mock.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true)
  await act(async()=>Array.from(element.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='使用服务器最新内容')!.click())
  await wait(()=>Boolean(element.querySelector('[role="dialog"]')))
  expect(element.querySelector('[role="dialog"]')?.textContent).toContain('审核')
  expect(mock.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true)
 }finally{act(()=>root.unmount());element.remove();window.history.replaceState({},'','/')}
})


it.each(['RECEIPT','RETURN'] as const)('%s unknown review freezes other actions and rechecks the exact original request',async kind=>{
 let rejectFirst=true,latest={...original,status:'DRAFT',approvalStatus:'AUDITED',rowVersion:2}
 mock.mockImplementation(async(path,init)=>{
  if(String(path).endsWith('/approval/review')){if(rejectFirst)throw new TypeError('审批响应连接失败');latest={...latest,status:'POSTED',approvalStatus:'REVIEWED',rowVersion:3};return {replayed:true} as any}
  return latest as any
 })
 const {element,root}=mount(kind);await wait(()=>Boolean(element.querySelector('footer')))
 const find=(label:string)=>[...element.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!
 act(()=>find('复审').click());await act(async()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
 expect(element.textContent).toContain('原审批结果待核对')
 expect(find('反审核').disabled).toBe(true)
 expect(button(element,'保存').disabled).toBe(true)
 const first=mock.mock.calls.find(([path,init])=>String(path).endsWith('/approval/review')&&init?.method==='POST')!
 act(()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click())
 rejectFirst=false;act(()=>find('核对原审批').click());await act(async()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
 const reviews=mock.mock.calls.filter(([path,init])=>String(path).endsWith('/approval/review')&&init?.method==='POST')
 expect(reviews).toHaveLength(2)
 expect(reviews[1][1]!.body).toBe(first[1]!.body)
 expect(mock.mock.calls.some(([path])=>String(path).endsWith('/approval/unconfirm'))).toBe(false)
 expect(element.textContent).toContain('已复审')
 act(()=>root.unmount());element.remove()
})


it.each([400,409])('unknown original approval receiving %s exits unknown and preserves correct recovery',async status=>{
 let first=true
 mock.mockImplementation(async(path,init)=>{
  if(init?.method==='POST'){if(first){first=false;throw new TypeError('连接失败')}throw Object.assign(new Error('明确拒绝'),{status})}
  return {...original,approvalStatus:'PENDING',rowVersion:1} as any
 })
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('footer')))
 const find=(text:string)=>[...element.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!
 act(()=>button(element,'审核').click());await act(async()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
 act(()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click())
 act(()=>find('核对原审批').click());await act(async()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
 expect(element.querySelector('[aria-label="原审批结果待核对"]')).toBeNull()
 expect(element.textContent).toContain('明确拒绝')
 expect(element.querySelector('[role="alert"]')?.textContent).not.toContain('原审批结果待核对')
 expect(button(element,'审核').disabled).toBe(status===409)
 if(status===409)expect(find('重新加载最新单据')).toBeDefined()
 const posts=mock.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(2);expect(posts[0][1]!.body).toBe(posts[1][1]!.body)
 act(()=>root.unmount());element.remove()
})

it('unknown approval is included in leaving protection even without dirty fields',async()=>{
 mock.mockImplementation(async(path,init)=>{if(init?.method==='POST')throw Object.assign(new Error('暂不可用'),{status:503});return {...original,approvalStatus:'PENDING',rowVersion:1} as any})
 const {element,root,close}=mount();await wait(()=>Boolean(element.querySelector('footer')))
 act(()=>button(element,'审核').click());await act(async()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
 act(()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click())
 act(()=>button(element,'取消').click())
 expect(element.querySelector('[role="dialog"]')?.textContent).toContain('原审批结果待核对')
 expect(close).not.toHaveBeenCalled()
 act(()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click())
 expect(mock.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1)
 act(()=>root.unmount());element.remove()
})

it('late A approval completion cannot close a new B confirmation',async()=>{
 let resolveA!:(value:any)=>void
 mock.mockImplementation(async(path,init)=>{
  if(init?.method==='POST')return new Promise(resolve=>{resolveA=resolve as any})
  return {...original,id:String(path).endsWith('/rc-2')?'rc-2':'rc-1',no:String(path).endsWith('/rc-2')?'QC-RC-2':'QC-RC-1',approvalStatus:'PENDING',rowVersion:1} as any
 })
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('footer')))
 act(()=>button(element,'审核').click());act(()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
 expect(resolveA).toBeDefined()
 act(()=>root.render(<ProcurementDocumentEditor kind="RECEIPT" sourceId="rc-2" onClose={()=>{}}/>))
 await wait(()=>Boolean(element.textContent?.includes('QC-RC-2')&&element.querySelector('footer')))
 act(()=>button(element,'审核').click());expect(element.querySelector('[role="dialog"][aria-label="审核"]')).not.toBeNull()
 await act(async()=>resolveA({approvalStatus:'AUDITED'}))
 expect(element.querySelector('[role="dialog"][aria-label="审核"]')).not.toBeNull()
 expect(mock.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1)
 act(()=>root.unmount());element.remove()
})


it('original approval recheck failing again retains its request, and ACK read failure requires only a reload',async()=>{
 let attempts=0,afterAck=false,readFail=true
 mock.mockImplementation(async(path,init)=>{
  if(init?.method==='POST'){attempts++;if(attempts<3)throw new TypeError('连接失败');afterAck=true;return {approvalStatus:'AUDITED'} as any}
  if(afterAck&&readFail)throw new Error('最新单据读取失败')
  return {...original,approvalStatus:afterAck?'AUDITED':'PENDING',rowVersion:afterAck?2:1} as any
 })
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('footer')))
 const find=(text:string)=>[...element.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!
 act(()=>button(element,'审核').click());await act(async()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
 for(let i=0;i<2;i++){
  act(()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click())
  act(()=>find('核对原审批').click());await act(async()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
 }
 const writes=mock.mock.calls.filter(([,init])=>init?.method==='POST');expect(writes).toHaveLength(3)
 expect(new Set(writes.map(([,init])=>init!.body)).size).toBe(1)
 expect(element.querySelector('[aria-label="原审批结果待核对"]')).toBeNull()
 expect(find('重新加载最新单据')).toBeDefined()
 expect(button(element,'保存').disabled).toBe(true)
 act(()=>element.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click())
 readFail=false;await act(async()=>find('重新加载最新单据').click())
 expect(element.querySelector('[aria-label="最新单据对照"]')).not.toBeNull()
 expect(mock.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(3)
 act(()=>root.unmount());element.remove()
})

it('detail totals follow decimal row edits and invalid input never turns into a zero total',async()=>{
 mock.mockResolvedValue({...original,lines:[{...original.lines[0],acceptedQty:1,unitPrice:0.1,payableAmount:0.1},{...original.lines[0],id:'line-2',acceptedQty:1,unitPrice:0.2,payableAmount:0.2}]})
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('tfoot')))
 try{
  const total=()=>element.querySelector('tfoot')!.textContent!
  expect(total()).toContain('2.000000');expect(total()).toContain('0.3000')
  change(element.querySelector('input[aria-label="1行quantity"]')!,'5')
  expect(total()).toContain('6.000000');expect(total()).toContain('0.7000')
  change(element.querySelector('input[aria-label="1行quantity"]')!,'')
  expect(total()).toContain('—');expect(mock.mock.calls.every(([,init])=>!init?.method)).toBe(true)
 }finally{act(()=>root.unmount());element.remove()}
})
