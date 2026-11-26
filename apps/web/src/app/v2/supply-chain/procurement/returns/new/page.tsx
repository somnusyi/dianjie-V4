'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SearchableSelect } from '@/components/v2/searchable-select'
import { ProcurementDocumentEditor } from '@/components/v2/procurement-document-editor'
import { apiFetch } from '@/lib/v2-auth'

type Option = { id: string; no?: string; code?: string; name: string }
const RETURN_SEARCH_FIELD = 'mt-1 h-10 w-full min-w-0 rounded-md border border-[#c9c9c9] bg-white px-3 text-caption text-gray1 shadow-sm outline-none focus:border-[#ff8200] focus:ring-2 focus:ring-[#ff8200]/20'
const RETURN_SEARCH_INPUT = 'h-10 rounded-md border-[#c9c9c9] focus:border-[#ff8200] focus:ring-2 focus:ring-[#ff8200]/20'

export default function NewReturnPage() {
  const router = useRouter()
  const [setup, setSetup] = useState<{ suppliers: Option[]; warehouses: Option[] } | null>(null)
  const [error, setError] = useState('')
  const [supplier, setSupplier] = useState('')
  const [warehouse, setWarehouse] = useState('')
  const [selected, setSelected] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    setError('')
    void apiFetch<{ suppliers: Option[]; warehouses: Option[] }>('/api/upstream/setup-options')
      .then(result => { if (active) setSetup(result) })
      .catch(reason => { if (active) setError(reason.message || '选择项加载失败') })
    return () => { active = false }
  }, [retry])

  const close = () => router.push('/v2/supply-chain/procurement?tab=returns')

  if (selected) return <ProcurementDocumentEditor kind="RETURN" sourceId="new" supplierId={supplier} warehouseId={warehouse} onClose={close} onCreated={id => router.replace(`/v2/supply-chain/procurement/returns/${encodeURIComponent(id)}/edit`)} />

  return <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-6">
    <header className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 border-b border-border pb-5">
      <h1 className="text-h1">新建采购退货单</h1>
      <button type="button" onClick={close} className="rounded-lg border border-border bg-white px-4 py-2 text-button text-gray1 hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">返回采购退货</button>
    </header>

    <main className="mx-auto max-w-[1440px] py-5">
      {error && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-caption text-red-700">{error}<button type="button" onClick={() => setRetry(value => value + 1)} className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">重新加载</button></div>}
      <section aria-label="采购退货来源" className="overflow-hidden rounded-xl border border-border bg-white">
        <div className="border-b border-border p-4 lg:p-5"><div className="grid max-w-[740px] gap-4 sm:grid-cols-2">
          <label className="block text-caption text-gray2">供应商
            <SearchableSelect searchWhenLong searchLabel="搜索退货供应商" searchInputClassName={RETURN_SEARCH_INPUT} aria-label="上游供应商" className={RETURN_SEARCH_FIELD} value={supplier} onChange={event => setSupplier(event.target.value)}>
              <option value="">请选择供应商</option>
              {setup?.suppliers.map(item => <option key={item.id} value={item.id}>{item.no} · {item.name}</option>)}
            </SearchableSelect>
          </label>
          <label className="block text-caption text-gray2">退货总仓
            <SearchableSelect searchWhenLong searchLabel="搜索退货总仓" searchInputClassName={RETURN_SEARCH_INPUT} aria-label="退货仓库" className={RETURN_SEARCH_FIELD} value={warehouse} onChange={event => setWarehouse(event.target.value)}>
              <option value="">请选择退货总仓</option>
              {setup?.warehouses.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
            </SearchableSelect>
          </label>
        </div></div>
        <div className="p-4 lg:p-5">
          <h2 className="mb-3 text-h3">商品明细</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[680px] text-left text-caption">
              <thead className="bg-bg"><tr className="border-b border-border"><th className="w-16 px-3 py-2.5">序号</th><th className="px-3 py-2.5">原收货单 / 商品</th><th className="w-36 px-3 py-2.5">可退数量</th><th className="w-36 px-3 py-2.5">本次退货</th><th className="w-36 px-3 py-2.5 text-right">金额</th></tr></thead>
              <tbody><tr><td colSpan={5} className="px-3 py-10 text-center text-gray3">选择供应商和退货总仓后，查看可退商品</td></tr></tbody>
            </table>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3 lg:px-5">
          <button type="button" onClick={close} className="rounded-lg border border-border bg-white px-4 py-2 text-button hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">取消</button>
          <button type="button" disabled={!supplier || !warehouse || Boolean(error)} onClick={() => setSelected(true)} className="rounded-lg bg-gray1 px-4 py-2 text-button text-white hover:bg-gray2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40">选择可退商品</button>
        </div>
      </section>
    </main>
  </div>
}
