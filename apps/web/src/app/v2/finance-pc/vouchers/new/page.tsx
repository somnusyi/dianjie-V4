/**
 * 财务 PC · 凭证手工新建
 *
 * 走 POST /api/vouchers, sourceType=Manual
 * UX:
 *   - 凭证日期 (DatePicker 含快捷)
 *   - 字别 (默认 '记') + 摘要
 *   - 分录表: 科目编码 → autofill 名称, 借/贷 二选一
 *   - 加/减行 (至少 2)
 *   - 实时显示借合计/贷合计/差额, 差额≠0 红色
 *   - 保存 → 跳详情页
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import dayjs from 'dayjs'
import { DatePicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../../_topnav'

type Coa = { id: string; code: string; name: string; type: string; isDetail: boolean; enabled: boolean }
type Entry = { accountCode: string; accountName: string; debit: string; credit: string; summary: string }
type Voucher = {
  id: string; no: string; date: string; word: string; summary: string
  status: 'DRAFT' | 'POSTED' | 'VOIDED'
  exportedAt?: string | null
  entries: Array<{ accountCode: string; accountName: string; debit: string; credit: string; summary: string }>
}

const emptyEntry = (): Entry => ({ accountCode: '', accountName: '', debit: '', credit: '', summary: '' })

export default function NewVoucherPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams?.get('edit') || null
  const isEdit = !!editId

  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [word, setWord] = useState('记')
  const [summary, setSummary] = useState('')
  const [entries, setEntries] = useState<Entry[]>([emptyEntry(), emptyEntry()])
  const [coa, setCoa] = useState<Coa[] | null>(null)
  const [coaError, setCoaError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingEdit, setLoadingEdit] = useState(isEdit)
  const [editingVoucher, setEditingVoucher] = useState<Voucher | null>(null)

  useEffect(() => {
    apiFetch<Coa[]>('/api/vouchers/coa')
      .then(setCoa)
      .catch(e => setCoaError(e?.message || '加载科目表失败'))
  }, [])

  // 编辑模式: 拉现有 voucher 填表
  useEffect(() => {
    if (!editId) return
    setLoadingEdit(true)
    apiFetch<Voucher>(`/api/vouchers/${editId}`)
      .then(v => {
        if (v.status !== 'DRAFT') throw new Error(`仅 DRAFT 凭证可编辑 (当前: ${v.status})`)
        if (v.exportedAt) throw new Error('已导出凭证不可改')
        setEditingVoucher(v)
        setDate(dayjs(v.date).format('YYYY-MM-DD'))
        setWord(v.word || '记')
        setSummary(v.summary || '')
        setEntries(v.entries.map(e => ({
          accountCode: e.accountCode,
          accountName: e.accountName,
          debit: Number(e.debit) > 0 ? String(e.debit) : '',
          credit: Number(e.credit) > 0 ? String(e.credit) : '',
          summary: e.summary || '',
        })))
      })
      .catch(e => setError(e?.message || '加载凭证失败'))
      .finally(() => setLoadingEdit(false))
  }, [editId])

  // 借贷合计
  const debitSum = useMemo(() => entries.reduce((s, e) => s + (Number(e.debit) || 0), 0), [entries])
  const creditSum = useMemo(() => entries.reduce((s, e) => s + (Number(e.credit) || 0), 0), [entries])
  const diff = debitSum - creditSum
  const balanced = Math.abs(diff) < 0.01 && debitSum > 0

  function updateEntry(i: number, patch: Partial<Entry>) {
    setEntries(es => {
      const next = [...es]
      next[i] = { ...next[i], ...patch }
      return next
    })
  }
  function addRow() { setEntries(es => [...es, emptyEntry()]) }
  function removeRow(i: number) { setEntries(es => es.length > 2 ? es.filter((_, idx) => idx !== i) : es) }

  // 科目编码 input 失焦或更改 → autofill 名称
  function onCodeChange(i: number, code: string) {
    const c = code.trim()
    const found = coa?.find(a => a.code === c)
    updateEntry(i, { accountCode: c, accountName: found?.name || entries[i].accountName })
  }

  async function save() {
    if (saving) return
    setError(null)
    if (!summary.trim()) { setError('请填摘要'); return }
    if (!balanced) { setError(`借贷不平: 借 ${debitSum.toFixed(2)} ≠ 贷 ${creditSum.toFixed(2)}`); return }
    const validEntries = entries.filter(e => e.accountCode && (Number(e.debit) > 0 || Number(e.credit) > 0))
    if (validEntries.length < 2) { setError('至少 2 条有效分录 (含金额)'); return }
    for (const e of validEntries) {
      if (Number(e.debit) > 0 && Number(e.credit) > 0) {
        setError(`科目 ${e.accountCode} 借贷不能同时填`); return
      }
    }

    setSaving(true)
    try {
      const body = {
        date, word, summary: summary.trim(),
        entries: validEntries.map(e => ({
          accountCode: e.accountCode.trim(),
          accountName: e.accountName.trim() || coa?.find(a => a.code === e.accountCode.trim())?.name || '',
          debit: Number(e.debit) || 0,
          credit: Number(e.credit) || 0,
          summary: e.summary.trim() || undefined,
        })),
      }
      let resultId: string
      if (isEdit && editId) {
        // PATCH 编辑
        const updated = await apiFetch<{ id: string }>(`/api/vouchers/${editId}`, {
          method: 'PATCH', body: JSON.stringify(body),
        })
        resultId = updated.id
      } else {
        // POST 新建
        const created = await apiFetch<{ id: string; no: string }>('/api/vouchers', {
          method: 'POST', body: JSON.stringify(body),
        })
        resultId = created.id
      }
      router.replace(`/v2/finance-pc/vouchers/${resultId}`)
    } catch (e: any) {
      setError(e?.message || '保存失败')
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1200px] mx-auto px-6 py-6">
        <div className="flex items-center gap-2 mb-4">
          <a href="/v2/finance-pc/vouchers" className="text-gray2 hover:text-ink text-caption">← 凭证列表</a>
          <span className="text-gray3">/</span>
          {isEdit && editingVoucher ? (
            <>
              <a href={`/v2/finance-pc/vouchers/${editId}`} className="text-gray2 hover:text-ink text-caption font-num">{editingVoucher.no}</a>
              <span className="text-gray3">/</span>
              <span className="text-caption text-gray2">编辑</span>
            </>
          ) : (
            <span className="text-caption text-gray2">新建凭证</span>
          )}
        </div>

        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">{isEdit ? `编辑凭证 ${editingVoucher?.no || ''}` : '新建凭证'}</h1>
            <p className="text-caption text-gray3">
              {isEdit ? '修改分录 (仅 DRAFT 可改, 已导出不可改)' : '手工录入 · sourceType=Manual'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => router.back()}
                    className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
            <button onClick={save} disabled={saving || loadingEdit || !balanced || !summary.trim()}
                    className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
              {saving ? '保存中…' : (isEdit ? '保存修改' : '保存草稿')}
            </button>
          </div>
        </div>

        {loadingEdit && <div className="bg-bg-warm rounded-card p-3 text-caption text-gray3 mb-4">加载凭证中…</div>}

        {coaError && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">科目表: {coaError}</div>}
        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {/* 凭证头 */}
        <section className="bg-white rounded-card border border-border p-4 mb-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-micro text-gray3 block mb-1.5">凭证日期</label>
              <DatePicker value={date} onChange={setDate} quickButtons={['today', 'yesterday', 'monthEnd', 'lastMonthEnd']} />
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1.5">字别</label>
              <input value={word} onChange={e => setWord(e.target.value)}
                     className="px-3 py-2 rounded-cta border border-border bg-white text-button w-24" />
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1.5">摘要 *</label>
              <input value={summary} onChange={e => setSummary(e.target.value)}
                     placeholder="例: 5 月房租支付"
                     className="px-3 py-2 rounded-cta border border-border bg-white text-button w-full" />
            </div>
          </div>
        </section>

        {/* 分录表 */}
        <section className="bg-white rounded-card border border-border overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-h2">分录明细 ({entries.length} 行)</h2>
            <button onClick={addRow} className="px-3 py-1.5 bg-white border border-border rounded-cta text-button text-gray2">+ 加行</button>
          </header>
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal w-12">行</th>
                <th className="px-3 py-2 font-normal w-32">科目编码</th>
                <th className="px-3 py-2 font-normal w-44">科目名称</th>
                <th className="px-3 py-2 font-normal">摘要</th>
                <th className="px-3 py-2 font-normal text-right w-32">借方 (¥)</th>
                <th className="px-3 py-2 font-normal text-right w-32">贷方 (¥)</th>
                <th className="px-3 py-2 font-normal w-12"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-2 text-gray3 text-caption">{i + 1}</td>
                  <td className="px-3 py-2">
                    <input value={e.accountCode}
                           onChange={ev => onCodeChange(i, ev.target.value)}
                           list="coa-codes"
                           placeholder="如 5601"
                           className="w-full px-2 py-1 rounded border border-border bg-white text-caption font-num" />
                  </td>
                  <td className="px-3 py-2">
                    <input value={e.accountName}
                           onChange={ev => updateEntry(i, { accountName: ev.target.value })}
                           placeholder="自动填充 (可改)"
                           className="w-full px-2 py-1 rounded border border-border bg-white text-caption" />
                  </td>
                  <td className="px-3 py-2">
                    <input value={e.summary}
                           onChange={ev => updateEntry(i, { summary: ev.target.value })}
                           placeholder="可选 (默认用凭证摘要)"
                           className="w-full px-2 py-1 rounded border border-border bg-white text-caption" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" step="0.01" value={e.debit}
                           onChange={ev => updateEntry(i, { debit: ev.target.value, credit: ev.target.value && Number(ev.target.value) > 0 ? '' : e.credit })}
                           placeholder="0.00"
                           className="w-full px-2 py-1 rounded border border-border bg-white text-caption font-num text-right" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" step="0.01" value={e.credit}
                           onChange={ev => updateEntry(i, { credit: ev.target.value, debit: ev.target.value && Number(ev.target.value) > 0 ? '' : e.debit })}
                           placeholder="0.00"
                           className="w-full px-2 py-1 rounded border border-border bg-white text-caption font-num text-right" />
                  </td>
                  <td className="px-3 py-2 text-center">
                    {entries.length > 2 && (
                      <button onClick={() => removeRow(i)} className="text-red-fg hover:bg-red-bg/40 rounded w-6 h-6 text-caption">×</button>
                    )}
                  </td>
                </tr>
              ))}
              {/* 合计行 */}
              <tr className={`border-t border-border ${balanced ? 'bg-green-bg/30' : 'bg-red-bg/30'}`}>
                <td colSpan={4} className="px-3 py-2.5 text-right text-caption text-gray2">合计</td>
                <td className="px-3 py-2.5 font-num text-right text-h2">¥{debitSum.toFixed(2)}</td>
                <td className="px-3 py-2.5 font-num text-right text-h2">¥{creditSum.toFixed(2)}</td>
                <td className="px-3 py-2.5 text-center">
                  {balanced ? <span className="text-green-fg">✓</span> : <span className="text-red-fg" title={`差 ${diff.toFixed(2)}`}>✗</span>}
                </td>
              </tr>
              {!balanced && (
                <tr className="border-t border-border bg-red-bg/20">
                  <td colSpan={7} className="px-3 py-2 text-caption text-red-fg">
                    ⚠ 借贷不平: 差 ¥{diff.toFixed(2)} ({diff > 0 ? '借方多' : '贷方多'}). 修复差额才能保存.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {/* CoA datalist for autocomplete */}
          {coa && (
            <datalist id="coa-codes">
              {coa.filter(a => a.isDetail).map(a => (
                <option key={a.id} value={a.code}>{a.code} {a.name}</option>
              ))}
            </datalist>
          )}
        </section>

        <div className="mt-3 text-caption text-gray3">
          💡 常用科目: 1001 库存现金 / 1002 银行存款 / 2202 应付账款 / 5001 主营业务收入 / 5601 销售费用 / 5602 管理费用
        </div>
      </main>
    </div>
  )
}
