/**
 * PO 提交成功 / 详情页
 * 显示 5 段 ProgressDots: 已提交 → 供应商接单 → 发货 → 在途 → 验收
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ProgressDots, Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

const STATUS_TO_STEP: Record<string, number> = {
  DRAFT: 0,
  SUBMITTED: 1,
  CONFIRMED: 2,
  DELIVERING: 3,
  PENDING_CONFIRM: 4,
  RECEIVED: 4,
  COMPLETED: 5,
  CANCELLED: -1,
}

export default function PoSuccessPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [po, setPo] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    apiFetch(`/api/orders/${params.id}`).then(setPo).catch(e => setError(String(e?.message || e)))
  }, [params.id])
  if (error) return <div className="p-6 text-red-fg">{error}</div>
  if (!po) return <div className="p-6 text-gray3 text-caption">加载中…</div>

  const stepIdx = STATUS_TO_STEP[po.status] ?? 1
  const isPendingConfirm = po.status === 'PENDING_CONFIRM'
  const total = Number(po.totalAmount || 0)

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.push('/v2/chef/purchase')} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">采购单</h1>
      </header>

      <div className="mx-4 mt-3 bg-ink text-white rounded-card p-5">
        <p className="text-micro text-gray4">{po.no}</p>
        <div className="font-num text-hero mt-1">¥{total.toLocaleString()}</div>
        <p className="text-caption text-gray4 mt-1">
          {po.supplier?.name || '—'} · 期望 {new Date(po.expectedDate).toLocaleDateString('zh-CN')}
        </p>
        <div className="flex gap-2 mt-3 flex-wrap">
          <Chip tone={po.status === 'COMPLETED' ? 'green' : isPendingConfirm ? 'orange' : 'gray'}>
            {statusLabel(po.status)}
          </Chip>
          <Chip tone="gray">{po.items?.length ?? 0} 项</Chip>
          {po.status === 'PENDING_CONFIRM' && <Chip tone="orange">24h 内验收否则自动确认</Chip>}
        </div>
      </div>

      <Section title="物流进度">
        <div className="bg-white rounded-card border border-border p-4">
          <ProgressDots
            steps={[
              { label: '已提交' },
              { label: '供应商接单' },
              { label: '已发货' },
              { label: '在途' },
              { label: '验收' },
            ]}
            currentIndex={stepIdx}
          />
          {po.shippedAt && (
            <p className="text-caption text-gray3 mt-3">
              发货时间：{new Date(po.shippedAt).toLocaleString('zh-CN')}
              {po.shippedNote && ` · ${po.shippedNote}`}
            </p>
          )}
          {po.receivedAt && (
            <p className="text-caption text-gray3 mt-1">
              验收时间：{new Date(po.receivedAt).toLocaleString('zh-CN')}
            </p>
          )}
        </div>
      </Section>

      <Section title={`商品明细 (${po.items?.length ?? 0} 项)`}>
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {(po.items || []).map((it: any) => (
            <li key={it.id} className="px-3 py-2.5 flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="text-body truncate">{it.product?.name || it.productId}</div>
                <div className="text-micro text-gray3 font-num">
                  {it.quantity} {it.product?.unit || ''} × ¥{Number(it.unitPrice).toFixed(2)}
                  {it.receivedQty != null && Number(it.receivedQty) !== Number(it.quantity) && (
                    <span className="ml-2 text-orange-fg">实收 {it.receivedQty}</span>
                  )}
                </div>
              </div>
              <span className="font-num text-body">¥{Number(it.amount).toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </Section>

      {po.lossClaims?.length > 0 && (
        <Section title="报损">
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {po.lossClaims.map((lc: any) => (
              <li key={lc.id} className="px-3 py-2.5">
                <div className="flex items-center justify-between mb-1">
                  <Chip tone={lc.status === 'APPROVED' || lc.status === 'AUTO_APPROVED' ? 'green' : lc.status === 'REJECTED' ? 'red' : 'orange'}>
                    {lossLabel(lc.status)}
                  </Chip>
                  <span className="font-num text-body text-red-fg">−¥{Number(lc.totalLossAmount).toFixed(2)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button onClick={() => router.push('/v2/chef/purchase')} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">返回采购</button>
        {/* SUBMITTED 状态可撤回 (供应商接单前) */}
        {po.status === 'SUBMITTED' && (
          <button
            onClick={async () => {
              const reason = window.prompt('撤回原因 (供应商可见, 选填):') ?? ''
              if (!confirm(`确认撤回订单 ${po.no}? 撤回后无法恢复, 需要重新下单`)) return
              try {
                await apiFetch(`/api/orders/${po.id}/cancel`, {
                  method: 'PATCH', body: JSON.stringify({ reason: reason.trim() })
                })
                location.reload()
              } catch (e: any) { alert(e.message || '撤回失败') }
            }}
            className="px-4 py-3 bg-white border border-red text-red-fg rounded-cta text-button">
            撤回
          </button>
        )}
        {isPendingConfirm && (
          <button onClick={() => router.push(`/v2/chef/purchase/${po.id}/receive`)} className="flex-1 py-3 bg-ink text-white rounded-cta text-button">
            去验收
          </button>
        )}
        {!isPendingConfirm && po.status !== 'CANCELLED' && po.status !== 'SUBMITTED' && (
          <button onClick={() => router.push('/v2/chef/purchase/new')} className="flex-1 py-3 bg-ink text-white rounded-cta text-button">
            再发一单
          </button>
        )}
      </div>
    </div>
  )
}

function statusLabel(s: string) {
  return ({
    DRAFT: '草稿', SUBMITTED: '已提交 · 待供应商接单',
    CONFIRMED: '供应商已接单', DELIVERING: '配送中',
    PENDING_CONFIRM: '已送达 · 待验收',
    RECEIVED: '已收货 · 含报损', COMPLETED: '已完成 ✓',
    CANCELLED: '已取消',
  } as Record<string, string>)[s] || s
}
function lossLabel(s: string) {
  return ({
    PENDING: '待供应商处理',
    APPROVED: '供应商同意',
    AUTO_APPROVED: '24h 自动同意',
    REJECTED: '供应商拒绝',
    NEGOTIATING: '协商中',
    RESOLVED: '协商完成',
  } as Record<string, string>)[s] || s
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <h2 className="text-h2 mb-2">{title}</h2>
      {children}
    </section>
  )
}
