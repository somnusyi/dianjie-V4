/**
 * 单据提交成功页 (PDF: 操作完成态)
 * - 显示单号 + 当前状态 + 审批链
 * - 自动批 → 大绿色"已通过" + 落款金额
 * - 待审批 → 橙色"等待 X 审"
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApprovalRouting, Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

const STATUS_LABEL: Record<string, { label: string; tone: 'green' | 'orange' | 'red' | 'gray'; sub: string }> = {
  AUTO_APPROVED:   { label: '已自动通过 ✓', tone: 'green',  sub: '阈值内规则自动批准, 资金台账已落账' },
  APPROVED:        { label: '已批准 ✓',     tone: 'green',  sub: '所有审批步骤完成' },
  PENDING_FINANCE: { label: '财务初审中',    tone: 'orange', sub: '已提交, 等待财务审核' },
  PENDING_FINAL:   { label: '终审中',        tone: 'orange', sub: '已提交, 等待最终审批' },
  REJECTED:        { label: '已驳回',        tone: 'red',    sub: '请查看驳回原因' },
}

export default function DocumentSuccessPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [doc, setDoc] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch(`/api/documents/${params.id}`).then(setDoc).catch(e => setError(String(e?.message || e)))
  }, [params.id])

  if (error) return <div className="min-h-screen bg-bg p-6"><div className="bg-red-bg text-red-fg rounded-card p-4">{error}</div></div>
  if (!doc) return <div className="min-h-screen bg-bg p-6 text-gray3 text-caption">加载中…</div>

  const statusCfg = STATUS_LABEL[doc.status] || { label: doc.status, tone: 'gray' as const, sub: '' }
  const isHappy = doc.status === 'AUTO_APPROVED' || doc.status === 'APPROVED'
  const amount = Number(doc.amount || 0)

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.push('/v2/manager/home')} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">提交结果</h1>
      </header>

      {/* 大状态卡 */}
      <div className={`mx-4 mt-3 rounded-card p-6 text-center ${isHappy ? 'bg-green-bg' : statusCfg.tone === 'red' ? 'bg-red-bg' : 'bg-orange-bg'}`}>
        <div className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl ${
          isHappy ? 'bg-green text-white' : statusCfg.tone === 'red' ? 'bg-red text-white' : 'bg-orange text-white'
        }`}>
          {isHappy ? '✓' : statusCfg.tone === 'red' ? '✕' : '⌛'}
        </div>
        <div className={`text-h1 mt-3 ${isHappy ? 'text-green-fg' : statusCfg.tone === 'red' ? 'text-red-fg' : 'text-orange-fg'}`}>
          {statusCfg.label}
        </div>
        <p className="text-caption text-gray2 mt-1">{statusCfg.sub}</p>
        <div className="font-num text-hero mt-4">¥{amount.toLocaleString()}</div>
        <p className="text-micro text-gray3 mt-1">{doc.title}</p>
      </div>

      {/* 单据摘要 */}
      <section className="mx-4 mt-4 bg-white rounded-card border border-border p-4 space-y-2">
        <Row label="单号" value={doc.number} mono />
        <Row label="类型" value={doc.type} />
        <Row label="发起人" value={doc.initiator?.name || '—'} />
        <Row label="门店" value={doc.store?.name || '集团'} />
        {doc.thresholdRule && <Row label="阈值规则" value={doc.thresholdRule} />}
      </section>

      {/* 审批链可视化 */}
      {doc.steps?.length > 0 && (
        <section className="mx-4 mt-4 bg-white rounded-card border border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-h2">审批链</h2>
            <span className="text-caption text-gray3">{doc.steps.length} 步</span>
          </div>
          <ApprovalRouting
            steps={doc.steps.map((s: any) => ({
              name: s.approver?.name || roleLabel(s.approverRole),
              role: roleLabel(s.approverRole),
              status: s.status === 'DECIDED' ? 'done' : s.status === 'PENDING' ? 'current' : s.status === 'SKIPPED' ? 'skipped' : 'waiting',
              meta: s.decidedAt ? new Date(s.decidedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '',
            }))}
          />
        </section>
      )}

      {/* 底部按钮 */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button onClick={() => router.push('/v2/manager/initiate?type=PETTY_CASH')} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">
          再来一笔
        </button>
        <button onClick={() => router.push('/v2/manager/home')} className="flex-1 py-3 bg-ink text-white rounded-cta text-button">
          返回工作台
        </button>
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-caption text-gray2">{label}</span>
      <span className={`text-body ${mono ? 'font-num' : ''}`}>{value}</span>
    </div>
  )
}

function roleLabel(r: string) {
  return ({
    BOSS: '老板', ADMIN: '老板', SUPER_ADMIN: '老板',
    FINANCE: '财务',
    MANAGER: '店长', PURCHASER: '店长',
    KITCHEN_LEAD: '厨师长',
    CHEF_DIRECTOR: '总厨', CHEF: '总厨',
    SUPPLIER_OWNER: '供应商', SUPPLIER_STAFF: '供应商', SUPPLIER_SUB: '供应商子号',
    STAFF: '基层',
  } as Record<string, string>)[r] ?? r
}
