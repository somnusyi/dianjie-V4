// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterAll,beforeAll,expect,it,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
import {notifyUser} from '@/lib/ui-dialogs'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('../_topnav',()=>({default:()=>null}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>,MonthPicker:({onChange}:any)=><button onClick={()=>onChange('2026-09')}>九月</button>}))
vi.mock('@/lib/ui-dialogs',()=>({confirmDialog:vi.fn(),notifyUser:vi.fn()}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
beforeAll(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-20T10:00:00Z'))})
afterAll(()=>{vi.useRealTimers()})
it('keeps row, overall and group amounts exact to cents without K abbreviation',async()=>{
 const summary={count:1,totalAmount:1371.65,allVerifiedCount:0,pendingChefCount:0,pendingSupplierCount:1,pendingFinanceCount:0}
 const row={id:'receipt',no:'RK001',totalAmount:'61.43',deliveryDate:'2026-10-20',status:'ACCOUNTED',supplier:{id:'s',name:'供应商'},store:{id:'store',name:'门店'},verifications:{store:{done:true},chef:{done:true},supplier:{done:false},finance:{done:false}},allVerified:false,doneCount:2}
 const groups=Object.fromEntries(['HEADQ_WAREHOUSE','B2B_PLATFORM','MAIN_SUPPLIER','SCATTERED','UNCATEGORIZED'].map(key=>[key,{label:key,items:key==='UNCATEGORIZED'?[row]:[],summary:key==='UNCATEGORIZED'?summary:{...summary,count:0,totalAmount:0}}]))
 vi.mocked(apiFetch).mockResolvedValue({month:'2026-10',total:summary,groups} as any)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 expect(host.textContent).toContain('¥61.43');expect(host.textContent?.match(/¥1,371\.65/g)?.length).toBe(2);expect(host.textContent).not.toContain('1.4K');await act(async()=>root.unmount());host.remove()
})

it.each(['success','error'])('late old-month %s cannot replace the selected month',async outcome=>{
 let resolveOld!:(x:any)=>void,rejectOld!:(x:any)=>void
 const old=new Promise((resolve,reject)=>{resolveOld=resolve;rejectOld=reject})
 const summary={count:0,totalAmount:183.27,allVerifiedCount:0,pendingChefCount:0,pendingSupplierCount:0,pendingFinanceCount:0}
 const data={month:'2026-09',total:summary,groups:{}}
 vi.mocked(apiFetch).mockReset().mockImplementation((url:any)=>url.includes('month=2026-09')?Promise.resolve(data):old as any)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>));await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='九月')!.click())
 expect(host.textContent).toContain('¥183.27')
 await act(async()=>{if(outcome==='success')resolveOld({...data,month:'2026-10',total:{...summary,totalAmount:999.99}});else rejectOld(new Error('旧月失败'))})
 expect(host.textContent).toContain('¥183.27');expect(host.textContent).not.toContain('999.99');expect(host.textContent).not.toContain('旧月失败')
 }finally{await act(async()=>root.unmount());host.remove()}
})

it('verification completed after changing month refreshes only the currently selected month',async()=>{
 let finishWrite!:(x:any)=>void
 const write=new Promise(resolve=>{finishWrite=resolve})
 const summary={count:1,totalAmount:61.43,allVerifiedCount:0,pendingChefCount:0,pendingSupplierCount:0,pendingFinanceCount:1}
 const row={id:'receipt',no:'RK-OLD',totalAmount:'61.43',deliveryDate:'2026-10-20',status:'ACCOUNTED',supplier:{id:'s',name:'供应商'},store:{id:'store',name:'门店'},verifications:{store:{done:true},chef:{done:true},supplier:{done:true},finance:{done:false}},allVerified:false,doneCount:3}
 const october={month:'2026-10',total:summary,groups:{UNCATEGORIZED:{label:'未分类',items:[row],summary}}}
 const september={month:'2026-09',total:{...summary,totalAmount:183.27,count:0},groups:{}}
 vi.mocked(apiFetch).mockReset().mockImplementation((url:any,options:any)=>options?.method==='PATCH'?write as any:Promise.resolve(url.includes('month=2026-09')?september:october) as any)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>));await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes('RK-OLD'))!.click())
 await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes('财务核对完毕'))!.click())
 await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='九月')!.click())
 await act(async()=>finishWrite({}))
 expect(vi.mocked(apiFetch).mock.calls.at(-1)?.[0]).toBe('/api/finance/cost-check?month=2026-09');expect(host.textContent).toContain('¥183.27');expect(host.textContent).not.toContain('RK-OLD')
 }finally{await act(async()=>root.unmount());host.remove()}
})

it('does not reload or notify after a pending verification finishes on an unmounted page',async()=>{
 let finishWrite!:(x:any)=>void
 const write=new Promise(resolve=>{finishWrite=resolve})
 const summary={count:1,totalAmount:61.43,allVerifiedCount:0,pendingChefCount:0,pendingSupplierCount:0,pendingFinanceCount:1}
 const row={id:'receipt',no:'RK-OLD',totalAmount:'61.43',deliveryDate:'2026-10-20',status:'ACCOUNTED',supplier:{id:'s',name:'供应商'},store:{id:'store',name:'门店'},verifications:{store:{done:true},chef:{done:true},supplier:{done:true},finance:{done:false}},allVerified:false,doneCount:3}
 vi.mocked(notifyUser).mockClear();vi.mocked(apiFetch).mockReset().mockImplementation((_url:any,options:any)=>options?.method==='PATCH'?write as any:Promise.resolve({month:'2026-10',total:summary,groups:{UNCATEGORIZED:{label:'未分类',items:[row],summary}}}) as any)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 await act(async()=>root.render(<Page/>));await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes('RK-OLD'))!.click())
 await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes('财务核对完毕'))!.click())
 const calls=vi.mocked(apiFetch).mock.calls.length
 await act(async()=>root.unmount());host.remove();await act(async()=>finishWrite({}))
 expect(apiFetch).toHaveBeenCalledTimes(calls);expect(notifyUser).not.toHaveBeenCalled()
})
