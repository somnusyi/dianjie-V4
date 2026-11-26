// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Page from './page'
import { apiFetch } from '@/lib/v2-auth'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn(), getUser: () => ({ supplier: { name: '云岭配送' } }) }))
vi.mock('@/components/v2', () => ({ BottomNav: () => null, Chip: ({ children }: any) => <span>{children}</span> }))

let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => { if(root) await act(async () => root!.unmount()); document.body.innerHTML = ''; vi.resetAllMocks(); vi.useRealTimers() })

describe('供应商应收账单金额', () => {
  it('按分显示账期、冻结、实收和总额，存在远期应收时不提示暂无应收', async () => {
    const receipt = { id: 'r', no: 'RK202610000004', deliveryDate: new Date().toISOString(), store: { name: '春城店' }, invoice: null }
    const base = { dueAt: new Date(Date.now()+30*86400_000).toISOString(), receipt, paidAt: null, failReason: null, bankTxNo: null }
    vi.mocked(apiFetch).mockImplementation(async (url) => url === '/api/schedules' ? [
      { ...base, id: 'pending', amount: '61.43', status: 'PENDING' },
      { ...base, id: 'held', amount: '50.05', status: 'ON_HOLD' },
      { ...base, id: 'paid', amount: '20.01', status: 'PAID', paidAt: new Date().toISOString() },
    ] : [] as any)
    const host=document.createElement('div');document.body.appendChild(host);root=createRoot(host)
    await act(async()=>{root!.render(<Page />)})
    expect(host.textContent).toContain('¥111.48')
    expect(host.textContent).toContain('¥61.43')
    expect(host.textContent).toContain('¥50.05')
    expect(host.textContent).toContain('¥20.01')
    expect(host.textContent).not.toContain('✓ 暂无应收')
    expect(host.textContent).toContain('暂无近期到期账款')
    const held=Array.from(host.querySelectorAll('button')).find(el=>el.textContent==='争议冻结 1')!
    await act(async()=>held.click())
    expect(host.querySelector('ul')?.textContent).toContain('¥50.05')
    expect(host.querySelector('ul')?.textContent).not.toContain('¥61.43')
  })
  it('没有账期时保留零应收提示', async () => {
    vi.mocked(apiFetch).mockResolvedValue([])
    const host=document.createElement('div');document.body.appendChild(host);root=createRoot(host)
    await act(async()=>{root!.render(<Page />)})
    expect(host.textContent).toContain('应收总额¥0.00')
    expect(host.textContent).toContain('✓ 暂无应收')
    expect(host.textContent).not.toContain('暂无近期到期账款')
  })
})

it.each(['loading','failed'])('unknown schedules %s do not claim zero receivables',async mode=>{
 vi.mocked(apiFetch).mockImplementation(url=>{
 if(url==='/api/schedules')return mode==='failed'?Promise.reject(new Error('账单读取失败')):new Promise(()=>{})
 return Promise.resolve([]) as any
 })
 const host=document.createElement('div');document.body.append(host);root=createRoot(host)
 await act(async()=>root!.render(<Page/>))
 expect(host.textContent).not.toContain('✓ 暂无应收')
 expect(host.textContent).not.toContain('¥0.00')
 expect(host.textContent).toContain('待收 —')
 if(mode==='failed'){expect(host.textContent).toContain('读取失败');expect(host.textContent).not.toContain('加载中')}
})

it('本月已收仅计上海同一年月，排除去年同月及下月边界', async () => {
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
 const entries=[['2025-12-31T15:59:59.999Z','10.01'],['2025-12-31T16:00:00Z','1.23'],['2026-01-31T15:59:59.999Z','2.34'],['2026-01-31T16:00:00Z','20.02'],['2025-01-15T00:00:00Z','30.03']]
 vi.mocked(apiFetch).mockImplementation(async url=>url==='/api/schedules'?entries.map(([paidAt,amount],i)=>({id:String(i),amount,status:'PAID',paidAt,dueAt:paidAt,receipt:{id:String(i),no:String(i),deliveryDate:paidAt,store:{name:'青禾店'},invoice:null}})):[] as any)
 const host=document.createElement('div');document.body.append(host);root=createRoot(host)
 await act(async()=>root!.render(<Page/>))
 expect(host.textContent).toContain('¥3.57')
})
