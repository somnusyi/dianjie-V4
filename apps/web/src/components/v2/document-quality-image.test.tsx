// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {beforeEach,it,expect,vi} from 'vitest'
import {DocumentQualityImageDialog,DocumentQualityImageButton,OrderLineQuality} from './document-quality-image'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
import {apiFetch} from '@/lib/v2-auth'
const mock=vi.mocked(apiFetch)
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
const initial={version:0,image:null,history:[],canWrite:true}
const uploaded={key:'warehouse-docs/test/one.png',name:'一.png',mime:'image/png',size:1,url:'http://local.invalid/one.png'}
function mount(){const host=document.createElement('div');const table=document.createElement('table');const row=table.insertRow();const cell=row.insertCell();cell.style.maxWidth='80px';cell.style.overflow='hidden';cell.append(host);document.body.append(table);const root=createRoot(host);const close=vi.fn();act(()=>root.render(<DocumentQualityImageDialog kind="WAREHOUSE" sourceId="doc-1" onClose={close}/>));const element=document.body.querySelector<HTMLElement>('[role=dialog][aria-label="单据质检图片"]')!;const unmount=root.unmount.bind(root);root.unmount=()=>{unmount();table.remove()};return{element,root,close}}
async function wait(condition:()=>boolean){for(let i=0;i<100;i++){if(condition())return;await act(async()=>{await new Promise(r=>setTimeout(r,5))})}throw Error('wait failed')}
async function upload(element:HTMLElement){const field=element.querySelector('input')!;Object.defineProperty(field,'files',{configurable:true,value:[new File(['x'],'一.png',{type:'image/png'})]});await act(async()=>field.dispatchEvent(new Event('change',{bubbles:true})))}
const save=(element:HTMLElement)=>Array.from(element.querySelectorAll('button')).find(button=>button.textContent==='保存图片')!
beforeEach(()=>{mock.mockReset()})
it('failed save preserves uploaded image and retry request; saving changes only image',async()=>{
 let writes=0
 mock.mockImplementation((path,init)=>String(path).startsWith('/api/upload')?Promise.resolve(uploaded):init?.method==='POST'?(++writes===1?Promise.reject(Error('网络失败')):Promise.resolve({version:1,image:{...uploaded,version:1,actorName:'供应链'}})):Promise.resolve(initial))
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('input')));await upload(element)
 expect(element.textContent).toContain('待保存：一.png');expect(element.textContent).not.toContain('合格')
 await act(async()=>save(element).click());expect(element.textContent).toContain('网络失败');expect(element.textContent).toContain('待保存：一.png');expect(element.querySelector('input')?.disabled).toBe(true);expect(element.querySelector<HTMLButtonElement>('[aria-label="移除待保存 一.png"]')?.disabled).toBe(true)
 await act(async()=>save(element).click())
 const calls=mock.mock.calls.filter(([,init])=>init?.method==='POST'&&typeof init.body==='string')
 expect(calls).toHaveLength(2);expect(calls[0][1]?.body).toEqual(calls[1][1]?.body)
 expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({version:0,images:[{key:uploaded.key,name:'一.png'}]})
 expect(JSON.parse(String(calls[0][1]?.body )).images[0]).not.toHaveProperty('url')
 expect(element.textContent).not.toContain('待保存');act(()=>root.unmount());element.remove()
})
it('conflict retains selected upload and requires successful explicit reload before overwriting',async()=>{
 let reads=0
 mock.mockImplementation((path,init)=>String(path).startsWith('/api/upload')?Promise.resolve(uploaded):init?.method==='POST'?Promise.reject(Object.assign(Error('别人已补图'),{status:409})):(++reads===2?Promise.reject(Error('最新图片加载失败')):Promise.resolve({...initial,version:reads===1?0:2})))
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('input')));await upload(element);await act(async()=>save(element).click())
 expect(save(element).disabled).toBe(true)
 const reload=()=>Array.from(element.querySelectorAll('button')).find(button=>button.textContent==='查看最新图片后重新保存')!
 await act(async()=>reload().click());expect(element.textContent).toContain('最新图片加载失败');expect(save(element).disabled).toBe(true)
 await act(async()=>reload().click());expect(save(element).disabled).toBe(false);expect(element.textContent).toContain('待保存：一.png')
 act(()=>root.unmount());element.remove()
})
it('read-only users can view images but have no upload or save controls',async()=>{
 mock.mockResolvedValue({...initial,canWrite:false,image:{name:'已有.png',url:'http://local.invalid/read.png',version:1,actorName:'供应链'},history:[]})
 const {element,root,close}=mount();await wait(()=>Boolean(element.querySelector('img')))
 expect(element.querySelector('input')).toBeNull();expect(save(element)).toBeUndefined()
 act(()=>Array.from(element.querySelectorAll('button')).find(button=>button.textContent==='关闭')!.click());expect(close).toHaveBeenCalledOnce()
 act(()=>root.unmount());element.remove()
})
it('successful old-request replay reloads the newest image rather than treating the old response as current',async()=>{
 let reads=0
 const newest={name:'第二人新图.png',mime:'image/png',size:1,url:'http://local.invalid/new.png',version:2,createdAt:'',actorName:'第二人'}
 mock.mockImplementation((path,init)=>String(path).startsWith('/api/upload')?Promise.resolve(uploaded):init?.method==='POST'?Promise.resolve({version:1,image:{...uploaded,version:1},replayed:true}):Promise.resolve(++reads===1?initial:{...initial,version:2,image:newest,history:[newest]}))
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('input')));await upload(element);await act(async()=>save(element).click())
 expect(element.querySelector('img')?.alt).toBe('第二人新图.png');expect(element.textContent).toContain('第二人');expect(reads).toBe(2)
 act(()=>root.unmount());element.remove()
})
it('after successful save and failed latest-image GET, retries only GET instead of saving again',async()=>{
 let reads=0
 mock.mockImplementation((path,init)=>String(path).startsWith('/api/upload')?Promise.resolve(uploaded):init?.method==='POST'?Promise.resolve({version:1,image:{...uploaded,version:1}}):++reads===2?Promise.reject(Error('GET失败')):Promise.resolve(initial))
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('input')));await upload(element);await act(async()=>save(element).click())
 expect(element.textContent).toContain('图片已保存，最新图片加载失败');expect(save(element)).toBeUndefined();expect(element.querySelector('input')?.disabled).toBe(true)
 await act(async()=>Array.from(element.querySelectorAll('button')).find(button=>button.textContent==='重新加载最新图片')!.click())
 expect(mock.mock.calls.filter(([,init])=>init?.method==='POST'&&typeof init.body==='string')).toHaveLength(1)
 expect(element.querySelector('input')?.disabled).toBe(false);act(()=>root.unmount());element.remove()
})
it('late response from the previous document cannot replace the new document image',async()=>{
 let resolveOld:(value:any)=>void=()=>{}
 mock.mockImplementation(path=>String(path).includes('/doc-1/')?new Promise(resolve=>{resolveOld=resolve}):Promise.resolve({...initial,canWrite:false,image:{name:'第二单.png',url:'http://local.invalid/two.png',version:1,actorName:'第二人'},history:[]}))
 const {element,root,close}=mount()
 act(()=>root.render(<DocumentQualityImageDialog kind="WAREHOUSE" sourceId="doc-2" onClose={close}/>))
 await wait(()=>element.textContent?.includes('第二单.png')||false)
 await act(async()=>resolveOld({...initial,image:{name:'第一单.png',url:'http://local.invalid/one.png'}}))
 expect(element.textContent).toContain('第二单.png');expect(element.textContent).not.toContain('第一单.png')
 act(()=>root.unmount());element.remove()
})

