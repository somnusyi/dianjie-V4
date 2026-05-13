/**
 * v2 账号申请审批 · 老板/管理员
 */
'use client'
import { useEffect, useState } from 'react'
import { getToken } from '@/lib/v2-auth'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

const ROLE_LABEL: Record<string, string> = {
  MANAGER: '店长', KITCHEN_LEAD: '厨师长', CHEF_DIRECTOR: '总厨',
  FINANCE: '财务', PURCHASER: '采购', ENGINEERING: '工程部',
  ADMIN: '管理员', BOSS: '老板',
  SUPPLIER_OWNER: '供应商 · 公司负责人', SUPPLIER_STAFF: '供应商 · 员工',
}
const STATUS_LABEL: Record<string, string> = { PENDING: '待审批', APPROVED: '已通过', REJECTED: '已拒绝' }
const STATUS_COLOR: Record<string, string> = {
  PENDING: 'bg-amber/10 text-amber-fg',
  APPROVED: 'bg-green-50 text-green-700',
  REJECTED: 'bg-red-bg text-red-fg',
}

type Application = {
  id: string; name: string; phone: string
  requestedRole: string; reason: string | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  rejectReason: string | null
  createdAt: string; decidedAt: string | null
  // 供应商专用 (后端富化字段)
  supplierId: string | null
  supplierName: string | null
  joinedSupplier: { id: string; name: string; no: string } | null
  requestedStoreId: string | null
  requestedStore: { id: string; name: string; no: string } | null
}
type Store = { id: string; name: string; no: string }

