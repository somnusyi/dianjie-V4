// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn(),getToken:vi.fn()}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
it('failed second page is not an empty invoice history or zero pending orders',async()=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{if(String(url).includes('pending-payable'))return [] as any;if(String(url).includes('cursor='))throw new Error('后续发票读取失败');return Array.from({length:50},(_,i)=>({id:`i${i}`})) as any})
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 expect(host.textContent).toContain('后续发票读取失败');expect(host.textContent).not.toContain('暂无上传的发票');expect(host.textContent).not.toContain('暂无待开票订单');expect(host.textContent).not.toContain('0 张');expect(host.textContent).not.toContain('加载中…')
 await act(async()=>root.unmount());host.remove()
})

afterEach(()=>{vi.unstubAllGlobals();document.body.innerHTML=''})
it('same-number rejected upload sends the shown upload version for a new review round',async()=>{
 const version='2026-10-20T00:00:00.000Z'
 vi.mocked(apiFetch).mockImplementation(async url=>String(url).includes('pending-payable')?[{id:'receipt',no:'RK001',totalAmount:'61.43',deliveryDate:'2026-10-20'}]:[{id:'invoice',invoiceNo:'202610200001',status:'REJECTED',amount:'61.43',issueDate:'2026-10-20',uploadedAt:version,fileUrl:'',fileType:'image',reviewNote:'补清晰图'}] as any)
 const post=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal('fetch',post)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 await act(async()=>Array.from(host.querySelectorAll('li')).find(x=>x.textContent?.includes('RK001'))!.click())
 await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='上传发票 · 1 单 ¥61.43')!.click())
 await act(async()=>{const no=host.querySelector('input[placeholder="12 位"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(no,'202610200001');no.dispatchEvent(new Event('input',{bubbles:true}));const file=host.querySelector('input[type="file"]')!;Object.defineProperty(file,'files',{value:[new File(['reference'],'invoice.png',{type:'image/png'})]});file.dispatchEvent(new Event('change',{bubbles:true}))})
 await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='提交 · 关联 1 单')!.click())
 expect(post).toHaveBeenCalledTimes(1);expect((post.mock.calls[0][1].body as FormData).get('expectedUploadedAt')).toBe(version)
 await act(async()=>root.unmount());host.remove()
})

it('loaded empty invoice history shows known zero status counts',async()=>{
 vi.mocked(apiFetch).mockResolvedValue([] as any)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 expect(host.textContent).toContain('0 张');expect(host.textContent).toContain('暂无上传的发票');expect(host.textContent).toContain('待审核0');expect(host.textContent).toContain('已通过0');expect(host.textContent).not.toContain('—')
 await act(async()=>root.unmount());host.remove()
})
