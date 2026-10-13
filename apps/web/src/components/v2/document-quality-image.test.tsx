// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {beforeEach,it,expect,vi} from 'vitest'
import {DocumentQualityImageDialog} from './document-quality-image'
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
 await act(async()=>save(element).click());expect(element.textContent).toContain('网络失败');expect(element.textContent).toContain('待保存：一.png')
 await act(async()=>save(element).click())
 const calls=mock.mock.calls.filter(([,init])=>init?.method==='POST'&&typeof init.body==='string')
 expect(calls).toHaveLength(2);expect(calls[0][1]?.body).toEqual(calls[1][1]?.body)
 expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({version:0,image:{key:uploaded.key,name:'一.png'}})
 expect(JSON.parse(String(calls[0][1]?.body)).image).not.toHaveProperty('url')
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
