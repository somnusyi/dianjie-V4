'use client'

import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

type Company = { id: string; no: string; name: string; status: string }
type History = { company: string; name: string; phone: string }
export default function SupplierAccountsPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [history, setHistory] = useState<History[]>([])
  const [historyError, setHistoryError] = useState('')
  const [historyPage, setHistoryPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const historySequence = useRef(0)
  const [loading, setLoading] = useState(true)
  const [supplierId, setSupplierId] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const submitting = useRef(false)
  async function loadHistory(page = 0, signal?: AbortSignal) {
    const sequence = ++historySequence.current
    setHistoryLoading(true)
    try {
      const result = await apiFetch<{ items: History[]; hasMore: boolean }>(`/api/upstream/supplier-accounts/history?page=${page}`, { signal })
      if (!signal?.aborted && sequence === historySequence.current) { setHistory(result.items); setHasMore(result.hasMore); setHistoryPage(page); setHistoryError('') }
    } catch { if (!signal?.aborted && sequence === historySequence.current) setHistoryError('历史读取失败，请重试') }
    finally { if (!signal?.aborted && sequence === historySequence.current) setHistoryLoading(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    apiFetch<Company[]>('/api/suppliers?businessScope=WAREHOUSE_UPSTREAM', { signal: controller.signal })
      .then(rows => setCompanies(rows.filter(row => row.status === 'ENABLED')))
      .catch(reason => { if (!controller.signal.aborted) setError(reason?.message || '供应商读取失败，请刷新重试') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    void loadHistory(0, controller.signal)
    return () => controller.abort()
  }, [])
  async function add() {
    if (!supplierId || submitting.current) return
    submitting.current = true
    ++historySequence.current
    setHistoryLoading(false)
    setBusy(true); setError(''); setNotice('')
    try {
      const added = await apiFetch<History>(`/api/upstream/suppliers/${supplierId}/accounts`, {
        method: 'POST', body: JSON.stringify({ name: name.trim(), phone: phone.trim(), password }),
      })
      setHistory(rows => historyPage === 0 ? [added, ...rows].slice(0, 100) : [added])
      setHistoryPage(0)
      setNotice(`已添加：${added.company} · ${added.name} · ${added.phone}`)
      setName(''); setPhone(''); setPassword('')
      await loadHistory(0)
    } catch (reason: any) {
      setError(reason?.message || '添加结果尚未确认，请先刷新历史核对，避免重复添加')
    } finally { submitting.current = false; setBusy(false) }
  }
  return <main className="mx-auto max-w-3xl p-4 lg:p-8">
    <a href="/v2/supply-chain/suppliers" className="text-caption text-accent">← 返回上游供应商</a>
    <h1 className="mt-4 text-h1">添加供应商账号</h1>
    <p className="mt-2 text-caption text-gray2">供应链填写后确认添加，账号立即开通，无需进入企业微信。手机号用于登录。</p>
    <form onSubmit={event => { event.preventDefault(); void add() }} className="mt-5 rounded-card border border-border bg-white p-5">
      <label htmlFor="supplier-company" className="text-button">供应商公司</label>
      <select required id="supplier-company" value={supplierId} disabled={loading || busy} onChange={event => { setSupplierId(event.target.value); setNotice(''); setError('') }} className="mt-2 w-full rounded-xl border border-border bg-white px-3 py-3">
        <option value="">{loading ? '读取中…' : '从已有供应商中选择公司'}</option>
        {companies.map(company => <option key={company.id} value={company.id}>{company.no} · {company.name}</option>)}
      </select>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-button">姓名<input required maxLength={20} value={name} disabled={busy} onChange={e => setName(e.target.value)} autoComplete="off" className="mt-2 w-full rounded-xl border border-border p-3" /></label>
        <label className="text-button">手机号<input required type="tel" pattern="1[3-9][0-9]{9}" value={phone} disabled={busy} onChange={e => setPhone(e.target.value)} autoComplete="off" className="mt-2 w-full rounded-xl border border-border p-3" /></label>
        <label className="text-button">密码<input required type="password" minLength={6} maxLength={40} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} autoComplete="new-password" className="mt-2 w-full rounded-xl border border-border p-3" /></label>
      </div>
      <p className="mt-3 text-caption text-gray2">账号只绑定所选公司，只能查看和处理发给该公司的采购订单。</p>
      {error && <p role="alert" className="mt-3 text-caption text-red-600">{error}</p>}
      {notice && <p role="status" className="mt-3 text-caption text-green-700">{notice}</p>}
      <div className="mt-4 flex gap-3"><button type="submit" disabled={!supplierId || busy || !name.trim() || !phone.trim() || password.length < 6} className="rounded-cta bg-accent px-5 py-2.5 text-button text-white disabled:opacity-40">{busy ? '添加中…' : '确认添加'}</button><a href="/v2/supply-chain/suppliers" className="rounded-cta border border-border px-5 py-2.5 text-button">取消</a></div>
    </form>
    <section className="mt-5 rounded-card border border-border bg-white p-5">
      <div className="flex items-center justify-between"><h2 className="text-h2">历史添加记录</h2><button disabled={busy || historyLoading} onClick={() => void loadHistory(historyPage)} className="text-caption text-accent disabled:opacity-40">刷新历史</button></div>
      {historyError && <p role="alert" className="mt-2 text-caption text-red-600">{historyError}</p>}
      <table className="mt-3 w-full text-left text-caption"><thead className="bg-bg"><tr><th className="p-3">公司</th><th className="p-3">姓名</th><th className="p-3">手机号</th></tr></thead><tbody>{history.map((row, index) => <tr key={`${row.phone}-${index}`} className="border-b border-border"><td className="p-3">{row.company}</td><td className="p-3">{row.name}</td><td className="p-3 font-num">{row.phone}</td></tr>)}</tbody></table>
      {!history.length && !historyError && <p className="mt-3 text-caption text-gray3">暂无本入口添加记录</p>}
      <div className="mt-4 flex items-center gap-4 text-caption"><button disabled={busy || historyLoading || historyPage === 0} onClick={() => void loadHistory(historyPage - 1)} className="text-accent disabled:opacity-40">上一页</button><span>第{historyPage + 1}页</span><button disabled={busy || historyLoading || !hasMore} onClick={() => void loadHistory(historyPage + 1)} className="text-accent disabled:opacity-40">下一页</button></div>
    </section>
  </main>
}
