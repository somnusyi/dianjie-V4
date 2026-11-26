// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import PC from '@/app/v2/finance-pc/vouchers/page'
import Mobile from '@/app/v2/finance/vouchers/page'
import {loadVouchers} from './voucher-list'
import {apiFetch} from './v2-auth'
vi.mock('./voucher-list',()=>({loadVouchers:vi.fn()}))
vi.mock('./v2-auth',()=>({apiFetch:vi.fn(),getToken:()=>null}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>,MonthPicker:({onChange}:any)=><button onClick={()=>onChange('2026-09')}>九月</button>}))
vi.mock('@/components/v2/use-dashboard',()=>({ErrorScreen:({message}:any)=><div role="alert">{message}</div>}))
vi.mock('@/app/v2/finance-pc/_topnav',()=>({default:()=>null}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
const deferred=()=>{let resolve!:(v:any)=>void,reject!:(e:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const row=(id:string)=>({id,no:id,date:'2026-09-15',word:'记',summary:id,totalDebit:'10.25',totalCredit:'10.25',status:'DRAFT',entries:[]})
let root:ReturnType<typeof createRoot>,host:HTMLDivElement
beforeAll(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-22T09:00:00Z'))})
afterAll(()=>{vi.useRealTimers()})
beforeEach(()=>{vi.resetAllMocks();vi.mocked(loadVouchers).mockResolvedValue([])})
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML=''})
for(const[name,Page]of [['PC',PC],['mobile',Mobile]] as const)describe(name,()=>{
 async function render(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Page/>))}
 const button=(prefix:string)=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.trim().startsWith(prefix))!
 async function month(){await act(async()=>{if(name==='PC')button('九月').click();else{const input=host.querySelector('input[type="month"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'2026-09');input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new Event('input',{bubbles:true}))}})}
 it.each([['49.09','¥49.09'],['144','¥144.00'],['12345.67','¥12,345.67']])('voucher amount %s preserves cents and thousands',async(amount,expected)=>{
  vi.mocked(loadVouchers).mockResolvedValue([{...row('金额凭证'),totalDebit:amount,totalCredit:amount}] as any);await render()
  const region=name==='PC'?host.querySelector('tbody tr')?.querySelectorAll('td')[3]:host.querySelector('ul li a')
  expect(region?.textContent).toContain(expected)
 })
 it('connects the complete loader and renders the final row',async()=>{vi.mocked(loadVouchers).mockResolvedValue([row('末页凭证')] as any);await render();expect(loadVouchers).toHaveBeenCalledWith('2026-10-01','2026-10-31','ALL');expect(host.textContent).toContain('末页凭证')})
 it.each(['month','status'])('late %s response or failure cannot replace current selection',async change=>{
  const old=deferred();vi.mocked(loadVouchers).mockReturnValueOnce(old.promise).mockResolvedValue([row('当前凭证')] as any);await render();if(change==='month')await month();else await act(async()=>button('已审').click());await act(async()=>old.resolve([row('过期凭证')]))
  expect(host.textContent).toContain('当前凭证');expect(host.textContent).not.toContain('过期凭证')
 })
 it('late rejection does not replace the new month',async()=>{const old=deferred();vi.mocked(loadVouchers).mockReturnValueOnce(old.promise).mockResolvedValue([row('当前凭证')] as any);await render();await month();await act(async()=>old.reject(new Error('旧月失败')));expect(host.textContent).toContain('当前凭证');expect(host.textContent).not.toContain('旧月失败')})
 it('failed complete load shows error with no loading or actionable vouchers',async()=>{vi.mocked(loadVouchers).mockRejectedValue(new Error('后页读取失败'));await render();expect(host.textContent).toContain('后页读取失败');expect(host.textContent).not.toContain('加载中');expect(button('审核')).toBeUndefined();if(name==='PC')expect(host.textContent).toContain('—')})
 it('clears old selections on month change',async()=>{vi.mocked(loadVouchers).mockResolvedValue([row('草稿凭证')] as any);await render();await act(async()=>(name==='PC'?host.querySelector<HTMLInputElement>('input[type="checkbox"]')!:host.querySelector<HTMLButtonElement>('button[aria-label="选择"]')!).click());await month();expect(host.textContent).not.toMatch(/已选\s*1/);expect(vi.mocked(apiFetch)).not.toHaveBeenCalled()})
 it('a pending audit refreshes the current month, not its starting month',async()=>{const posting=deferred();vi.mocked(loadVouchers).mockResolvedValue([row('草稿凭证')] as any);vi.mocked(apiFetch).mockReturnValue(posting.promise);await render();await act(async()=>button('审核').click());await month();await act(async()=>posting.resolve({}));expect(vi.mocked(loadVouchers).mock.calls.at(-1)).toEqual(['2026-09-01','2026-09-30','ALL'])})
})
