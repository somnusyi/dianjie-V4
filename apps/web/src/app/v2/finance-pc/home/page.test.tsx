// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn(),getUser:()=>({name:'财务经办'})}))
vi.mock('../_topnav',()=>({default:()=>null}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>,BlackHero:({value}:any)=><div data-testid="todo-count">{value}</div>}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
it('invoice tracking card keeps the complete count and exact cents from the shared summary',async()=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{
 if(String(url).includes('pending-from-finance'))return{summary:{paidCount:203,paidAmount:523.99,pendingCount:202,oldestPaidDays:370}} as any
 if(String(url).includes('payment-requests'))return{items:[],total:0} as any
 if(String(url).includes('cashbook/summary'))return{accounts:[],monthIncome:0,monthExpense:0,totalBalance:0} as any
 if(String(url).includes('/api/vouchers?'))return{items:[],total:0,page:1,pageSize:200} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 const card=host.querySelector('a[href="/v2/finance-pc/invoices-pending"]')!;expect(card.textContent).toContain('203');expect(card.textContent).toContain('¥523.99');expect(card.textContent).not.toContain('¥524')
 await act(async()=>root.unmount());host.remove()
})

it.each(['loading','failed','zero'])('keeps invoice card %s distinct from a completed zero',async mode=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{
 if(String(url).includes('pending-from-finance')){if(mode==='failed')throw new Error('reference failure');if(mode==='loading')return new Promise(()=>{});return{summary:{paidCount:0,paidAmount:0,pendingCount:0,oldestPaidDays:0}} as any}
 if(String(url).includes('payment-requests'))return{items:[],total:0} as any
 if(String(url).includes('cashbook/summary'))return{accounts:[],monthIncome:0,monthExpense:0,totalBalance:0} as any
 if(String(url).includes('/api/vouchers?'))return{items:[],total:0,page:1,pageSize:200} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 const card=host.querySelector('a[href="/v2/finance-pc/invoices-pending"]')!
 if(mode==='zero')expect(card.textContent).toContain('所有付款都收到发票了')
 else{expect(card.textContent).toContain('—');expect(card.textContent).not.toContain('所有付款都收到发票了');expect(card.textContent).toContain(mode==='failed'?'读取失败':'读取中')}
 await act(async()=>root.unmount());host.remove()
})

it('keeps an explicitly overdue unpaid schedule in the PC count and due row without paid history',async()=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{
 if(String(url).includes('/api/schedules?'))return[
 {id:'overdue',amount:'4',status:'OVERDUE',dueAt:'2026-01-01T00:00:00Z',supplier:{name:'青禾食材'},receipt:{no:'RK-OVERDUE',store:{name:'清源一店'}}},
 {id:'paid',amount:'99',status:'PAID',dueAt:'2026-01-01T00:00:00Z',supplier:{name:'青禾食材'},receipt:{no:'RK-PAID',store:{name:'清源一店'}}},
 ] as any
 if(String(url).includes('pending-from-finance'))return{summary:{paidCount:0,paidAmount:0,pendingCount:0,oldestPaidDays:0}} as any
 if(String(url).includes('payment-requests'))return{items:[],total:0} as any
 if(String(url).includes('cashbook/summary'))return{accounts:[],monthIncome:0,monthExpense:0,totalBalance:0} as any
 if(String(url).includes('/api/vouchers?'))return{items:[],total:0,page:1,pageSize:200} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>));expect(host.textContent).toContain('RK-OVERDUE');expect(host.textContent).not.toContain('RK-PAID');expect(host.querySelector('[data-testid="todo-count"]')?.textContent).toBe('1')}
 finally{await act(async()=>root.unmount());host.remove()}
})

it('includes a draft after the first 200 vouchers in the monthly card',async()=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{
 const u=String(url)
 if(u.includes('pending-from-finance'))return{summary:{paidCount:0,paidAmount:0}} as any
 if(u.includes('payment-requests'))return{items:[],total:0} as any
 if(u.includes('cashbook/summary'))return{accounts:[]} as any
 if(u.includes('/api/vouchers?')){const page=Number(new URL(u,'http://local').searchParams.get('page')||1);return{items:page===1?Array.from({length:200},(_,i)=>({id:'p-'+i,status:'POSTED'})):[{id:'last',status:'DRAFT'}],total:201,page,pageSize:200} as any}
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>));const card=host.querySelector('a[href="/v2/finance-pc/vouchers"]')!;expect(card.textContent).toContain('200 已审 / 1 草稿')}
 finally{await act(async()=>root.unmount());host.remove()}
})

it('a failed later voucher page cannot show a completed monthly card',async()=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{
 const u=String(url)
 if(u.includes('pending-from-finance'))return{summary:{paidCount:0,paidAmount:0}} as any
 if(u.includes('payment-requests'))return{items:[],total:0} as any
 if(u.includes('cashbook/summary'))return{accounts:[]} as any
 if(u.includes('/api/vouchers?')){if(u.includes('page=2'))throw new Error('后页失败');return{items:Array.from({length:200},(_,i)=>({id:'p-'+i,status:'POSTED'})),total:201,page:1,pageSize:200} as any}
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>));const card=host.querySelector('a[href="/v2/finance-pc/vouchers"]')!;expect(card.textContent).toContain('—');expect(card.textContent).toContain('读取失败');expect(card.textContent).not.toContain('200 已审');expect(card.textContent).not.toContain('尚未生成')}
 finally{await act(async()=>root.unmount());host.remove()}
})