it('upload control escapes clipped table ancestors and opens the hidden file picker without saving',async()=>{
 mock.mockResolvedValue(initial)
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('input')))
 expect(element.parentElement).toBe(document.body)
 const button=Array.from(element.querySelectorAll('button')).find(button=>button.textContent==='添加图片')!
 const input=element.querySelector('input')!;const click=vi.spyOn(input,'click')
 expect(input.hidden).toBe(true);expect(button.style.whiteSpace).toBe('nowrap');expect(button.style.minWidth).toBe('100px')
 act(()=>button.click());expect(click).toHaveBeenCalledOnce()
 expect(mock.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true)
 act(()=>root.unmount());element.remove()
})
it('multi-select keeps successful uploads when one file fails, and appends without losing saved images',async()=>{
 const old={id:'a'.repeat(64),name:'原图.png',mime:'image/png',size:1,url:'http://local.invalid/old.png',version:1,createdAt:'',actorName:'供应链'}
 mock.mockImplementation((path,init)=>String(path).startsWith('/api/upload')?((init?.body as FormData).get('file') as File).name==='坏图.png'?Promise.reject(Error('上传失败')):Promise.resolve(uploaded):init?.method==='POST'?Promise.reject(Error('稍后重试')):Promise.resolve({...initial,version:1,images:[old]}))
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('input')))
 const field=element.querySelector('input')!;expect(field.multiple).toBe(true)
 Object.defineProperty(field,'files',{configurable:true,value:[new File(['x'],'一.png',{type:'image/png'}),new File(['x'],'坏图.png',{type:'image/png'})]})
 await act(async()=>field.dispatchEvent(new Event('change',{bubbles:true})))
 expect(element.textContent).toContain('原图.png');expect(element.textContent).toContain('待保存：一.png');expect(element.textContent).toContain('坏图.png：上传失败')
 await act(async()=>save(element).click())
 const body=JSON.parse(String(mock.mock.calls.find(([,init])=>init?.method==='POST'&&typeof init.body==='string')![1]?.body))
 expect(body.images).toEqual([{id:old.id},{key:uploaded.key,name:uploaded.name,mime:uploaded.mime,size:uploaded.size}])
 act(()=>root.unmount());element.remove()
})
it('conflict reload merges concurrent additions while preserving explicit removals',async()=>{
 const image=(id:string,name:string)=>({id:id.repeat(64),name,mime:'image/png',size:1,url:`http://local.invalid/${id}`,version:1,createdAt:'',actorName:'供应链'})
 const a=image('a','甲.png'),b=image('b','乙.png');let reads=0,writes=0
 mock.mockImplementation((path,init)=>String(path).startsWith('/api/upload')?Promise.resolve(uploaded):init?.method==='POST'?(++writes===1?Promise.reject(Object.assign(Error('版本冲突'),{status:409})):Promise.reject(Error('保留待保存'))):Promise.resolve({...initial,version:++reads,images:reads===1?[a]:[a,b]}))
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('input')))
 await act(async()=>element.querySelector<HTMLButtonElement>('[aria-label="移除 甲.png"]')!.click())
 await upload(element);await act(async()=>save(element).click())
 await act(async()=>Array.from(element.querySelectorAll('button')).find(button=>button.textContent==='查看最新图片后重新保存')!.click())
 expect(element.textContent).toContain('乙.png');expect(element.querySelector('img[alt="甲.png"]')).toBeNull()
 await act(async()=>save(element).click())
 const writesBody=mock.mock.calls.filter(([,init])=>init?.method==='POST'&&typeof init.body==='string').map(([,init])=>JSON.parse(String(init?.body)))
 expect(writesBody[1].images).toEqual([{id:b.id},{key:uploaded.key,name:uploaded.name,mime:uploaded.mime,size:uploaded.size}])
 act(()=>root.unmount());element.remove()
})

