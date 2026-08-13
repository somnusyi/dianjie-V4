/**
 * 总厨 App · 报损 Tab  PDF: chef_director_loss_tab  Tab 4/4
 * 接真数据 · /api/loss-claims (近 30 天)
 * Hero 集团损耗率 + 各店排行 + 异常报损待督导
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { BottomNav, StoreAvatar, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { apiFetch } from '@/lib/v2-auth'

type LossClaim = {
  id: string
  no: string
  totalLossAmount: string | number
  description: string
  status: 'PENDING' | 'APPROVED' | 'AUTO_APPROVED' | 'NEGOTIATING' | 'REJECTED' | 'RESOLVED'
  createdAt: string
  isManual?: boolean                // true = 盘点报损 (店内自负), false = 验收短量 (扣供应商)
  reason?: string | null
  evidenceImages?: string[]
  items?: Array<{
    id: string
    productId: string
    lossQty: string | number
    lossAmount: string | number
    product?: { name: string; unit?: string }
  }>
  store?: { name: string } | null
  supplier?: { name: string } | null
  purchaseOrder?: { no: string } | null
  createdBy?: { name: string } | null
}
const STATUS_LABEL: Record<string, string> = {
  PENDING: '待处理', APPROVED: '已同意', AUTO_APPROVED: '自动批准',
  NEGOTIATING: '协商中', REJECTED: '已拒绝', RESOLVED: '已结清',
}
const STATUS_TONE: Record<string, 'gray' | 'orange' | 'green' | 'red'> = {
  PENDING: 'orange', APPROVED: 'green', AUTO_APPROVED: 'green',
  NEGOTIATING: 'orange', REJECTED: 'red', RESOLVED: 'gray',
}
function fmtDate(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function ChefDirectorLossPage() {
  const [tab] = useState('loss')
  const [items, setItems] = useState<LossClaim[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 全部报损列表 默认显示头 10 条, 点击"查看全部"展开
  const [showAllDetails, setShowAllDetails] = useState(false)
  // 证据照点击放大 (复用其他页面同一套 lightbox 模式)
  const [zoomImg, setZoomImg] = useState<string | null>(null)

  async function loadPage(page = 1) {
    if (page > 1) setLoadingMore(true)
    try {
      const d = await apiFetch<{ items: LossClaim[]; total: number }>(
        `/api/loss-claims?page=${page}&pageSize=50&createdAfter=2026-04-01`,
      )
      const next = d.items || []
      setItems(current => page === 1 ? next : [...(current || []), ...next])
      setTotal(Number(d.total ?? next.length))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => { void loadPage() }, [])

  const stats = useMemo(() => {
    if (!items) return null
    const now = Date.now()
    const week = items.filter(i => now - new Date(i.createdAt).getTime() < 7 * 86400000)
    const month = items.filter(i => now - new Date(i.createdAt).getTime() < 30 * 86400000)
    const weekTotal = week.reduce((s, i) => s + Number(i.totalLossAmount), 0)
    const monthTotal = month.reduce((s, i) => s + Number(i.totalLossAmount), 0)
    const pending = items.filter(i => i.status === 'PENDING' || i.status === 'NEGOTIATING')
    return { week, month, weekTotal, monthTotal, pending, total: items.length }
  }, [items])

  // 按店聚合排名
  const storeRank = useMemo(() => {
    if (!items) return []
    const map: Record<string, { name: string; total: number; count: number }> = {}
    items.forEach(i => {
      const name = i.store?.name || '集团'
      if (!map[name]) map[name] = { name, total: 0, count: 0 }
      map[name].total += Number(i.totalLossAmount)
      map[name].count += 1
    })
    return Object.values(map).sort((a, b) => b.total - a.total)
  }, [items])

  // 待督导异常: PENDING/NEGOTIATING + 大额 (>=200)
  const abnormal = useMemo(() => {
    if (!items) return []
    return items.filter(i =>
      i.status === 'PENDING' || i.status === 'NEGOTIATING' || Number(i.totalLossAmount) >= 200
    ).slice(0, 5)
  }, [items])
  const hasMore = items !== null && items.length < total

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">报损</h1>
          <p className="text-caption text-gray3">集团 · 近 30 天</p>
        </div>
      </header>

      <div className="mt-3">
        <GlanceStrip
          label="近 30 天报损金额"
          value={stats ? `¥${stats.monthTotal.toLocaleString()}` : '加载中…'}
          delta={stats && stats.weekTotal > 0
            ? { text: `本周 ¥${stats.weekTotal.toLocaleString()}`, trend: 'flat' }
            : undefined}
          meta={stats ? `共 ${stats.total} 笔 · 待我督导 ${stats.pending.length} 笔` : ''}
          stats={stats ? [
            { label: '本周笔数', value: `${stats.week.length} 笔`, tone: 'default' },
            { label: '待处理',   value: `${stats.pending.length}`, tone: stats.pending.length > 0 ? 'orange' : 'default' },
            { label: '涉及门店', value: `${storeRank.length}`,     tone: 'default' },
          ] : []}
        />
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">加载失败: {error}</div>}

      <Section title="待督导报损" right={`${abnormal.length} 项` } rightTone={abnormal.length > 0 ? 'red' : undefined}>
        {items === null && <p className="text-caption text-gray3 text-center py-6">加载中…</p>}
        {items !== null && abnormal.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">暂无待督导的异常报损</p>
          </div>
        )}
        {abnormal.length > 0 && (
          <ul className="space-y-2">
            {abnormal.map(a => {
              const tone = a.status === 'PENDING' || a.status === 'NEGOTIATING'
                ? 'orange' : (Number(a.totalLossAmount) >= 200 ? 'red' : 'gray')
              return (
                <li key={a.id} className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${tone === 'red' ? 'before:bg-red' : tone === 'orange' ? 'before:bg-orange' : 'before:bg-gray4'}`}>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <Chip tone={STATUS_TONE[a.status] || 'gray'}>{STATUS_LABEL[a.status] || a.status}</Chip>
                    {Number(a.totalLossAmount) >= 200 && <Chip tone="red">大额</Chip>}
                    <span className="text-micro text-gray3 ml-auto">{fmtDate(a.createdAt)} · {a.no}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-h2">{a.store?.name || '—'}</span>
                    <span className="font-num text-h2">¥{Number(a.totalLossAmount).toLocaleString()}</span>
                  </div>
                  <p className="text-caption text-gray2 mt-0.5">
                    {a.purchaseOrder?.no || '—'} · {a.supplier?.name || '—'} · {a.createdBy?.name || '—'} 发起
                  </p>
                  {a.description && <p className="text-micro text-gray3 mt-1 line-clamp-2">{a.description}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {/* 全部报损明细 (2026-05-31 客户反馈: 总厨看不到盘点里自动通过的报损)
          按时间倒序, 默认显示头 10 条, 点击查看全部. 复用 zoomImg lightbox 看证据照. */}
      <Section
        title="全部报损明细"
        right={items ? `已加载 ${items.length}/${total || items.length} 条` : ''}
      >
        {items === null && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
        {items !== null && items.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">近 30 天暂无报损</p>
          </div>
        )}
        {items !== null && items.length > 0 && (
          <>
            <ul className="space-y-2">
              {(showAllDetails ? items : items.slice(0, 10)).map(lc => {
                const isMan = lc.isManual === true
                return (
                  <li key={lc.id} className="bg-white rounded-card border border-border p-3">
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      <Chip tone={STATUS_TONE[lc.status] || 'gray'}>{STATUS_LABEL[lc.status] || lc.status}</Chip>
                      {isMan
                        ? <Chip tone="blue">店内盘点</Chip>
                        : <Chip tone="orange">验收短量</Chip>}
                      <span className="text-micro text-gray3 font-num ml-auto">{fmtDate(lc.createdAt)} · {lc.no}</span>
                    </div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-h2 truncate">{lc.store?.name || '—'}</span>
                      <span className="font-num text-h2 text-red-fg">−¥{Number(lc.totalLossAmount).toLocaleString()}</span>
                    </div>
                    <p className="text-micro text-gray3 mb-1">
                      {isMan
                        ? `店内自负 · ${lc.createdBy?.name || '—'} 报${lc.reason ? ` · ${lc.reason}` : ''}`
                        : `${lc.purchaseOrder?.no || '—'} · ${lc.supplier?.name || '—'} · ${lc.createdBy?.name || '—'} 发起`
                      }
                    </p>
                    {lc.description && <p className="text-micro text-gray2 mb-1.5 line-clamp-2">{lc.description}</p>}
                    {(lc.items?.length ?? 0) > 0 && (
                      <ul className="text-micro text-gray2 space-y-0.5 mb-1.5">
                        {(lc.items || []).slice(0, 5).map((it, i) => (
                          <li key={i}>· {it.product?.name || ''} 损 <b className="font-num text-red-fg">{Number(it.lossQty)}</b> = ¥{Number(it.lossAmount).toFixed(2)}</li>
                        ))}
                        {(lc.items?.length || 0) > 5 && (
                          <li className="text-gray3">… 还有 {(lc.items?.length || 0) - 5} 项</li>
                        )}
                      </ul>
                    )}
                    {(lc.evidenceImages?.length ?? 0) > 0 && (
                      <>
                        <div className="text-micro text-gray3 mb-1">证据 {lc.evidenceImages?.length} 张 · 点击放大</div>
                        <div className="flex gap-2 overflow-x-auto">
                          {(lc.evidenceImages || []).map((url, i) => {
                            const isVideo = /\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(url)
                            return (
                              <button key={i} type="button" onClick={() => setZoomImg(url)} className="shrink-0 relative">
                                {isVideo
                                  ? <video src={url} muted playsInline preload="metadata" className="w-16 h-16 object-cover rounded border border-border bg-gray5" />
                                  : <img src={url} alt="" className="w-16 h-16 object-cover rounded border border-border" />}
                                {isVideo && <span className="absolute bottom-0 left-0 right-0 bg-ink/60 text-white text-micro text-center py-0.5 rounded-b">▶</span>}
                              </button>
                            )
                          })}
                        </div>
                      </>
                    )}
                    <a
                      href={`/v2/loss-claims/${lc.id}/print`}
                      className="mt-3 w-full py-2 rounded-cta border border-ink text-ink text-button flex items-center justify-center"
                    >
                      查看并打印报损单
                    </a>
                  </li>
                )
              })}
            </ul>
            {items.length > 10 && (
              <button
                type="button"
                onClick={() => setShowAllDetails(v => !v)}
                className="block w-full text-center py-3 mt-2 text-caption text-amber-fg bg-white rounded-card border border-border"
              >
                {showAllDetails ? '↑ 收起 (仅显示 10 条)' : `查看全部 ${items.length} 条 ›`}
              </button>
            )}
            {hasMore && (
              <button
                type="button"
                onClick={() => void loadPage(Math.floor((items?.length || 0) / 50) + 1)}
                disabled={loadingMore}
                className="block w-full text-center py-3 mt-2 text-caption text-amber-fg bg-white rounded-card border border-border disabled:opacity-50"
              >
                {loadingMore ? '加载中…' : `加载更多报损 · 已显示 ${items?.length || 0}/${total}`}
              </button>
            )}
          </>
        )}
      </Section>

      <Section title="各店报损排行" right={`${storeRank.length} 家店`}>
        {storeRank.length === 0 ? (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">暂无报损数据</p>
          </div>
        ) : (
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {storeRank.slice(0, 8).map((s, i) => (
              <li key={s.name} className="px-3 py-3 flex items-center gap-3">
                <span className="font-num text-gray3 w-4 text-right text-caption">{i + 1}</span>
                <StoreAvatar name={s.name} anomaly={i === 0 && storeRank.length > 1} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-h2 truncate">{s.name}</span>
                    {i === 0 && storeRank.length > 1 && <Chip tone="red">最高</Chip>}
                  </div>
                  <p className="text-micro text-gray3">{s.count} 笔</p>
                </div>
                <span className="font-num text-h2">¥{s.total.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="说明" right="">
        <div className="bg-white rounded-card border border-border p-3 text-micro text-gray3">
          报损来源: 厨师长收货短量自动生成 + 厨师长手动报损(临期/变质等)。供应商 24h 内不响应自动转您终审。
        </div>
      </Section>

      <BottomNav
        tabs={[
          { key: 'home',     label: '工作台', icon: '⌂' },
          { key: 'review',   label: '审批',   icon: '✓' },
          { key: 'loss',     label: '报损',   icon: '△' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')     location.href = '/v2/chef-director/home'
          if (k === 'review')   location.href = '/v2/chef-director/approvals'
        }}
      />

      {/* 证据照/视频 全屏 lightbox */}
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

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'red' ? 'text-red-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
