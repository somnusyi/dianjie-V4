import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from './v2-auth'
import { loadUpstreamSettlementStatements } from './upstream-settlement-list'
vi.mock('./v2-auth', () => ({ apiFetch: vi.fn() }))
const mockFetch=vi.mocked(apiFetch)
const rows=(start:number,count:number)=>Array.from({length:count},(_,i)=>({id:`statement-${start+i}`}))
beforeEach(()=>{ mockFetch.mockReset() })
describe('complete upstream settlement list',()=>{
 it.each([0,1,199,200,201,400])('loads all %i rows and checks the last full page',async count=>{
  const all=rows(0,count)
  mockFetch.mockImplementation(async url=>{const cursor=new URL(String(url),'http://local').searchParams.get('cursor');const start=cursor?all.findIndex(x=>x.id===cursor)+1:0;return all.slice(start,start+200) as any})
  expect(await loadUpstreamSettlementStatements()).toEqual(all)
  expect(mockFetch).toHaveBeenCalledTimes(Math.floor(count/200)+1)
 })
 it('fails instead of returning a partial list when a later page fails',async()=>{
  mockFetch.mockResolvedValueOnce(rows(0,200) as any).mockRejectedValueOnce(new Error('第二页读取失败'))
  await expect(loadUpstreamSettlementStatements()).rejects.toThrow('第二页读取失败')
 })
 it('rejects an old server repeating the first page rather than looping or hiding duplicates',async()=>{
  mockFetch.mockResolvedValue(rows(0,200) as any)
  await expect(loadUpstreamSettlementStatements()).rejects.toThrow('未完整加载')
  expect(mockFetch).toHaveBeenCalledTimes(2)
 })
 it.each([null,{},[{id:''}],[{id:1}],rows(0,201)])('rejects invalid page %#',async page=>{
  mockFetch.mockResolvedValue(page as any)
  await expect(loadUpstreamSettlementStatements()).rejects.toThrow('未完整加载')
 })
 it('rejects a repeated row even if the second page has a new last cursor',async()=>{
  mockFetch.mockResolvedValueOnce(rows(0,200) as any).mockResolvedValueOnce([{id:'statement-1'},{id:'statement-200'}] as any)
  await expect(loadUpstreamSettlementStatements()).rejects.toThrow('未完整加载')
 })
})
