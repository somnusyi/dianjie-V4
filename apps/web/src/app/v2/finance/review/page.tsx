/**
 * 财务 App · 初审 Tab  PDF: finance_review_tab  Tab 2/4
 *
 * 接真实 GET /api/documents/inbox · 内联 POST /api/documents/:id/decisions
 * 阈值前置告知 + 路由可视（→ 老板 / → 直接生效）
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip, StoreAvatar } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch } from '@/lib/v2-auth'

type ApiDoc = {
  id: string; number: string; type: string; title: string
  amount: string | null; status: string
  isOverThreshold: boolean; thresholdRule: string | null
  store?: { name: string; no: string } | null
  initiator?: { name: string; role: string } | null
  createdAt: string
  payload?: any
}
type Item = { stepId: string; seq: number; document: ApiDoc }

const TYPE_LABEL: Record<string, string> = {
  PETTY_CASH: '备用金', REIMBURSEMENT: '报销',
  PURCHASE_FOOD_REGULAR: '食材采购', PURCHASE_FOOD_OVER: '食材采购·超阈',
  PURCHASE_NON_FOOD: '采购', CONTRACT: '合同',
  STORE_TRANSFER: '调拨', MARKETING_BUDGET: '营销预算',
  PERSONNEL_PAY: '调薪', NEW_SUPPLIER: '新供应商',
}

export default function FinanceReviewPage() {
  const [tab, setTab] = useState('review')
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [storeFilter, setStoreFilter] = useState<string>('全部')
  const [typeFilter, setTypeFilter] = useState<string>('全部')
  // 批量选中
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = useState(false)
  const [confirmState, openConfirm] = useConfirmSheet()

  async function load() {
    try {
      const data = await apiFetch<Item[]>('/api/documents/inbox')
      setItems(data)
    } catch (e: any) { setError(e.message || '加载失败') }
  }
  useEffect(() => { load() }, [])

  function decide(item: Item, decision: 'APPROVE' | 'REJECT') {
    if (submitting) return
    const post = async () => {
      setSubmitting(item.document.id)
      try {
        await apiFetch(`/api/documents/${item.document.id}/decisions`, {
          method: 'POST',
          body: JSON.stringify({ decision }),
        })
        await load()
      } catch (e: any) { alert(e.message || '操作失败'); throw e }
      finally { setSubmitting(null) }
    }
    if (decision === 'APPROVE') {
      openConfirm({
        title: `通过 ${item.document.title}?`,
        confirmLabel: '通过',
        tone: 'primary',
        onConfirm: post,
      })
    } else {
      post()
    }
  }

  // 按门店 + 类型 双 filter
  const stores = Array.from(new Set<string>(items?.map(i => i.document.store?.name || '集团') || []))
  const types  = Array.from(new Set<string>(items?.map(i => i.document.type) || []))
  const visible = items?.filter(i =>
    (storeFilter === '全部' || (i.document.store?.name === storeFilter || (storeFilter === '集团' && !i.document.store))) &&
    (typeFilter === '全部' || i.document.type === typeFilter)
  ) || []
  const totalAmount = visible.reduce((s, i) => s + Number(i.document.amount || 0), 0)
  const selectedTotal = visible.filter(i => selected.has(i.document.id)).reduce((s, i) => s + Number(i.document.amount || 0), 0)

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function selectAll() {
    setSelected(new Set(visible.map(i => i.document.id)))
  }
  async function batchApprove() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    openConfirm({
      title: `批量批准 ${ids.length} 单?`,
      body: `合计 ¥${selectedTotal.toLocaleString()} · 任意一单失败会停止后续批准`,
      confirmLabel: '确认批准',
      tone: 'primary',
      onConfirm: async () => {
        for (const id of ids) {
          try {
            await apiFetch(`/api/documents/${id}/decisions`, { method: 'POST', body: JSON.stringify({ decision: 'APPROVE' }) })
          } catch (e: any) { alert(`${id}: ${e.message || '失败'}`); break }
        }
        setSelected(new Set()); setBatchMode(false); load()
      },
    })
  }

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-h1">初审</h1>
          <p className="text-caption text-gray3">
            {items === null ? '加载中…' : `${visible.length} 单待审 · ¥${totalAmount.toLocaleString()}`}
          </p>
        </div>
        {(items?.length ?? 0) > 0 && (
          <button onClick={() => { setBatchMode(b => !b); setSelected(new Set()) }}
                  className={`px-3 py-1.5 rounded-cta text-button shrink-0 ${batchMode ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {batchMode ? '取消批量' : '批量勾选'}
          </button>
        )}
      </header>

      {/* 门店筛选 */}
      {stores.length > 1 && (
        <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
          <button onClick={() => setStoreFilter('全部')}
            className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${storeFilter === '全部' ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            全部 {items?.length ?? 0}
          </button>
          {stores.map(s => (
            <button key={s} onClick={() => setStoreFilter(s)}
              className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${storeFilter === s ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {s} {items?.filter(i => (i.document.store?.name || '集团') === s).length ?? 0}
            </button>
          ))}
        </div>
      )}
      {/* 类型筛选 */}
      {types.length > 1 && (
        <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
          <button onClick={() => setTypeFilter('全部')}
            className={`shrink-0 px-3 py-1 rounded-chip text-caption ${typeFilter === '全部' ? 'bg-amber/20 text-amber-fg' : 'bg-bg text-gray3'}`}>
            类型 全部
          </button>
          {types.map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`shrink-0 px-3 py-1 rounded-chip text-caption ${typeFilter === t ? 'bg-amber/20 text-amber-fg' : 'bg-bg text-gray3'}`}>
              {TYPE_LABEL[t] || t}
            </button>
          ))}
        </div>
      )}

      {/* 批量操作栏 */}
      {batchMode && (
        <div className="mx-4 mt-3 bg-amber/10 border border-amber/30 rounded-card p-3 flex items-center gap-2">
          <span className="text-caption">已选 <b className="font-num">{selected.size}</b> · 合计 <b className="font-num">¥{selectedTotal.toLocaleString()}</b></span>
          <button onClick={selectAll}
                  className="ml-auto px-3 py-1.5 border border-border bg-white rounded-cta text-caption">全选当前</button>
          <button onClick={batchApprove} disabled={selected.size === 0}
                  className="px-3 py-1.5 bg-ink text-white rounded-cta text-caption disabled:opacity-40">批量批准</button>
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>
      )}

      <ul className="px-4 mt-3 space-y-2">
        {items?.length === 0 && (
          <li className="text-caption text-gray3 text-center py-12">暂无待我初审的单据</li>
        )}
        {visible.map(item => {
          const d = item.document
          const tone: 'red' | 'orange' | 'gray' = d.isOverThreshold ? 'red' : 'orange'
          const route = d.isOverThreshold ? '→ 老板' : '→ 直接生效'
          const routeColor = d.isOverThreshold ? 'text-red-fg' : 'text-green-fg'
          const isSelected = selected.has(d.id)
          return (
            <li key={item.stepId} className={`relative bg-white rounded-card p-3 pl-4 border ${isSelected ? 'border-amber border-2' : 'border-border'} before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${tone === 'red' ? 'before:bg-red' : 'before:bg-orange'}`}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {batchMode && (
                  <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(d.id)}
                         className="w-4 h-4" />
                )}
                <Chip tone={tone}>{TYPE_LABEL[d.type] || d.type}</Chip>
                {d.isOverThreshold && <Chip tone="red">超阈值</Chip>}
                <span className="text-micro text-gray3 ml-auto">{timeAgo(d.createdAt)}</span>
              </div>
              <div className="flex items-start gap-3">
                {d.store && <StoreAvatar name={d.store.name} size="sm" />}
                <div className="flex-1 min-w-0">
                  <div className="text-h2">{d.title}</div>
                  <p className="text-caption text-gray2 mt-0.5">
                    {d.store?.name ?? '集团'} · {d.initiator?.name ?? '—'} 发起
                    {d.thresholdRule && ` · ${d.thresholdRule}`}
                  </p>
                  <p className={`text-micro mt-1 ${routeColor}`}>{route}</p>
                </div>
                <div className="text-right">
                  <div className="font-num text-h2">¥{Number(d.amount || 0).toLocaleString()}</div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => decide(item, 'REJECT')}
                  disabled={submitting === d.id}
                  className="px-4 py-2 border border-red text-red rounded-cta text-button disabled:opacity-40"
                >驳回</button>
                <button
                  onClick={() => decide(item, 'APPROVE')}
                  disabled={submitting === d.id}
                  className="flex-1 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40"
                >
                  {submitting === d.id ? '提交中…' : `批准 · ¥${Number(d.amount || 0).toLocaleString()}`}
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <BottomNav
        tabs={[
          { key: 'home',   label: '工作台', icon: '⌂' },
          { key: 'review', label: '初审',   icon: '✓' },
          { key: 'funds',  label: '资金',   icon: '⛁' },
          { key: 'stores', label: '各店',   icon: '↗' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')   location.href = '/v2/finance/home'
          if (k === 'funds')  location.href = '/v2/finance/funds'
          if (k === 'stores') location.href = '/v2/finance/stores'
        }}
      />

      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function timeAgo(iso: string) {
  const d = new Date(iso).getTime()
  const min = Math.round((Date.now() - d) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
