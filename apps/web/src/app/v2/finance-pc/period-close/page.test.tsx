// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('../_topnav',()=>({default:()=>null}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>}))
vi.mock('@/lib/ui-dialogs',()=>({confirmDialog:vi.fn(),notifyUser:vi.fn()}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
it.each(['failed','zero','complete'])('invoice checklist handles %s without false completion or changing its optional status',async mode=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{
 if(String(url).includes('pending-from-finance')){if(mode==='failed')throw new Error('reference failure');return{summary:{paidCount:mode==='zero'?0:203}} as any}
 if(String(url).includes('/api/payment-requests'))return{total:0} as any
 if(String(url).includes('/api/finance/cost-check'))return{total:{count:0,allVerifiedCount:0}} as any
 if(String(url).includes('/api/vouchers?'))return{items:[],total:0,page:1,pageSize:1} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 const card=host.querySelector('a[href="/v2/finance-pc/invoices-pending"]')!
 if(mode==='failed'){expect(card.textContent).toContain('读取失败');expect(card.textContent).not.toContain('已完成')}
 if(mode==='zero')expect(card.textContent).toContain('已完成')
 if(mode==='complete'){expect(card.textContent).toContain('203');expect(card.textContent).not.toContain('已完成')}
 expect(host.textContent).toContain('待开票不阻塞')
 await act(async()=>root.unmount());host.remove()
})

it.each([
 ['/api/payment-requests','/v2/finance-pc/payment-requests'],
 ['/api/finance/cost-check','/v2/finance-pc/cost-check'],
 ['/api/petty-cash','/v2/finance-pc/petty-cash'],
 ['/api/payroll','/v2/finance-pc/payroll'],
 ['/api/vouchers?','/v2/finance-pc/vouchers'],
])('required checklist source %s fails as unknown rather than complete',async (failed,href)=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{
 const u=String(url); if(u.includes(failed))throw new Error('reference unavailable')
 if(u.includes('pending-from-finance'))return{summary:{paidCount:0}} as any
 if(u.includes('/api/payment-requests'))return{total:0} as any
 if(u.includes('/api/finance/cost-check'))return{total:{count:0,allVerifiedCount:0}} as any
 if(u.includes('/api/vouchers?'))return{items:[],total:0,page:1,pageSize:1} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try {
 await act(async()=>root.render(<Page/>))
 const card=host.querySelector(`a[href="${href}"]`)!
 expect(card.textContent).toContain('读取失败');expect(card.textContent).not.toContain('已完成')
 expect(host.textContent).toContain('待核实');expect(host.textContent).not.toContain('5 / 5')
 }finally{await act(async()=>root.unmount());host.remove()}
})

it.each([0,2])('successful required counts remain accurate with %s cost checks',async remaining=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{
 const u=String(url)
 if(u.includes('pending-from-finance'))return{summary:{paidCount:203}} as any
 if(u.includes('/api/payment-requests'))return{total:0} as any
 if(u.includes('/api/finance/cost-check'))return{total:{count:remaining,allVerifiedCount:0}} as any
 if(u.includes('/api/vouchers?'))return{items:[],total:0,page:1,pageSize:1} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>))
 expect(host.textContent).toContain(remaining?'4 / 5':'5 / 5')
 expect(host.textContent).not.toContain('读取失败');expect(host.textContent).not.toContain('待核实')
 expect(host.querySelector('a[href="/v2/finance-pc/cost-check"]')!.textContent).toContain(remaining?'2':'已完成')
 expect(host.textContent).toContain('待开票不阻塞')
 }finally{await act(async()=>root.unmount());host.remove()}
})


