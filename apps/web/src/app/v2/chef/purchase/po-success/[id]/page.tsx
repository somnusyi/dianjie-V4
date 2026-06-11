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
  RECEIVED: 5,
  COMPLETED: 5,
  CANCELLED: -1,
}

export default function PoSuccessPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [po, setPo] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  // 图片放大: target="_blank" 在 WebView 不工作, 用全屏 lightbox
  const [zoomImg, setZoomImg] = useState<string | null>(null)
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
              { label: '已发起' },
              { label: '接单' },
              { label: '在途' },
              { label: '送达' },
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
                <div className="text-body truncate">
                  {it.product?.name || it.productId}
                  {it.product?.spec && <span className="text-micro text-gray3 ml-1">· {it.product.spec}</span>}
                </div>
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

      {/* 厨师发过的验收单 — DELIVERING 在途时可发, 后续状态保留展示 */}
      {po.chefAckAt && (
        <Section title="我已发的验收单">
          <div className="bg-white rounded-card border border-border p-3">
            <div className="text-micro text-gray3 mb-2">
              发送时间: {new Date(po.chefAckAt).toLocaleString('zh-CN')}
              {' · '}
              {po.chefAckImages?.length || 0} 张照片
            </div>
            {po.chefAckImages?.length > 0 && (
              <div className="flex gap-2 overflow-x-auto mb-2">
                {po.chefAckImages.map((url: string, i: number) => (
                  <button key={i} type="button" onClick={() => setZoomImg(url)} className="shrink-0">
                    <img src={url} alt={`验收照 ${i + 1}`} className="w-20 h-20 object-cover rounded border border-border" />
                  </button>
                ))}
              </div>
            )}
            {po.chefAckNote && (
              <div className="text-caption text-gray2 bg-bg rounded p-2">
                <span className="text-micro text-gray3">备注: </span>
                {po.chefAckNote}
              </div>
            )}
          </div>
        </Section>
      )}

      {po.lossClaims?.length > 0 && (
        <Section title="报损">
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {po.lossClaims.map((lc: any) => (
              <li key={lc.id} className="px-3 py-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Chip tone={lc.status === 'APPROVED' || lc.status === 'AUTO_APPROVED' ? 'green' : lc.status === 'REJECTED' ? 'red' : 'orange'}>
                      {lossLabel(lc.status)}
                    </Chip>
                    <span className="text-micro text-gray3 font-num">{lc.no}</span>
                  </div>
                  <span className="font-num text-body text-red-fg">−¥{Number(lc.totalLossAmount).toFixed(2)}</span>
                </div>
                {lc.description && <p className="text-caption text-gray2 mt-1">{lc.description}</p>}
                {(lc.items?.length ?? 0) > 0 && (
                  <ul className="mt-2 text-micro text-gray2 space-y-0.5">
                    {lc.items.map((it: any, i: number) => (
                      <li key={i}>· {it.product?.name || ''} 损 <b className="font-num text-red-fg">{it.lossQty}</b> = ¥{Number(it.lossAmount).toFixed(2)}</li>
                    ))}
                  </ul>
                )}
                {/* 证据照片 — 点击全屏放大 */}
                {(lc.evidenceImages?.length ?? 0) > 0 && (
                  <>
                    <div className="text-micro text-gray3 mt-2 mb-1">证据 {lc.evidenceImages.length} 张 · 点击放大</div>
                    <div className="flex gap-2 overflow-x-auto">
                      {lc.evidenceImages.map((url: string, i: number) => {
                        const isVideo = /\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(url)
                        return (
                          <button key={i} type="button" onClick={() => setZoomImg(url)} className="shrink-0 relative">
                            {isVideo
                              ? <video src={url} muted playsInline preload="metadata" className="w-20 h-20 object-cover rounded border border-border bg-gray5" />
                              : <img src={url} alt="" className="w-20 h-20 object-cover rounded border border-border" />}
                            {isVideo && <span className="absolute bottom-0 left-0 right-0 bg-ink/60 text-white text-micro text-center py-0.5 rounded-b">▶ 视频</span>}
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
                {lc.handlerNote && (
                  <p className="text-micro text-amber-fg mt-2">供应商: {lc.handlerNote}</p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button onClick={() => router.push('/v2/chef/purchase')} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">返回采购</button>
        {/* 撤回 — 2026-05-29 客户反馈: 放宽到供应商发货前 (SUBMITTED + CONFIRMED) */}
        {(po.status === 'SUBMITTED' || po.status === 'CONFIRMED') && (
          <button
            onClick={async () => {
              const hint = po.status === 'CONFIRMED'
                ? `⚠ 该单供应商已接单 (可能正在备货). 撤回后供应商会被通知"立即停止备货".\n\n撤回原因 (供应商可见, 选填):`
                : '撤回原因 (供应商可见, 选填):'
              const reason = window.prompt(hint) ?? ''
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
        {/* DELIVERING (在途) → 发验收单入口. 已发过的话文案变成"重发验收单" */}
        {po.status === 'DELIVERING' && (
          <button
            onClick={() => router.push(`/v2/chef/purchase/${po.id}/ack`)}
            className={`flex-1 py-3 rounded-cta text-button ${po.chefAckAt ? 'bg-white border border-amber text-amber-fg' : 'bg-amber text-white'}`}>
            {po.chefAckAt ? '重发验收单' : '📷 发验收单'}
          </button>
        )}
        {/* 验收后「补报短量」入口 — 一直开放, 支持多轮 (2026-06 客户要求) */}
        {(po.status === 'RECEIVED' || po.status === 'COMPLETED') && (
          <button onClick={() => router.push(`/v2/chef/purchase/${po.id}/report-loss`)}
                  className="flex-1 py-3 bg-white border border-amber text-amber-fg rounded-cta text-button">
            补报短量
          </button>
        )}
        {!isPendingConfirm && po.status !== 'CANCELLED' && po.status !== 'SUBMITTED' && po.status !== 'DELIVERING' && (
          <button onClick={() => router.push('/v2/chef/purchase/new')} className="flex-1 py-3 bg-ink text-white rounded-cta text-button">
            再发一单
          </button>
        )}
      </div>

      {/* 图片全屏 lightbox */}
      {zoomImg && (
        <div className="fixed inset-0 z-50 bg-ink/90 flex items-center justify-center p-4"
             onClick={() => setZoomImg(null)}>
          {/\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(zoomImg)
            ? <video src={zoomImg} controls autoPlay playsInline className="max-w-full max-h-full rounded" />
            : <img src={zoomImg} alt="" className="max-w-full max-h-full object-contain rounded" />}
          <button onClick={() => setZoomImg(null)}
                  className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 text-white text-h2 flex items-center justify-center">×</button>
        </div>
      )}
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
