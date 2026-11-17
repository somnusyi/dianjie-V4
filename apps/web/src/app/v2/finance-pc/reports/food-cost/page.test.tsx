// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {beforeAll,afterAll,beforeEach,afterEach,it,expect,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
import {exportXlsx} from '@/lib/exportXlsx'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('@/lib/exportXlsx',()=>({exportXlsx:vi.fn().mockResolvedValue(undefined)}))
vi.mock('@/components/v2/use-dashboard',()=>({ErrorScreen:({message}:any)=><div role="alert">{message}</div>}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>,MonthPicker:({value,onChange}:any)=><><span>{value}</span><button onClick={()=>onChange('2026-09')}>九月</button></>}))
vi.mock('../../_topnav',()=>({default:()=>null}))
const isPC=true,isProfit=false
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
const report=(month:string,revenue=100.25,food=32.44)=>{
 const store={storeId:'s',storeName:'清源一店',revenue,foodCost:food,loss:0,foodCostRatio:food/revenue,lossRatio:0,grossProfit:revenue-food,grossMargin:(revenue-food)/revenue}
 if(isProfit)return{month,summary:{revenue,revenueYoy:null,revenueMom:null,cost:{food,loss:0,sellingExp:0,mgmtExp:0,financeExp:0,payroll:0,rent:0,utility:0,marketing:0,other:0},netProfit:revenue-food,netMargin:(revenue-food)/revenue,foodCostRatio:food/revenue},byChannel:{unknown:revenue},stores:[store,{...store,storeId:'s2',storeName:'清源二店',revenue:0,foodCost:0,grossProfit:0,grossMargin:0,foodCostRatio:0}]}
 return{month,total:{revenue,foodCost:food,loss:0,foodCostRatio:food/revenue,lossRatio:0},stores:[store],trend:[{month,revenue,foodCost:food,ratio:food/revenue,loss:0}],turnoverDays:1}
}
const deferred=()=>{let resolve!:(v:any)=>void,reject!:(e:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
let root:ReturnType<typeof createRoot>,host:HTMLDivElement
beforeAll(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-22T09:00:00Z'))})
afterAll(()=>{vi.useRealTimers()})
beforeEach(()=>{history.replaceState(null,'','/?month=2026-10');vi.resetAllMocks();vi.mocked(exportXlsx).mockResolvedValue(undefined);vi.mocked(apiFetch).mockResolvedValue(report('2026-10') as any)})
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML=''})
async function render(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Page/>))}
function exportButton(){return Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes('导出'))!}
async function previous(){await act(async()=>{
 if(isPC)Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='九月')!.click()
 else{const input=host.querySelector('input[type="month"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'2026-09');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))}
})}
it('all monetary regions preserve cents, including large values and negative profit',async()=>{
 vi.mocked(apiFetch).mockResolvedValue(report('2026-10',12345.67,12369.38) as any);await render()
 if(isProfit){expect(host.textContent?.split('¥12,345.67').length).toBeGreaterThanOrEqual(4);expect(host.textContent?.split('¥-23.71').length).toBeGreaterThanOrEqual(4)}
 else expect(host.textContent?.split('¥12,369.38').length).toBeGreaterThanOrEqual(4)
})
it.each(['resolve','reject'])('late old-month %s cannot overwrite current month or its export',async outcome=>{
 const old=deferred();vi.mocked(apiFetch).mockImplementation(path=>String(path).includes('month=2026-09')?Promise.resolve(report('2026-09',200.75,44.56)) as any:old.promise)
 await render();await previous();await act(async()=>{if(outcome==='resolve')old.resolve(report('2026-10'));else old.reject(new Error('旧月失败'))})
 expect(host.textContent).not.toContain('旧月失败');expect(host.textContent).not.toContain('100.25');expect(host.textContent).not.toContain('32.44')
 expect(host.textContent).toContain(isProfit?'200':'44')
 if(isPC){await act(async()=>exportButton().click());const [name,sheets]=vi.mocked(exportXlsx).mock.calls[0];expect(name).toContain('2026-09');expect(JSON.stringify(sheets)).toContain('200.75');expect(JSON.stringify(sheets)).toContain('44.56');expect(JSON.stringify(sheets)).not.toContain('100.25')}
})
it('an old response cannot enable current exports or replace the loading state',async()=>{
 const old=deferred(),fresh=deferred();vi.mocked(apiFetch).mockImplementation(path=>String(path).includes('month=2026-09')?fresh.promise:old.promise)
 await render();await previous();await act(async()=>old.resolve(report('2026-10')))
 expect(host.textContent).toContain('加载中');expect(host.textContent).not.toContain('100.25')
 if(isPC)expect(exportButton().disabled).toBe(true)
 await act(async()=>fresh.resolve(report('2026-09',200.75,44.56)))
 expect(host.textContent).not.toContain('加载中');if(isPC)expect(exportButton().disabled).toBe(false)
})
it('a response for the wrong month is refused instead of being labelled as current',async()=>{
 vi.mocked(apiFetch).mockResolvedValue(report('2026-09') as any);await render()
 expect(host.textContent).toContain('月份不一致');expect(host.textContent).not.toContain('100.25');if(isPC)expect(exportButton().disabled).toBe(true)
})
