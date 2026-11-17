// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,beforeEach,it,expect,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>}))
vi.mock('@/components/v2/InvoicePaymentResultDialog',()=>({default:()=>null,invoicePaymentMethods:[]}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
let root:ReturnType<typeof createRoot>,host:HTMLDivElement
const invoice={id:'i',invoiceNo:'202610000001',amount:'61.40',paidAmount:'0',remainingAmount:61.4,paidPct:0,fileUrl:'/local-reference.png',issueDate:'2026-10-22',earliestDueAt:null,supplier:{name:'青禾食材'},receipts:[],payments:[]}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(apiFetch).mockImplementation(path=>Promise.resolve(String(path).includes('/payable')?[invoice]:[]) as any)})
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML=''})
async function render(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Page/>))}
function amountHero(){const label=Array.from(host.querySelectorAll('*')).find(x=>x.children.length===0&&x.textContent==='应付合计')!;return label.parentElement!.textContent!}
it('summary and invoice rows retain exact cents including trailing zero and paid zero',async()=>{await render();expect(host.textContent?.split('¥61.40').length).toBeGreaterThanOrEqual(4);expect(host.textContent).toContain('¥0.00');expect(amountHero()).toContain('¥61.40')})
it('pending invoice reads remain unknown even when account read succeeds',async()=>{let resolve!:(v:any)=>void;const pending=new Promise(r=>resolve=r);vi.mocked(apiFetch).mockImplementation(path=>String(path).includes('/payable')?pending as any:Promise.resolve([]));await render();expect(amountHero()).toContain('—');expect(amountHero()).not.toContain('¥0');expect(host.textContent).toContain('加载中');expect(host.textContent).not.toContain('+¥0');await act(async()=>resolve([invoice]));expect(amountHero()).toContain('¥61.40')})
it('failed invoice reads show error with unknown totals instead of zero or endless loading',async()=>{vi.mocked(apiFetch).mockImplementation(path=>String(path).includes('/payable')?Promise.reject(new Error('应付不可读取')):Promise.resolve([]));await render();expect(host.textContent).toContain('应付不可读取');expect(amountHero()).toContain('—');expect(amountHero()).not.toContain('¥0');expect(host.textContent).not.toContain('加载中');expect(host.textContent).not.toContain('暂无待付发票');expect(host.textContent).not.toContain('发起付款')})
it('successful empty invoices show a genuine zero and no payment action; all requests stay read-only and local-ledger based',async()=>{vi.mocked(apiFetch).mockResolvedValue([]);await render();expect(amountHero()).toContain('¥0.00');expect(host.textContent).toContain('暂无待付发票');expect(host.textContent).not.toContain('发起付款');for(const [url,options] of vi.mocked(apiFetch).mock.calls){expect(['/api/invoice-payments/payable','/api/cashbook/accounts']).toContain(url);expect(options).toBeUndefined()}})