it('definitive validation rejection permits correcting selected images instead of locking the invalid request',async()=>{
 mock.mockImplementation((path,init)=>String(path).startsWith('/api/upload')?Promise.resolve(uploaded):init?.method==='POST'?Promise.reject(Object.assign(Error('图片校验失败'),{status:400})):Promise.resolve(initial))
 const {element,root}=mount();await wait(()=>Boolean(element.querySelector('input')));await upload(element);await act(async()=>save(element).click())
 expect(element.querySelector('input')?.disabled).toBe(false)
 const remove=element.querySelector<HTMLButtonElement>('[aria-label="移除待保存 一.png"]')!;expect(remove.disabled).toBe(false)
 await act(async()=>remove.click());expect(element.textContent).not.toContain('待保存：一.png')
 act(()=>root.unmount());element.remove()
})
it('batch image uploads use the occurrence-scoped endpoint instead of warehouse attachments',async()=>{
 mock.mockImplementation((path,init)=>String(path).endsWith('/images')?Promise.resolve(uploaded):init?.method==='POST'?Promise.reject(Error('保留输入')):Promise.resolve(initial))
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 act(()=>root.render(<DocumentQualityImageDialog kind="BATCH" sourceId="S:batch-one" onClose={()=>{}}/>))
 const element=document.body.querySelector<HTMLElement>('[role=dialog]')!;await wait(()=>Boolean(element.querySelector('input')));await upload(element)
 expect(mock.mock.calls.some(([path])=>path==='/api/upstream/quality-batches/S%3Abatch-one/images')).toBe(true)
 expect(mock.mock.calls.some(([path])=>String(path).startsWith('/api/upload'))).toBe(false)
 act(()=>root.unmount());host.remove()
})
it('unassigned old document pictures are explicitly read-only even for a write-capable user',async()=>{
 mock.mockResolvedValue({...initial,canWrite:true,image:{name:'原整单.png',url:'http://local.invalid/old.png',actorName:'供应链',version:1},history:[]})
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 act(()=>root.render(<DocumentQualityImageDialog kind="RECEIPT" sourceId="old" readOnly onClose={()=>{}}/>))
 const element=document.body.querySelector<HTMLElement>('[role=dialog]')!;await wait(()=>Boolean(element.querySelector('img')))
 expect(element.textContent).toContain('原整单图片尚未分配到商品');expect(element.querySelector('input')).toBeNull();expect(save(element)).toBeUndefined()
 act(()=>root.unmount());host.remove()
})

