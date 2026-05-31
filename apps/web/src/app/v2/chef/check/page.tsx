/**
 * 厨师长 App · 盘点 Tab — 店内报损 (临期 / 客退 / 变质 / 掉落 / 破损)
 *
 * 接 GET /api/loss-claims (会按 storeId 自动过滤)
 * - 只显示本店 isManual=true 的报损 (店内自有损耗, 不走供应商扣账期)
 * - 集计本月损耗金额 / 笔数
 * - + 入口: /v2/chef/check/new 录新一笔
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { apiFetch, getUser } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type LossClaim = {
  id: string; no: string; status: string
  totalLossAmount: string | number
  description?: string | null
  reason?: string | null
  evidenceImages?: string[]
  isManual?: boolean
  createdAt: string
  store?: { name: string } | null
  createdBy?: { name: string } | null
  items: { id: string; lossQty: string; unitPrice: string; lossAmount: string
           product?: { name: string; unit: string } }[]
}

// description 里抓出原因 keyword
function extractReason(desc: string | null | undefined): string {
  if (!desc) return '其他'
  const m = desc.match(/(临期|变质|客退|掉落|破损|其他)/)
  return m ? m[1] : '其他'
}
const REASON_TONE: Record<string, 'orange' | 'blue' | 'red' | 'gray'> = {
  '临期': 'orange', '客退': 'blue', '变质': 'red', '掉落': 'gray', '破损': 'gray', '其他': 'gray',
}
function timeAgo(iso: string) {
  const d = dayjs(iso)
  const now = dayjs()
  if (d.isSame(now, 'day')) return '今日 ' + d.format('HH:mm')
  if (d.isSame(now.subtract(1, 'day'), 'day')) return '昨日 ' + d.format('HH:mm')
  return d.format('MM/DD HH:mm')
}

export default function ChefCheckPage() {
  const [tab, setTab] = useState('check')
  const [claims, setClaims] = useState<LossClaim[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)  // 单条展开看明细
  const [zoomImg, setZoomImg] = useState<string | null>(null)         // 证据照点击放大
  const user = typeof window !== 'undefined' ? getUser() : null
  const storeName = (user as any)?.store?.name || ''

  useEffect(() => {
    apiFetch<LossClaim[]>('/api/loss-claims')
      .then(list => setClaims((list || []).filter(c => c.isManual)))   // 仅店内报损
      .catch(e => setError(e.message || '加载失败'))
  }, [])

  // 本月集计
  const monthStart = dayjs().startOf('month').toDate()
  const thisMonth = (claims || []).filter(c => new Date(c.createdAt) >= monthStart)
  const monthAmount = thisMonth.reduce((s, c) => s + Number(c.totalLossAmount), 0)
  const monthCount = thisMonth.length

  // 本周
  const weekStart = dayjs().startOf('week').toDate()
  const thisWeek = (claims || []).filter(c => new Date(c.createdAt) >= weekStart)
  const weekAmount = thisWeek.reduce((s, c) => s + Number(c.totalLossAmount), 0)

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">盘点</h1>
          <p className="text-caption text-gray3">{storeName ? storeName + ' · 后厨' : '本店 · 后厨'}</p>
        </div>
      </header>

      <div className="mt-3">
        <GlanceStrip
          label="本月店内报损"
          value={`¥${monthAmount.toLocaleString()}`}
          meta={`本周 ¥${weekAmount.toLocaleString()} · 临期/变质/客退/破损`}
          stats={[
            { label: '本月笔数', value: `${monthCount} 笔`, tone: 'default' },
            { label: '本周笔数', value: `${thisWeek.length} 笔`, tone: 'default' },
            { label: '总累计', value: `${claims?.length ?? 0} 笔`, tone: 'default' },
          ]}
        />
      </div>

      {/* 报损黑色大入口 */}
      <div className="px-4 mt-4">
        <a href="/v2/chef/check/new" className="w-full bg-ink text-white rounded-card p-4 flex items-center gap-3 text-left">
          <span className="w-10 h-10 rounded-full bg-white text-ink flex items-center justify-center text-h1">+</span>
          <div className="flex-1">
            <div className="text-h2">新增报损一笔</div>
            <p className="text-caption text-gray4">食材损耗 · 临期 · 客退 · 破损</p>
          </div>
          <span className="text-gray4">›</span>
        </a>
      </div>

      <Section title="本周报损" right={`${thisWeek.length} 笔 · ¥${weekAmount.toLocaleString()}`}>
        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
        {!claims && !error && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
        {claims && thisWeek.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <div className="text-2xl mb-1">✓</div>
            <p className="text-caption text-gray3">本周暂无报损 · 食材健康</p>
          </div>
        )}
        {thisWeek.length > 0 && (
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {thisWeek.slice(0, 10).map(c => {
              const reason = extractReason(c.description)
              const firstItem = c.items?.[0]
              const expanded = expandedId === c.id
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : c.id)}
                    className="w-full text-left px-3 py-3 flex items-center gap-3 active:bg-bg-warm"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 truncate">
                        <span className="text-h2 truncate">
                          {firstItem?.product?.name || '?'}{c.items?.length > 1 ? ` 等 ${c.items.length} 项` : ` · ${firstItem?.lossQty} ${firstItem?.product?.unit || ''}`}
                        </span>
                        <Chip tone={REASON_TONE[reason]}>{reason}</Chip>
                      </div>
                      <p className="text-micro text-gray3">{timeAgo(c.createdAt)} · {c.createdBy?.name || '-'} · {c.no}</p>
                    </div>
                    <span className="font-num text-red-fg">-¥{Number(c.totalLossAmount).toFixed(0)}</span>
                    <span className="text-gray3 text-caption ml-1">{expanded ? '▾' : '›'}</span>
                  </button>
                  {expanded && (
                    <ClaimDetail c={c} onImg={setZoomImg} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Section title="历史报损" right={`累计 ${claims?.length ?? 0} 笔`}>
        {claims && claims.length > thisWeek.length && (
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {claims.filter(c => new Date(c.createdAt) < weekStart).slice(0, 10).map(c => {
              const reason = extractReason(c.description)
              const firstItem = c.items?.[0]
              const expanded = expandedId === c.id
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : c.id)}
                    className="w-full text-left px-3 py-3 flex items-center gap-3 active:bg-bg-warm"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 truncate">
                        <span className="text-body truncate">
                          {firstItem?.product?.name || '?'}{c.items?.length > 1 ? ` 等 ${c.items.length} 项` : ''}
                        </span>
                        <Chip tone={REASON_TONE[reason]}>{reason}</Chip>
                      </div>
                      <p className="text-micro text-gray3">{dayjs(c.createdAt).format('MM/DD')} · {c.createdBy?.name || '-'} · {c.no}</p>
                    </div>
                    <span className="font-num text-gray2 text-caption">-¥{Number(c.totalLossAmount).toFixed(0)}</span>
                    <span className="text-gray3 text-caption ml-1">{expanded ? '▾' : '›'}</span>
                  </button>
                  {expanded && (
                    <ClaimDetail c={c} onImg={setZoomImg} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {claims && claims.length <= thisWeek.length && (
          <p className="text-caption text-gray3 text-center py-2">没有更早的记录</p>
        )}
      </Section>

      {/* 证据照 / 视频 全屏 lightbox (target="_blank" 在 WebView 不工作) */}
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

      <BottomNav
        tabs={[
          { key: 'home', label: '工作台', icon: '⌂' },
          { key: 'inventory', label: '库存', icon: '⛁' },
          { key: 'purchase', label: '采购', icon: '☰' },
          { key: 'check', label: '盘点', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')      location.href = '/v2/chef/home'
          if (k === 'inventory') location.href = '/v2/chef/inventory'
          if (k === 'purchase')  location.href = '/v2/chef/purchase'
        }}
      />
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className="text-caption text-gray3">{right}</span>}
      </div>
      {children}
    </section>
  )
}

// 点击卡片展开后的明细块: 商品列表 + 描述 + 证据照
function ClaimDetail({ c, onImg }: { c: LossClaim; onImg: (url: string) => void }) {
  return (
    <div className="px-3 pb-3 bg-bg-warm/40 border-t border-border">
      {/* 商品明细 */}
      {(c.items?.length ?? 0) > 0 && (
        <ul className="mt-2 text-caption text-gray2 space-y-0.5">
          {c.items.map((it, i) => (
            <li key={i} className="flex justify-between gap-2">
              <span className="flex-1 truncate">· {it.product?.name || ''} 损 <b className="font-num text-red-fg">{Number(it.lossQty)}</b> {it.product?.unit || ''}</span>
              <span className="font-num text-red-fg shrink-0">¥{Number(it.lossAmount).toFixed(2)}</span>
            </li>
          ))}
        </ul>
      )}
      {/* 描述 / 原因 */}
      {(c.description || c.reason) && (
        <div className="mt-2 text-caption text-gray2 bg-white rounded p-2 border border-border">
          {c.reason && <span className="text-micro text-gray3 mr-1">原因:</span>}
          {c.description || c.reason}
        </div>
      )}
      {/* 证据照 / 视频 */}
      {(c.evidenceImages?.length ?? 0) > 0 && (
        <>
          <div className="text-micro text-gray3 mt-2 mb-1">证据 {c.evidenceImages?.length} 张 · 点击放大</div>
          <div className="flex gap-2 overflow-x-auto">
            {(c.evidenceImages || []).map((url, i) => {
              const isVideo = /\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(url)
              return (
                <button key={i} type="button" onClick={() => onImg(url)} className="shrink-0 relative">
                  {isVideo
                    ? <video src={url} muted playsInline preload="metadata" className="w-20 h-20 object-cover rounded border border-border bg-gray5" />
                    : <img src={url} alt="" className="w-20 h-20 object-cover rounded border border-border" />}
                  {isVideo && <span className="absolute bottom-0 left-0 right-0 bg-ink/60 text-white text-micro text-center py-0.5 rounded-b">▶</span>}
                </button>
              )
            })}
          </div>
        </>
      )}
      {/* 状态 + 处理结果 */}
      <p className="text-micro text-gray3 mt-2">
        状态: {c.status === 'AUTO_APPROVED' ? '阈值内自动通过 (店内自负)'
              : c.status === 'PENDING' ? '待总厨审批'
              : c.status === 'APPROVED' ? '已通过'
              : c.status === 'REJECTED' ? '驳回'
              : c.status}
      </p>
    </div>
  )
}
