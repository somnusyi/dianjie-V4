/**
 * 总厨 App · 审批 Tab  PDF: chef_director_approvals_tab  Tab 2/4
 * 真实接 GET /api/documents/inbox + 内联 POST /api/documents/:id/decisions
 *
 * 总厨负责: 调价(PRICE_ADJUSTMENT,跳财务直送)/新供应商/新菜品/新菜品 4 类
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch } from '@/lib/v2-auth'

type ApiDoc = {
  id: string; number: string; type: string; title: string
  amount: string | null; status: string
  isOverThreshold: boolean; thresholdRule: string | null
  payload: any
  store?: { name: string } | null
  initiator?: { name: string; role: string } | null
  createdAt: string
}
type Item = { stepId: string; seq: number; document: ApiDoc }

const TYPE_LABEL: Record<string, string> = {
  PRICE_ADJUSTMENT: '调价',
  NEW_SUPPLIER: '新供应商',
  NEW_DISH: '新菜品',
}
const TYPE_TONE: Record<string, 'red' | 'orange' | 'gray'> = {
  PRICE_ADJUSTMENT: 'red',
  NEW_SUPPLIER: 'orange',
  NEW_DISH: 'gray',
}

export default function ChefDirectorApprovalsPage() {
  const [tab, setTab] = useState('review')
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [filter, setFilter] = useState<'全部' | string>('全部')
  const [confirmState, openConfirm] = useConfirmSheet()
  const [previews, setPreviews] = useState<Record<string, any>>({})   // docId → preview data
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [fullSheet, setFullSheet] = useState<{docId: string; data: any} | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)

  async function openFullList(docId: string) {
    setLoadingFull(true)
    try {
      const data = await apiFetch<any>(`/api/documents/${docId}/preview?full=1`)
      setFullSheet({ docId, data })
    } catch (e: any) {
      alert(e.message || '加载失败')
    } finally { setLoadingFull(false) }
  }

  async function loadPreview(docId: string) {
    if (previews[docId]) return
    try {
      const data = await apiFetch<any>(`/api/documents/${docId}/preview`)
      setPreviews(prev => ({ ...prev, [docId]: data }))
    } catch (e) {
      setPreviews(prev => ({ ...prev, [docId]: { kind: 'ERROR' } }))
    }
  }
  function toggleExpand(docId: string) {
    setExpanded(prev => {
      const n = new Set(prev)
      if (n.has(docId)) n.delete(docId); else { n.add(docId); loadPreview(docId) }
      return n
    })
  }

  async function load() {
    try {
      const data = await apiFetch<Item[]>('/api/documents/inbox')
      setItems(data)
    } catch (e: any) { setError(e.message || '加载失败') }
  }
  useEffect(() => { load() }, [])

  function decide(item: Item, decision: 'APPROVE' | 'REJECT') {
    if (submitting) return
    if (decision === 'APPROVE') {
      openConfirm({
        title: '确认批准?',
        body: item.document.title,
        confirmLabel: '批准',
        tone: 'primary',
        onConfirm: () => doPost(item, 'APPROVE'),
      })
    } else {
      openConfirm({
        title: `驳回 ${item.document.title}`,
        body: '请简述驳回原因，将通知发起人。',
        confirmLabel: '驳回',
        tone: 'danger',
        withInput: true,
        inputRequired: true,
        inputPlaceholder: '例如：金额超阈值/资质不符…',
        onConfirm: (note) => doPost(item, 'REJECT', note),
      })
    }
  }
  async function doPost(item: Item, decision: 'APPROVE' | 'REJECT', comment?: string) {
    setSubmitting(item.document.id)
    try {
      await apiFetch(`/api/documents/${item.document.id}/decisions`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment }),
      })
      await load()
    } catch (e: any) { alert(e.message || '操作失败') }
    setSubmitting(null)
  }

  const visible = (items || []).filter(i => filter === '全部' || i.document.type === filter)
  const groupCount: Record<string, number> = {}
  ;(items || []).forEach(i => { groupCount[i.document.type] = (groupCount[i.document.type] || 0) + 1 })

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">审批</h1>
          <p className="text-caption text-gray3">{items === null ? '加载中…' : `待我处理 ${items.length} 项`}</p>
        </div>
      </header>

      <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
        {(['全部', 'PRICE_ADJUSTMENT', 'NEW_SUPPLIER', 'NEW_DISH'] as const).map((f) => {
          const cnt = f === '全部' ? items?.length ?? 0 : (groupCount[f] || 0)
          return (
            <button key={f}
              onClick={() => setFilter(f)}
              className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${filter === f ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {f === '全部' ? '全部' : TYPE_LABEL[f] || f} {cnt > 0 && <span className="font-num">{cnt}</span>}
            </button>
          )
        })}
      </div>

      <p className="px-4 mt-2 text-micro text-gray3">⊕ 紧急优先 · 调价单跳过财务直送总厨</p>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      <ul className="px-4 mt-2 space-y-2">
        {items?.length === 0 && <li className="text-caption text-gray3 text-center py-12">暂无待我审批的单据</li>}
        {visible.map(item => {
          const d = item.document
          const tone = TYPE_TONE[d.type] || 'gray'
          const p = d.payload || {}
          return (
            <li key={item.stepId} className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${tone === 'red' ? 'before:bg-red' : tone === 'orange' ? 'before:bg-orange' : 'before:bg-gray4'}`}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Chip tone={tone}>{TYPE_LABEL[d.type] || d.type}</Chip>
                {d.isOverThreshold && <Chip tone="red">超阈值</Chip>}
                {d.type === 'PRICE_ADJUSTMENT' && <Chip tone="orange">跳财务</Chip>}
                <span className="text-micro text-gray3 ml-auto">{timeAgo(d.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-h2">{d.title}</span>
                {d.amount && <span className="font-num text-h2">¥{Number(d.amount).toLocaleString()}</span>}
              </div>
              <p className="text-caption text-gray2 mt-0.5">
                {d.store?.name ?? '集团'} · {d.initiator?.name ?? '—'} 发起
              </p>
              {/* 80% 决策上下文嵌卡内 */}
              {d.type === 'PRICE_ADJUSTMENT' && p.oldPrice != null && p.newPrice != null && (
                <p className="text-caption font-num mt-1">
                  ¥{p.oldPrice} → <b className="text-red-fg">¥{p.newPrice}</b>
                  {p.delta != null && <span className={p.delta > 0 ? 'text-red-fg ml-2' : 'text-green-fg ml-2'}>
                    {p.delta > 0 ? '↑' : '↓'}{Math.abs(p.delta).toFixed(2)} ({p.pct}%)
                  </span>}
                </p>
              )}
              {/* 批量上架: 显示总数 + 供应商 + 文件名 */}
              {d.type === 'NEW_DISH' && p.action === 'BATCH' && (
                <div className="text-caption text-gray2 mt-1">
                  📦 <b className="font-num">{p.count}</b> 个 SKU · {p.supplierName || '未知供应商'}
                  {p.filename && <span className="text-micro text-gray3 ml-1">({p.filename})</span>}
                </div>
              )}
              {/* 单条新建/停售: 内嵌简要 */}
              {d.type === 'NEW_DISH' && p.action === 'CREATE' && (
                <div className="text-caption text-gray2 mt-1">
                  {p.spec && <>规格 {p.spec} · </>}单价 <b className="font-num">¥{p.price}</b> / {p.unit} · {p.supplierName}
                </div>
              )}
              {d.type === 'NEW_DISH' && p.action === 'DISABLE' && (
                <div className="text-caption text-gray2 mt-1">{p.supplierName} 申请下架</div>
              )}

              {/* 「查看明细」展开块 */}
              <button onClick={() => toggleExpand(d.id)} className="mt-2 text-caption text-amber-fg">
                {expanded.has(d.id) ? '收起明细 ▴' : '查看明细 ▾'}
              </button>
              {expanded.has(d.id) && previews[d.id] && (
                <ApprovalPreview preview={previews[d.id]} onOpenFull={() => openFullList(d.id)} />
              )}
              {expanded.has(d.id) && !previews[d.id] && (
                <div className="text-caption text-gray3 mt-1">加载中…</div>
              )}
              {p.note && <p className="text-micro text-gray3 mt-1">{p.note}</p>}
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button
                  onClick={() => decide(item, 'REJECT')}
                  disabled={submitting === d.id}
                  className="py-2 border border-red text-red rounded-cta text-button disabled:opacity-40"
                >驳回</button>
                <button
                  onClick={() => decide(item, 'APPROVE')}
                  disabled={submitting === d.id}
                  className="py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40"
                >{submitting === d.id ? '提交中…' : '批准'}</button>
              </div>
            </li>
          )
        })}
      </ul>

      <BottomNav
        tabs={[
          { key: 'home',     label: '工作台', icon: '⌂' },
          { key: 'review',   label: '审批',   icon: '✓' },
          { key: 'material', label: '物料',   icon: '⛁' },
          { key: 'loss',     label: '报损',   icon: '△' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')     location.href = '/v2/chef-director/home'
          if (k === 'material') location.href = '/v2/chef-director/inventory'
          if (k === 'loss')     location.href = '/v2/chef-director/loss'
        }}
      />

      <ConfirmSheet {...confirmState} />

      {/* 全量明细 sheet */}
      {fullSheet && (
        <div className="fixed inset-0 z-50 bg-ink/40 flex items-end" onClick={() => setFullSheet(null)}>
          <div className="w-full max-h-[85vh] bg-white rounded-t-2xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 pt-3 pb-2 border-b border-border flex items-center gap-2">
              <h2 className="text-h2 flex-1">全量明细 · {fullSheet.data.total} 条</h2>
              <button onClick={() => setFullSheet(null)} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <div className="px-4 py-2 text-caption text-gray2 border-b border-border">
              {fullSheet.data.supplierName && <span>{fullSheet.data.supplierName} · </span>}
              <span className="text-amber-fg">含价 {fullSheet.data.withPrice}</span>
              {fullSheet.data.noPrice > 0 && <span className="text-red-fg ml-2">无价 {fullSheet.data.noPrice}</span>}
            </div>
            <ul className="flex-1 overflow-auto divide-y divide-border">
              {fullSheet.data.sample.map((p: any, idx: number) => (
                <li key={p.id} className="px-4 py-2 flex items-center gap-2 text-caption">
                  <span className="text-micro text-gray3 font-num w-8">{idx + 1}</span>
                  <span className="flex-1 min-w-0">
                    <div className="truncate">{p.name}</div>
                    {p.spec && <div className="text-micro text-gray3 truncate">{p.spec}</div>}
                  </span>
                  <span className="text-micro text-gray3">{p.category}</span>
                  <span className="font-num min-w-[60px] text-right">
                    {p.price > 0 ? `¥${p.price}` : <span className="text-red-fg">¥0</span>}
                  </span>
                  <span className="text-micro text-gray3 w-8">/{p.unit}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {loadingFull && (
        <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center">
          <div className="bg-white rounded-card px-4 py-3 text-caption">加载全量明细…</div>
        </div>
      )}
    </div>
  )
}

function ApprovalPreview({ preview, onOpenFull }: { preview: any; onOpenFull?: () => void }) {
  if (preview.kind === 'PRICE_ADJUSTMENT') {
    const pr = preview.product
    if (!pr) return <p className="text-micro text-red-fg mt-2">商品已被删除</p>
    return (
      <div className="mt-2 bg-bg rounded p-2 text-caption text-gray2">
        <div><b>{pr.name}</b> {pr.spec ? `· ${pr.spec}` : ''}</div>
        <div className="font-num text-micro mt-0.5">#{pr.code} · {pr.unit} · 类目 {pr.category} · 供应商 {pr.supplier?.name || '-'}</div>
        <div className="mt-1 font-num">当前 ¥{pr.price} → 申请改为 ¥{preview.newPrice}</div>
      </div>
    )
  }
  if (preview.kind === 'NEW_DISH_CREATE') {
    const pr = preview.product
    if (!pr) return <p className="text-micro text-red-fg mt-2">商品已被删除</p>
    return (
      <div className="mt-2 bg-bg rounded p-2 text-caption text-gray2">
        <div><b>{pr.name}</b></div>
        <table className="w-full mt-1 text-micro font-num">
          <tbody>
            <tr><td className="text-gray3 w-16">编码</td><td>{pr.code}</td></tr>
            <tr><td className="text-gray3">规格</td><td>{pr.spec || '-'}</td></tr>
            <tr><td className="text-gray3">单位</td><td>{pr.unit}</td></tr>
            <tr><td className="text-gray3">类目</td><td>{pr.category}</td></tr>
            <tr><td className="text-gray3">单价</td><td>¥{pr.price}</td></tr>
            <tr><td className="text-gray3">保质期</td><td>{pr.shelfDays} 天</td></tr>
            <tr><td className="text-gray3">供应商</td><td>{pr.supplier?.name || '-'}</td></tr>
          </tbody>
        </table>
      </div>
    )
  }
  if (preview.kind === 'NEW_DISH_BATCH') {
    return (
      <div className="mt-2 bg-bg rounded p-2 text-caption text-gray2">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span>共 <b className="font-num">{preview.total}</b> 个 SKU</span>
          <span className="text-amber-fg">含价 <b className="font-num">{preview.withPrice}</b></span>
          {preview.noPrice > 0 && <span className="text-red-fg">无价 <b className="font-num">{preview.noPrice}</b></span>}
        </div>
        {preview.byCategory && Object.keys(preview.byCategory).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(preview.byCategory).slice(0, 8).map(([cat, cnt]: any) => (
              <span key={cat} className="text-micro bg-white border border-border rounded px-1.5 py-0.5">{cat} {cnt}</span>
            ))}
          </div>
        )}
        <div className="mt-2 text-micro text-gray3">前 {preview.sample.length} 条:</div>
        <ul className="mt-1 max-h-72 overflow-auto divide-y divide-border bg-white rounded">
          {preview.sample.map((p: any) => (
            <li key={p.id} className="px-2 py-1.5 flex items-center gap-2 text-micro">
              <span className="flex-1 truncate">{p.name}{p.spec ? ` (${p.spec})` : ''}</span>
              <span className="text-gray3">{p.category}</span>
              <span className="font-num">{p.price > 0 ? `¥${p.price}` : <span className="text-red-fg">¥0</span>}</span>
              <span className="text-gray3 text-micro">/{p.unit}</span>
            </li>
          ))}
        </ul>
        {preview.total > preview.sample.length && (
          <button onClick={onOpenFull}
            className="mt-2 w-full py-2 bg-amber/10 text-amber-fg border border-amber/30 rounded-cta text-caption">
            查看全部 {preview.total} 条 ›
          </button>
        )}
      </div>
    )
  }
  if (preview.kind === 'NEW_DISH_DISABLE') {
    const pr = preview.product
    if (!pr) return <p className="text-micro text-red-fg mt-2">商品已被删除</p>
    return (
      <div className="mt-2 bg-bg rounded p-2 text-caption text-gray2">
        <div><b>{pr.name}</b> {pr.spec ? `· ${pr.spec}` : ''}</div>
        <div className="font-num text-micro mt-0.5">#{pr.code} · 单价 ¥{pr.price} / {pr.unit} · 现有库存 {pr.stock}</div>
        <div className="mt-1">{pr.supplier?.name || '-'} 申请下架</div>
        {preview.recentOrders > 0 && (
          <div className="mt-2 text-red-fg">⚠ 近 28 天有 <b className="font-num">{preview.recentOrders}</b> 条订单引用此商品, 谨慎下架</div>
        )}
      </div>
    )
  }
  return <pre className="text-micro text-gray3 mt-2 whitespace-pre-wrap">{JSON.stringify(preview, null, 2)}</pre>
}

function timeAgo(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
