// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import TopNav from './_topnav'
import {apiFetch} from '@/lib/v2-auth'
import {loadInvoices} from '@/lib/invoice-list'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn(),getUser:()=>({name:'财务经办',role:'FINANCE'}),clearSession:vi.fn()}))
vi.mock('@/lib/invoice-list',()=>({loadInvoices:vi.fn()}))
vi.mock('next/navigation',()=>({usePathname:()=>'/v2/finance-pc/invoices'}))
vi.mock('next/link',()=>({default:({children,href,...rest}:any)=><a href={href} {...rest}>{children}</a>}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
it.each(['failed','zero'])('does not present a partial group badge when tracking is %s',async mode=>{
 Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false})})
 vi.mocked(loadInvoices).mockResolvedValue(Array.from({length:5},(_,i)=>({id:String(i)})))
 vi.mocked(apiFetch).mockImplementation(async url=>{
 if(String(url).includes('pending-from-finance')){if(mode==='failed')throw new Error('reference failure');return{summary:{paidCount:0}} as any}
 if(String(url).includes('payment-requests'))return{total:0} as any
 if(String(url).includes('/api/vouchers?'))return{items:[],total:0,page:1,pageSize:1} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<TopNav/>))
 const button=Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.startsWith('应付'))!;expect(button).toBeTruthy()
 if(mode==='failed')expect(button.textContent).not.toContain('5');else expect(button.textContent).toContain('5')
 await act(async()=>button.click());const target=host.querySelector('a[href="/v2/finance-pc/invoices-pending"]')!;expect(target.textContent).toContain('待开票跟踪')
 await act(async()=>root.unmount());host.remove()
})

it('uses all draft vouchers in the menu badge, beyond the first page',async()=>{
 Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false})})
 vi.mocked(loadInvoices).mockResolvedValue([])
 vi.mocked(apiFetch).mockImplementation(async url=>{
 const u=String(url)
 if(u.includes('/api/vouchers?'))return{items:[],total:201,page:1,pageSize:1} as any
 if(u.includes('pending-from-finance'))return{summary:{paidCount:0}} as any
 if(u.includes('payment-requests'))return{total:0} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<TopNav/>));const button=Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.startsWith('凭证'))!;expect(button.textContent).toContain('99+')}
 finally{await act(async()=>root.unmount());host.remove()}
})
