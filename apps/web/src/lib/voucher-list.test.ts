import { beforeEach, expect, it, vi } from 'vitest'
import { apiFetch } from './v2-auth'
import { loadVouchers, loadVoucherCount } from './voucher-list'
vi.mock('./v2-auth', () => ({ apiFetch: vi.fn() }))
const fetchMock=vi.mocked(apiFetch)
const rows=(start:number,count:number)=>Array.from({length:count},(_,i)=>({id:`v-${start+i}`}))
beforeEach(()=>{fetchMock.mockReset()})
it.each([0,1,199,200,201,401])('reads all %i vouchers with legal page sizes and stable filters',async count=>{
 const all=rows(0,count)
 fetchMock.mockImplementation(async url=>{const q=new URL(String(url),'http://local').searchParams;const page=Number(q.get('page'));expect(q.get('pageSize'), String(url)).toBe('200');expect(q.get('from')).toBe('2026-08-01');expect(q.get('to')).toBe('2026-08-31');expect(q.get('status')).toBe('POSTED');return {items:all.slice((page-1)*200,page*200),total:count,page,pageSize:200} as any})
 expect(await loadVouchers('2026-08-01','2026-08-31','POSTED')).toEqual(all)
 expect(fetchMock).toHaveBeenCalledTimes(Math.max(1,Math.ceil(count/200)))
})
it('refuses a failed second page instead of publishing the first 200',async()=>{
 fetchMock.mockResolvedValueOnce({items:rows(0,200),total:201,page:1,pageSize:200} as any).mockRejectedValueOnce(new Error('后页读取失败'))
 await expect(loadVouchers('a','b','ALL')).rejects.toThrow('后页读取失败')
})
it.each(['changed-total','duplicate','short-page','wrong-page','invalid-total'])('rejects %s',async kind=>{
 fetchMock.mockResolvedValueOnce({items:rows(0,200),total:201,page:1,pageSize:200} as any)
 const next:any={items:rows(200,1),total:201,page:2,pageSize:200}
 if(kind==='changed-total')next.total=202
 if(kind==='duplicate')next.items=[{id:'v-0'}]
 if(kind==='short-page')next.items=[]
 if(kind==='wrong-page')next.page=1
 if(kind==='invalid-total')next.total='201'
 fetchMock.mockResolvedValueOnce(next)
 await expect(loadVouchers('a','b','ALL')).rejects.toThrow(/凭证/)
})

it.each([0,1,201])('count-only uses server total %i',async total=>{
 fetchMock.mockResolvedValue({total,page:1,pageSize:1,items:[]} as any)
 expect(await loadVoucherCount('2026-08-01','2026-08-31','DRAFT')).toBe(total)
 expect(String(fetchMock.mock.calls[0][0])).toContain('pageSize=1')
})
it.each([undefined,-1,'201'])('refuses invalid count %s',async total=>{
 fetchMock.mockResolvedValue({total,page:1,pageSize:1} as any)
 await expect(loadVoucherCount('a','b','DRAFT')).rejects.toThrow('凭证数量读取不完整')
})
