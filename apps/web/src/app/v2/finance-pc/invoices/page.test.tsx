// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('../_topnav',()=>({default:()=>null}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>}))
vi.mock('@/lib/ui-dialogs',()=>({notifyUser:vi.fn()}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
let root:ReturnType<typeof createRoot>,host:HTMLDivElement
const invoice={id:'one',invoiceNo:'FP001',amount:'1.23',status:'PENDING',issueDate:'2026-10-20',uploadedAt:'2026-10-20',fileUrl:'',fileType:'image',supplier:{name:'云岭食材'},uploadedBy:{name:'经办'},receipts:[],payments:[]}
const buttons=()=>Array.from(host.querySelectorAll('button'))
async function render(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Page/>))}
beforeEach(()=>{vi.mocked(apiFetch).mockReset()})
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML=''})
it('later-page failure leaves totals unknown and a visible error, not zero or loading forever',async()=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{if(String(url).includes('cursor='))throw new Error('后续发票读取失败');return Array.from({length:50},(_,i)=>({...invoice,id:`i${i}`})) as any})
 await render();expect(host.textContent).toContain('后续发票读取失败');expect(host.textContent).toContain('待审 —');expect(host.textContent).not.toContain('加载中…');expect(host.textContent).not.toContain('待审 0')
})
it('locks filter changes while approval is pending so old action cannot reload into a new filter',async()=>{
 let done!:(v:any)=>void;const pending=new Promise(r=>done=r)
 vi.mocked(apiFetch).mockImplementation((url,options)=>options?.method==='PATCH'?pending:Promise.resolve([invoice]) as any)
 await render();const approve=buttons().find(x=>x.textContent?.includes('审核通过'))??buttons().find(x=>x.textContent?.includes('通过')&&!x.textContent?.includes('已通过'))
 expect(approve).toBeDefined();await act(async()=>approve!.click())
 const filters=buttons().filter(x=>/^(待审 |已通过 |已驳回 |全部)/.test(x.textContent||''));expect(filters.length).toBe(4);expect(filters.every(x=>x.disabled)).toBe(true)
 expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls.find(x=>x[1]?.method==='PATCH')![1]!.body))).toMatchObject({expectedUploadedAt:invoice.uploadedAt})
 await act(async()=>filters[1].click());await act(async()=>done({ok:true}));expect(filters.every(x=>!x.disabled)).toBe(true)
 expect(vi.mocked(apiFetch).mock.calls.filter(x=>String(x[0]).includes('status=VERIFIED'))).toHaveLength(0)
})

it('invoice list and pending amount retain cents consistently with detail',async()=>{
 vi.mocked(apiFetch).mockResolvedValue([invoice] as any);await render();expect(host.textContent).toContain('¥1.23');expect(host.textContent?.match(/¥1\.23/g)?.length).toBeGreaterThanOrEqual(3)
})

it('status tabs filter rows and selected detail without resetting global counts',async()=>{
 const approved={...invoice,id:'two',invoiceNo:'FP002',status:'VERIFIED'}
 vi.mocked(apiFetch).mockResolvedValue([invoice,approved] as any);await render()
 expect(buttons().find(x=>x.textContent==='待审 1')).toBeDefined();expect(buttons().find(x=>x.textContent==='已通过 1')).toBeDefined()
 expect(host.querySelector('ul')?.textContent).toContain('FP001');expect(host.querySelector('ul')?.textContent).not.toContain('FP002')
 await act(async()=>buttons().find(x=>x.textContent==='已通过 1')!.click())
 expect(buttons().find(x=>x.textContent==='待审 1')).toBeDefined();expect(host.querySelector('ul')?.textContent).toContain('FP002');expect(host.querySelector('ul')?.textContent).not.toContain('FP001');expect(host.querySelector('section')?.textContent).toContain('FP002')
})

it('search matches select their own detail; no match and empty status remove old review controls',async()=>{
 const second={...invoice,id:'two',invoiceNo:'FP002'};vi.mocked(apiFetch).mockResolvedValue([invoice,second] as any);await render()
 const search=host.querySelector('input[placeholder="搜索 (发票号 / 供应商 / 上传人)"]')!
 const type=async(text:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,text);search.dispatchEvent(new Event('input',{bubbles:true}))})
 await type('FP002');expect(host.querySelector('section')?.textContent).toContain('FP002');expect(host.querySelector('section')?.textContent).not.toContain('FP001')
 await type('不存在');expect(host.querySelector('section')).toBeNull();expect(buttons().find(x=>x.textContent?.includes('通过 →'))).toBeUndefined()
 await type('');await act(async()=>buttons().find(x=>x.textContent==='已驳回 0')!.click());expect(host.querySelector('section')).toBeNull();expect(buttons().find(x=>x.textContent?.includes('通过 →'))).toBeUndefined()
})
