// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWarehouseInboundDraft } from './use-warehouse-inbound-draft'
const mocks=vi.hoisted(()=>({api:vi.fn(),user:{id:'supplier-fixture'}}))
vi.mock('./v2-auth',()=>({apiFetch:mocks.api,getUser:()=>mocks.user}))
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
let hook:ReturnType<typeof useWarehouseInboundDraft>, restored:any, root:Root, container:HTMLDivElement
let server:any=null, failSave=false, failGet=false, writes:any[]=[]
let currentPayload:any={mode:'SINGLE',note:'initial'}, open=true
function Harness(){hook=useWarehouseInboundDraft('SINGLE',open,currentPayload,value=>{restored=value});return <span>{hook.status}|{hook.failure}</span>}
it('keeps the original reconfirmation body and key after a success response is lost',async()=>{
 await render();await act(async()=>hook.flush())
 const base=mocks.api.getMockImplementation()!,requests:any[]=[]
 mocks.api.mockImplementation(async(path:string,init:any)=>{
  const body=init?.method==='PUT'?JSON.parse(init.body):null
  if(body?.reconfirmSnapshot){
   requests.push(body)
   if(requests.length===1){await base(path,init);throw Error('confirmation response lost')}
   return {draft:server}
  }
  return base(path,init)
 })
 await act(async()=>{await expect(hook.flush(true)).rejects.toThrow('response lost')})
 expect(hook.reconfirmPending).toBe(true)
 expect(JSON.parse(localStorage.getItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE:reconfirmation')!).body).toEqual(requests[0])
 currentPayload={...currentPayload,note:'do not replace the original request'};await render()
 await act(async()=>{await expect(hook.flush()).rejects.toThrow('核对原请求')})
 await act(async()=>hook.flush(true))
 expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0])
 expect(hook.reconfirmPending).toBe(false)
 expect(writes).toHaveLength(2)
})
it('reloads an uncertain reconfirmation before offering to write a replacement draft',async()=>{
 const body={baseVersion:1,payload:{mode:'SINGLE',note:'original uncertain confirmation'},reconfirmSnapshot:true,reconfirmRequestId:'original-reconfirm-request'}
 localStorage.setItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE:reconfirmation',JSON.stringify({draftId:'original-draft',body}))
 server={id:'original-draft',version:2,payload:{mode:'SINGLE',note:'original uncertain confirmation'},status:'EDITING'}
 await render()
 expect(restored.note).toBe('original uncertain confirmation')
 expect(hook.reconfirmPending).toBe(true);expect(writes).toHaveLength(0)
 mocks.api.mockImplementation(async(_path:string,init:any)=>{expect(JSON.parse(init.body)).toEqual(body);return {draft:server}})
 await act(async()=>hook.flush(true))
 expect(hook.reconfirmPending).toBe(false)
 expect(localStorage.getItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE:reconfirmation')).toBeNull()
})
it('pending confirmation is restored even when reading the active draft would fail',async()=>{
 const body={baseVersion:1,payload:{mode:'SINGLE',note:'pending before GET'},reconfirmSnapshot:true,reconfirmRequestId:'pending-before-read'}
 localStorage.setItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE:reconfirmation',JSON.stringify({draftId:'draft-before-read',body}))
 failGet=true;await render()
 expect(hook.reconfirmPending).toBe(true);expect(hook.ready).toBe(true)
 expect(restored.note).toBe('pending before GET')
 expect(mocks.api.mock.calls.filter(([,init])=>!init)).toHaveLength(0)
 await act(async()=>{await expect(hook.reload(true)).rejects.toThrow('先核对原单位请求')})
 expect(writes).toHaveLength(0)
})
it('discarded confirmation replay closes restoration and cannot generate a replacement draft',async()=>{
 const body={baseVersion:1,payload:{mode:'SINGLE',note:'discarded source'},reconfirmSnapshot:true,reconfirmRequestId:'discarded-confirmation-key'}
 localStorage.setItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE:reconfirmation',JSON.stringify({draftId:'discarded-draft',body}))
 server={id:'discarded-draft',version:3,payload:{mode:'SINGLE',note:'discarded source'},status:'DISCARDED',reconfirmationReceipt:{requestId:body.reconfirmRequestId,resultVersion:2,currentStatus:'DISCARDED',requiresReload:true}}
 await render();mocks.api.mockResolvedValue({draft:server})
 await act(async()=>hook.flush(true))
 expect(hook.terminalStatus).toBe('DISCARDED');expect(hook.ready).toBe(false)
 expect(hook.status).toContain('已丢弃')
 await act(async()=>{await expect(hook.reload(true)).rejects.toThrow('该草稿已结束')})
 expect(writes).toHaveLength(0)
})
it('reports the original success but blocks automatic writes if a later draft version exists',async()=>{
 const body={baseVersion:1,payload:{mode:'SINGLE',note:'old confirmed content'},reconfirmSnapshot:true,reconfirmRequestId:'older-confirmation-request'}
 localStorage.setItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE:reconfirmation',JSON.stringify({draftId:'draft-with-newer-version',body}))
 server={id:'draft-with-newer-version',version:3,payload:{mode:'SINGLE',note:'newer server content'},status:'EDITING',reconfirmationReceipt:{requestId:body.reconfirmRequestId,resultVersion:2,currentStatus:'EDITING',requiresReload:true}}
 await render()
 mocks.api.mockImplementation(async(_path:string,init:any)=>{expect(JSON.parse(init.body)).toEqual(body);return {draft:server}})
 await act(async()=>hook.flush(true))
 expect(hook.status).toContain('原核对已成功')
 expect(hook.ready).toBe(false);expect(restored.note).toBe('old confirmed content')
 await act(async()=>{await expect(hook.flush()).rejects.toThrow('尚未加载')})
 expect(writes).toHaveLength(0)
})
it('a late manual reload cannot overwrite a draft reopened while its request was waiting',async()=>{
 await render();const base=mocks.api.getMockImplementation()!
 let resolveRead!:(value:any)=>void,waiting!:Promise<void>
 mocks.api.mockImplementation((path:string,init:any)=>!init?new Promise(resolve=>{resolveRead=resolve}):base(path,init))
 await act(async()=>{waiting=hook.reload(false);await Promise.resolve()})
 expect(hook.reloading).toBe(true)
 open=false;await render()
 mocks.api.mockImplementation(base)
 server={id:'reopened',version:5,payload:{mode:'SINGLE',note:'newly reopened'},status:'EDITING'}
 open=true;await render()
 expect(restored.note).toBe('newly reopened')
 await act(async()=>{resolveRead({draft:{id:'old-late',version:2,payload:{mode:'SINGLE',note:'stale late input'},status:'EDITING'}});await waiting})
 expect(restored.note).toBe('newly reopened')
 expect(hook.reloading).toBe(false)
})
it('manual replace refuses to overwrite input typed during the read',async()=>{
 await render();const base=mocks.api.getMockImplementation()!
 let resolveRead!:(value:any)=>void,waiting!:Promise<void>
 mocks.api.mockImplementation((path:string,init:any)=>!init?new Promise(resolve=>{resolveRead=resolve}):base(path,init))
 await act(async()=>{waiting=hook.reload(false);await Promise.resolve()})
 currentPayload={...currentPayload,note:'typed while loading'};await render()
 await act(async()=>{resolveRead({draft:{id:'server',version:2,payload:{mode:'SINGLE',note:'server replacement'},status:'EDITING'}});await expect(waiting).rejects.toThrow('读取期间有新输入')})
 expect(currentPayload.note).toBe('typed while loading')
 expect(restored).toBeUndefined();expect(writes).toHaveLength(0)
})
it('receives server snapshot metadata without replacing the entered draft payload',async()=>{
 const base=mocks.api.getMockImplementation()!
 const snapshot={version:1,warehouse:{id:'original-warehouse'},products:[]}
 mocks.api.mockImplementation(async(path:string,init:any)=>{
  const result=await base(path,init)
  if(init?.method==='PUT')result.draft.payload={...result.draft.payload,executionSnapshot:snapshot}
  return result
 })
 await render();await act(async()=>hook.flush())
 expect(hook.snapshot).toEqual(snapshot)
 expect(currentPayload).toEqual({mode:'SINGLE',note:'initial'})
 expect(restored).toBeUndefined()
})
async function render(){await act(async()=>root.render(<Harness/>))}
beforeEach(()=>{
 mocks.api.mockReset()
 localStorage.clear();localStorage.setItem('tenant',JSON.stringify({id:'tenant-fixture'}));mocks.user.id='supplier-fixture'
 restored=undefined;server=null;failSave=false;failGet=false;writes=[];open=true;currentPayload={mode:'SINGLE',note:'initial'}
 mocks.api.mockImplementation(async(path:string,init:any)=>{
  if(!init){if(failGet)throw Error('read network failure');return {draft:server}}
  const body=JSON.parse(init.body)
  if(init.method==='PUT'){
   if(failSave)throw Error('write network failure')
   if(server && body.baseVersion!==server.version)throw Error('version conflict')
   writes.push(body);server={id:path.split('/').pop(),version:(server?.version||0)+1,payload:body.payload,status:'EDITING'};return {draft:server}
  }
  return {ok:true}
 })
 container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());container.remove()})
