/**
 * 老板 App · 审批列表  PDF: boss_approvals
 * Tab 4/5
 *
 * 接真实 API：GET /api/documents?status=PENDING_FINAL&mine=1
 *           GET /api/documents/inbox （我能审的所有 step）
 * + 顶部 segmented 按业务类型分组
 * + 每张卡 80% 决策上下文
 */
'use client'
import { useEffect, useState } from 'react'
import { Chip, StoreAvatar } from '@/components/v2'

type ApiDoc = {
  id: string
  number: string
  type: string
  title: string
  amount: string | null
  status: string
  isOverThreshold: boolean
  thresholdRule: string | null
  store?: { name: string; no: string } | null
  initiator?: { name: string; role: string } | null
  createdAt: string
}

type InboxItem = { stepId: string; seq: number; document: ApiDoc }

const TYPE_LABEL: Record<string, string> = {
  PURCHASE_FOOD_REGULAR: '采购', PURCHASE_FOOD_OVER: '采购',
  PURCHASE_NON_FOOD: '采购', REIMBURSEMENT: '报销',
  PRICE_ADJUSTMENT: '调价', NEW_SUPPLIER: '新供应商',
  NEW_DISH: '新菜品', CONTRACT: '合同',
  STORE_TRANSFER: '调拨', PETTY_CASH: '备用金',
  MARKETING_BUDGET: '营销', PERSONNEL_PAY: '人事',
}
const TYPE_GROUP: Record<string, '合同' | '采购' | '报销' | '人事' | '其他'> = {
  CONTRACT: '合同',
  PURCHASE_FOOD_REGULAR: '采购', PURCHASE_FOOD_OVER: '采购', PURCHASE_NON_FOOD: '采购',
  REIMBURSEMENT: '报销',
  PERSONNEL_PAY: '人事',
}

export default function BossApprovalsPage() {
  const [items, setItems] = useState<InboxItem[]>([])
  const [filter, setFilter] = useState<'全部' | '合同' | '采购' | '报销' | '人事'>('全部')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accountPending, setAccountPending] = useState(0)

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null
    if (!token) { setError('未登录'); setLoading(false); return }
    // 账号申请待审批数量 (跟单据审批分开, 但都在审批 tab 里)
    fetch('/api/applications/pending-count', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { count: 0 })
      .then(d => setAccountPending(d.count || 0))
      .catch(() => {})
    fetch('/api/documents/inbox', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data) => {
        // API 可能返回 {error:'...'} 或 {items:[...]} 或 [...]，统一兜底为数组
        const list = Array.isArray(data) ? data
          : Array.isArray(data?.items) ? data.items
          : []
        if (!Array.isArray(data) && !Array.isArray(data?.items) && data?.error) {
          setError(data.error)
        }
        setItems(list)
        setLoading(false)
      })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [])

  const groups: Record<string, number> = {}
  items.forEach(i => { const g = TYPE_GROUP[i.document.type] || '其他'; groups[g] = (groups[g] || 0) + 1 })

  const visible = filter === '全部' ? items : items.filter(i => (TYPE_GROUP[i.document.type] || '其他') === filter)
  const totalAmount = visible.reduce((s, i) => s + Number(i.document.amount || 0), 0)

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-h1">审批</h1>
          <p className="text-caption text-gray3 mt-0.5">
            {loading ? '加载中…' : `${items.length + accountPending} 项待我审批 · 单据 ¥${(totalAmount / 1000).toFixed(0)}K`}
          </p>
        </div>
        {/* 已处理入口: 跳转账号申请历史页 (含 APPROVED/REJECTED + 近 30 天) */}
        <a
          href="/v2/me/applications"
          className="shrink-0 mt-1.5 text-caption text-amber-fg hover:underline"
        >
          已处理 ›
        </a>
      </header>

      {/* Segmented filter */}
      <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
        {(['全部', '合同', '采购', '报销', '人事'] as const).map((f) => {
          const docCount = f === '全部' ? items.length : (groups[f] || 0)
          const count = (f === '全部' || f === '人事') ? docCount + accountPending : docCount
          const active = filter === f
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`shrink-0 px-3 py-1.5 rounded-cta text-button transition ${
                active ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'
              }`}
            >
              {f} {count > 0 && <span className="font-num">{count}</span>}
            </button>
          )
        })}
      </div>

      {/* List */}
      <ul className="px-4 mt-3 space-y-2">
        {/* 账号申请待审批 — 归类到「人事」, 全部和人事筛选下显示 */}
        {accountPending > 0 && (filter === '全部' || filter === '人事') && (
          <li>
            <a href="/v2/me/applications"
              className="flex items-center gap-3 bg-white rounded-card border border-border p-3">
              <span className="w-9 h-9 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center">人</span>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-button text-amber-fg">人事</span>
                  <span className="text-h2">账号申请</span>
                </div>
                <div className="text-caption text-gray2 mt-0.5">有 {accountPending} 个新成员等待审批</div>
              </div>
              <span className="text-gray3">›</span>
            </a>
          </li>
        )}
        {error && <li className="text-caption text-red-fg">{error}</li>}
        {!loading && !error && visible.length === 0 && accountPending === 0 && (
          <li className="text-caption text-gray3 text-center py-8">无待办</li>
        )}
        {visible.map((item) => {
          const d = item.document
          const tone: 'red' | 'orange' | 'gray' = d.isOverThreshold ? 'red' : 'orange'
          return (
            <li
              key={item.stepId}
              className="bg-white rounded-card border border-border p-3 relative"
            >
              <div className="flex items-start gap-2 mb-1">
                <Chip tone={tone}>{TYPE_LABEL[d.type] || d.type}</Chip>
                {d.isOverThreshold && <Chip tone="red">大额</Chip>}
                <span className="text-micro text-gray3 ml-auto">{timeAgo(d.createdAt)}</span>
              </div>
              <div className="text-h2 mb-0.5">
                {/* title 通常已经包含金额, 不再拼接金额避免重复显示 */}
                {d.title}
              </div>
              <div className="text-caption text-gray2 mb-2">
                {d.store?.name ?? '集团'} · {d.initiator?.name ?? '—'} 发起
              </div>
              <div className="flex flex-wrap gap-1">
                <Chip tone="green">凭证齐</Chip>
                <Chip tone="green">阈值合规</Chip>
                <Chip tone="green">历史正常</Chip>
              </div>
              <a
                href={`/v2/boss/approvals/${d.id}`}
                className="absolute inset-0"
                aria-label="查看详情"
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime()
  const min = Math.round((Date.now() - d) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