it('document quality entry selects a goods occurrence; separate arrivals of the same product remain separate',async()=>{
 const groups=[{key:'S:first',productName:'土豆',quantity:'2',unit:'kg',sourceNo:'第一批',batchNo:'LOT1',imageCount:1},{key:'S:second',productName:'土豆',quantity:'3',unit:'kg',sourceNo:'第二批',batchNo:'LOT2',imageCount:0},{key:'S:third',productName:'菌菇',quantity:'1',unit:'kg',sourceNo:'第一批',imageCount:0}]
 mock.mockImplementation(path=>String(path).endsWith('/quality-batches')?Promise.resolve({groups,legacyAvailable:true,legacyOnly:false}):Promise.resolve(initial))
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 act(()=>root.render(<DocumentQualityImageButton kind="ORDER" sourceId="order-one" initialOpen/>))
 await wait(()=>document.body.textContent?.includes('第二批')||false)
 const choose=document.body.querySelector<HTMLButtonElement>('[aria-label="土豆 质检图片 2"]')!
 expect(choose).not.toBeNull();await act(async()=>choose.click())
 expect(mock.mock.calls.some(([path])=>path==='/api/upstream/quality-batches/S%3Asecond')).toBe(true)
 expect(mock.mock.calls.some(([path])=>path==='/api/upstream/quality-batches/S%3Afirst')).toBe(false)
 act(()=>root.unmount());host.remove()
})
it('quality window shows goods code and batch separately under the simple image title',async()=>{
 mock.mockResolvedValue({...initial,batch:{productName:'土豆',productCode:'P001',batchNo:'PC001',sourceNo:'USH001'}})
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 act(()=>root.render(<DocumentQualityImageDialog kind="BATCH" sourceId="S:first" onClose={()=>{}}/>))
 const element=document.body.querySelector<HTMLElement>('[role=dialog]')!;await wait(()=>Boolean(element.querySelector('input')))
 expect(element.querySelector('h2')?.textContent).toBe('质检图片');expect(element.textContent).toContain('商品编号：P001');expect(element.textContent).toContain('批次号：PC001');expect(element.textContent).not.toContain('本次进货质检')
 act(()=>root.unmount());host.remove()
})

it('row quality opens the exact incoming product directly without the picker',async()=>{
 mock.mockResolvedValue({...initial,batch:{productName:'菌菇',productCode:'P001',batchNo:'PC001',sourceNo:'USH001'},images:[]})
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 act(()=>root.render(<DocumentQualityImageButton kind="BATCH" sourceId="R:receipt-line-1"/>))
 await act(async()=>host.querySelector('button')!.click())
 await wait(()=>document.body.textContent?.includes('PC001')||false)
 expect(mock.mock.calls[0][0]).toBe('/api/upstream/quality-batches/R%3Areceipt-line-1')
 expect(document.querySelector('[aria-label="选择质检商品"]')).toBeNull()
 act(()=>root.unmount());host.remove()
})
it('order row displays its own arrival buttons and opens the selected batch directly',async()=>{
 mock.mockImplementation(path=>String(path).endsWith('/quality-batches')?Promise.resolve({groups:[{key:'S:one',purchaseOrderLineId:'line-1',batchNo:'PC001'},{key:'S:two',purchaseOrderLineId:'line-1',batchNo:'PC002'},{key:'S:other',purchaseOrderLineId:'line-2',batchNo:'OTHER'}]}):Promise.resolve(initial))
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 act(()=>root.render(<OrderLineQuality orderId="order-1" lineId="line-1"/>))
 await wait(()=>host.textContent?.includes('PC002')||false)
 expect(host.textContent).not.toContain('OTHER')
 await act(async()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent?.includes('PC002'))!.click())
 expect(mock.mock.calls.some(([path])=>path==='/api/upstream/quality-batches/S%3Atwo')).toBe(true)
 expect(document.querySelector('[aria-label="选择质检商品"]')).toBeNull()
 act(()=>root.unmount());host.remove()
})