describe('server inbound draft recovery',()=>{
 it('persists raw incomplete/manual values and restores them after reopening without posting',async()=>{
  currentPayload={mode:'SINGLE',purchaseQuantity:'',totalAmount:'7.25',priceSource:'manual',amountSource:'manual',note:'not submitted'}
  await render();await act(async()=>{await hook.flush()});expect(writes[0].payload).toEqual(currentPayload)
  open=false;await render();open=true;currentPayload={mode:'SINGLE',note:''};await render()
  expect(restored).toMatchObject({totalAmount:'7.25',purchaseQuantity:'',priceSource:'manual',note:'not submitted'})
  expect(mocks.api.mock.calls.some(([p])=>String(p).includes('/submit'))).toBe(false)
 })
 it('failed writes retain the owner-scoped pending input and never report synchronized',async()=>{
  await render();failSave=true;await act(async()=>{await expect(hook.flush()).rejects.toThrow('write network')})
  expect(hook.status).toBe('草稿未同步');expect(hook.failure).toContain('write network')
  const cached=JSON.parse(localStorage.getItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE')!)
  expect(cached.payload.note).toBe('initial');expect(server).toBeNull()
 })
 it('GET failure blocks saving rather than creating an empty replacement',async()=>{
  failGet=true;await render();expect(hook.ready).toBe(false)
  await act(async()=>{await expect(hook.flush()).rejects.toThrow('尚未加载')})
  expect(writes).toHaveLength(0)
 })
 it('version conflict preserves local input and explicit reload adopts the server version',async()=>{
  server={id:'server-draft',version:2,payload:{mode:'SINGLE',note:'new server'},status:'EDITING'}
  localStorage.setItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE',JSON.stringify({id:'server-draft',version:1,payload:{mode:'SINGLE',note:'old unsynced'}}))
  await render();expect(restored.note).toBe('old unsynced');expect(hook.ready).toBe(false)
  await act(async()=>{await hook.reload(false)})
  expect(restored.note).toBe('new server');expect(writes).toHaveLength(0);expect(hook.ready).toBe(true)
 })
 it('resolves a submitted pending draft after response loss and reload without another write',async()=>{
  localStorage.setItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE',JSON.stringify({id:'submitted-draft',version:2,payload:{mode:'SINGLE',note:'uncertain response'}}))
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/submitted-draft')?{draft:{id:'submitted-draft',status:'SUBMITTED',docId:'original-receipt'}}:{draft:null})
  await render();expect(hook.submittedDocId).toBe('original-receipt');expect(hook.ready).toBe(false)
  await act(async()=>{await expect(hook.flush()).rejects.toThrow('已提交')});expect(writes).toHaveLength(0)
  expect(localStorage.getItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE')).toBeNull()
 })
 it('completed drafts cannot be re-saved by late autosave and account switches cannot write',async()=>{
  await render();await act(async()=>{await hook.flush()});await act(async()=>{hook.completed()})
  await act(async()=>{await expect(hook.flush()).rejects.toThrow('已提交或丢弃')})
  expect(localStorage.getItem('warehouse-inbound-pending:tenant-fixture:supplier-fixture:SINGLE')).toBeNull();expect(writes).toHaveLength(1)
  open=false;await render();open=true;await render();mocks.user.id='different-fixture'
  await act(async()=>{await expect(hook.flush()).rejects.toThrow('账号已切换')});expect(writes).toHaveLength(1)
 })
})