it.each(['pending','failed'])('period-state %s cannot expose invented OPEN rows or closing actions',async mode=>{
 vi.clearAllMocks();let resolve!:(v:any)=>void;const pending=new Promise(r=>resolve=r)
 vi.mocked(apiFetch).mockImplementation(async url=>{
 const u=String(url)
 if(u==='/api/vouchers/periods'){if(mode==='failed')throw new Error('期间状态不可读取');return pending as any}
 if(u.includes('pending-from-finance'))return{summary:{paidCount:0}} as any
 if(u.includes('/api/payment-requests'))return{total:0} as any
 if(u.includes('/api/finance/cost-check'))return{total:{count:0,allVerifiedCount:0}} as any
 if(u.includes('/api/vouchers?'))return{items:[],total:0,page:1,pageSize:1} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>))
 expect(host.querySelectorAll('tbody button')).toHaveLength(0)
 expect(host.querySelector('tbody')?.textContent).not.toContain('未锁')
 if(mode==='failed'){expect(host.textContent).toContain('期间状态不可读取');expect(host.querySelector('tbody')?.textContent).not.toContain('加载中')}
 else{expect(host.querySelector('tbody')?.textContent).toContain('加载中');await act(async()=>resolve([{id:'period',month:'2026-09',status:'CLOSED',closedAt:'2026-10-22T10:00:00Z',createdAt:'2026-10-22T10:00:00Z',updatedAt:'2026-10-22T10:00:00Z'}]));const row=Array.from(host.querySelectorAll('tbody tr')).find(x=>x.textContent?.includes('2026-09'))!;expect(row.textContent).toContain('已关账');expect(Array.from(row.querySelectorAll('button')).map(x=>x.textContent)).toEqual(['预览结转','重开'])}
 for(const [,options]of vi.mocked(apiFetch).mock.calls)expect(options).toBeUndefined()
 }finally{await act(async()=>root.unmount());host.remove()}
})

it('uses the server draft total beyond the first page',async()=>{
 vi.mocked(apiFetch).mockImplementation(async url=>{
 const u=String(url)
 if(u.includes('/api/vouchers?'))return{items:[{id:'first'}],total:201,page:1,pageSize:1} as any
 if(u.includes('pending-from-finance'))return{summary:{paidCount:0}} as any
 if(u.includes('payment-requests'))return{total:0} as any
 if(u.includes('cost-check'))return{total:{count:0,allVerifiedCount:0}} as any
 return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>));expect(host.querySelector('a[href="/v2/finance-pc/vouchers"]')?.textContent).toContain('201')}
 finally{await act(async()=>root.unmount());host.remove()}
})

it('prepares a selected month separately from closing and retains server failures',async()=>{
 const {notifyUser}=await import('@/lib/ui-dialogs')
 vi.clearAllMocks()
 vi.mocked(apiFetch).mockImplementation(async(url,options)=>{
  const u=String(url)
  if(u==='/api/vouchers/periods')return[] as any
  if(u==='/api/vouchers/periods/carryover')throw new Error('原结转已导出，不能自动重算')
  if(u.includes('/api/vouchers?'))return{items:[],total:0,page:1,pageSize:1} as any
  if(u.includes('pending-from-finance'))return{summary:{paidCount:0}} as any
  if(u.includes('/api/payment-requests'))return{total:0} as any
  if(u.includes('/api/finance/cost-check'))return{total:{count:0,allVerifiedCount:0}} as any
  return[] as any
 })
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(<Page/>))
  const row=host.querySelector('tbody tr')!;const month=row.querySelector('td')!.textContent!
  const button=Array.from(row.querySelectorAll('button')).find(b=>b.textContent==='生成／更新结转')!
  await act(async()=>button.click())
  expect(apiFetch).toHaveBeenCalledWith('/api/vouchers/periods/carryover',{method:'POST',body:JSON.stringify({month})})
  expect(vi.mocked(apiFetch).mock.calls.some(([u])=>u==='/api/vouchers/periods/close')).toBe(false)
  expect(notifyUser).toHaveBeenCalledWith('原结转已导出，不能自动重算')
  expect(button.disabled).toBe(false)
 }finally{await act(async()=>root.unmount());host.remove()}
})