export default function ApplicationsPage() {
  const [list, setList] = useState<Application[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<Application | null>(null)
  const [storeId, setStoreId] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  useEffect(() => { refresh() }, [])

  async function refresh() {
    setLoading(true)
    try {
      const t = getToken()
      const headers = { Authorization: `Bearer ${t}` }
      const [a, s] = await Promise.all([
        fetch('/api/applications', { headers }).then(r => r.json()),
        fetch('/api/stores', { headers }).then(r => r.json()),
      ])
      setList(Array.isArray(a) ? a : (a.items || []))
      setStores(Array.isArray(s) ? s : (s.items || []))
    } catch (e: any) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  async function approve() {
    if (!target) return
    if (['MANAGER', 'KITCHEN_LEAD'].includes(target.requestedRole) && !storeId) {
      setError(`${target.requestedRole === 'MANAGER' ? '店长' : '厨师长'}必须选门店`)
      return
    }
    try {
      const t = getToken()
      const res = await fetch(`/api/applications/${target.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ storeId: storeId || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '通过失败')
      setTarget(null); setMode(null); setStoreId(''); setError(null)
      refresh()
    } catch (e: any) {
      setError(e.message || '通过失败')
    }
  }
  async function reject() {
    if (!target) return
    if (!rejectReason.trim()) return setError('请说明拒绝原因')
    try {
      const t = getToken()
      const res = await fetch(`/api/applications/${target.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ reason: rejectReason.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '拒绝失败')
      setTarget(null); setMode(null); setRejectReason(''); setError(null)
      refresh()
    } catch (e: any) {
      setError(e.message || '拒绝失败')
    }
  }

  const pending = list.filter(a => a.status === 'PENDING')
  const handled = list.filter(a => a.status !== 'PENDING')

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/me" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1">账号申请</h1>
        {pending.length > 0 && (
          <span className="px-2 py-0.5 bg-amber text-white rounded-full text-micro font-medium">{pending.length}</span>
        )}
      </header>

      <div className="px-4 mt-2">
        {loading ? (
          <div className="text-caption text-gray3 py-8 text-center">加载中…</div>
        ) : list.length === 0 ? (
          <div className="bg-white rounded-card border border-border p-8 text-center text-caption text-gray3">
            暂无账号申请
          </div>
        ) : (
          <>
            {pending.length > 0 && (
              <>
                <div className="text-caption text-gray3 mb-2">待审批 ({pending.length})</div>
                <ul className="space-y-2 mb-4">
                  {pending.map(a => (
                    <ApplicationCard key={a.id} a={a}
                      onApprove={() => { setTarget(a); setMode('approve'); setStoreId(a.requestedStoreId || ''); setError(null) }}
                      onReject={() => { setTarget(a); setMode('reject'); setRejectReason(''); setError(null) }}
                    />
                  ))}
                </ul>
              </>
            )}
            {handled.length > 0 && (
              <>
                <div className="text-caption text-gray3 mb-2">最近 30 天已处理</div>
                <ul className="space-y-2">
                  {handled.map(a => <ApplicationCard key={a.id} a={a} />)}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      {/* 通过 sheet */}
      {target && mode === 'approve' && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => { setTarget(null); setMode(null) }}>
          <div className="w-full bg-white rounded-t-2xl p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">通过申请 · {target.name}</h2>
              <button onClick={() => { setTarget(null); setMode(null) }} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <div className="text-caption text-gray2 mb-3">
              {target.phone} · {ROLE_LABEL[target.requestedRole]}
              {target.requestedRole === 'SUPPLIER_OWNER' && target.supplierName && (
                <div className="mt-2 bg-amber/10 text-amber-fg rounded p-2">🏢 注册新公司: <b>{target.supplierName}</b></div>
              )}
              {target.requestedRole === 'SUPPLIER_STAFF' && target.joinedSupplier && (
                <div className="mt-2 bg-amber/10 text-amber-fg rounded p-2">🏢 加入: <b>{target.joinedSupplier.no} · {target.joinedSupplier.name}</b></div>
              )}
              {target.reason && <div className="mt-1 text-gray3">备注: {target.reason}</div>}
            </div>
            {(target.requestedRole === 'MANAGER' || target.requestedRole === 'KITCHEN_LEAD') && (
              <div className="mb-3">
                <label className="text-micro text-gray3 block mb-1">绑定门店 (必选)</label>
                {target.requestedStore && (
                  <p className="text-micro text-amber-fg mb-1">
                    申请人选了: {target.requestedStore.no} · {target.requestedStore.name}
                  </p>
                )}
                <select value={storeId} onChange={e => setStoreId(e.target.value)}
                  className="w-full bg-bg rounded p-2 outline-none text-body">
                  <option value="">{stores.length === 0 ? '请先创建门店' : '请选择门店'}</option>
                  {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption mb-3">{error}</div>}
            <button onClick={approve} className="w-full py-3 bg-amber text-white rounded-cta text-button">
              确认通过, 创建账号
            </button>
          </div>
        </div>
      )}

      {/* 拒绝 sheet */}
      {target && mode === 'reject' && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => { setTarget(null); setMode(null) }}>
          <div className="w-full bg-white rounded-t-2xl p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">拒绝申请 · {target.name}</h2>
              <button onClick={() => { setTarget(null); setMode(null) }} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)}
              maxLength={200} rows={3}
              className="w-full bg-bg rounded p-2 outline-none text-body mb-3"
              placeholder="说明拒绝原因, 申请人能看到" />
            {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption mb-3">{error}</div>}
            <button onClick={reject} disabled={!rejectReason.trim()}
              className="w-full py-3 bg-red-fg text-white rounded-cta text-button disabled:opacity-40">
              确认拒绝
            </button>
          </div>
        </div>
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )

  function ApplicationCard({ a, onApprove, onReject }: {
    a: Application; onApprove?: () => void; onReject?: () => void
  }) {
    return (
      <li className="bg-white rounded-card border border-border p-3">
        <div className="flex items-center gap-2">
          <span className="text-body font-medium flex-1">{a.name}</span>
          <span className={`text-micro px-1.5 py-0.5 rounded ${STATUS_COLOR[a.status]}`}>
            {STATUS_LABEL[a.status]}
          </span>
        </div>
        <div className="text-micro text-gray3 font-num mt-1">
          {a.phone} · {ROLE_LABEL[a.requestedRole] || a.requestedRole}
        </div>
        {/* 供应商场景: 高亮显示加入/注册哪家公司 */}
        {a.requestedRole === 'SUPPLIER_OWNER' && a.supplierName && (
          <div className="text-caption text-amber-fg mt-2 bg-amber/10 rounded p-2">
            🏢 注册新供应商: <b>{a.supplierName}</b>
            <div className="text-micro text-gray3 mt-0.5">通过后将创建该公司, 申请人成为公司负责人 (Owner)</div>
          </div>
        )}
        {a.requestedRole === 'SUPPLIER_STAFF' && a.joinedSupplier && (
          <div className="text-caption text-amber-fg mt-2 bg-amber/10 rounded p-2">
            🏢 加入已有供应商: <b>{a.joinedSupplier.no} · {a.joinedSupplier.name}</b>
            <div className="text-micro text-gray3 mt-0.5">通过后将以员工 (Staff) 身份加入该公司</div>
          </div>
        )}
        {['MANAGER', 'KITCHEN_LEAD'].includes(a.requestedRole) && a.requestedStore && (
          <div className="text-caption text-amber-fg mt-2 bg-amber/10 rounded p-2">
            🏪 申请门店: <b>{a.requestedStore.no} · {a.requestedStore.name}</b>
            <div className="text-micro text-gray3 mt-0.5">通过后只能看本店数据</div>
          </div>
        )}
        {a.reason && (
          <div className="text-caption text-gray2 mt-2 bg-bg rounded p-2">备注: {a.reason}</div>
        )}
        {a.rejectReason && (
          <div className="text-caption text-red-fg mt-2 bg-red-bg rounded p-2">拒绝: {a.rejectReason}</div>
        )}
        {a.status === 'PENDING' && (
          <div className="flex gap-2 mt-3 pt-3 border-t border-border">
            <button onClick={onReject} className="flex-1 py-1.5 bg-bg border border-border rounded text-caption">
              拒绝
            </button>
            <button onClick={onApprove} className="flex-1 py-1.5 bg-amber text-white rounded text-caption">
              通过
            </button>
          </div>
        )}
      </li>
    )
  }
}
