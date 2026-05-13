/**
 * 店长 · 上传美团/抖音 对账 CSV (Sprint B-3 过渡方案)
 *
 * 在我们没接平台 API 之前的"快速过桥":
 *   1. 店长每周从美团商户后台 / 抖音生活服务后台 下载对账 CSV
 *   2. 上传到这里
 *   3. 系统解析 → 按日期合并到 RevenueRecord
 *
 * 平台账单 CSV 格式不一(美团/抖音不同), 后端解析交给微服务做。
 * 此页仅做上传 + 状态展示。
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'

type Platform = 'meituan' | 'douyin'
type Upload = {
  id: string; platform: Platform; filename: string; uploadedAt: string
  status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED'
  rowsImported?: number; totalGmv?: number; totalNet?: number; error?: string
}

const PLATFORMS = [
  { key: 'meituan' as const, label: '美团/大众点评', hint: '商户后台 → 财务 → 对账 → 导出 CSV', color: 'orange' },
  { key: 'douyin'  as const, label: '抖音生活服务',  hint: '生活服务后台 → 经营 → 对账下载 CSV', color: 'red' },
]

export default function UploadPlatformPage() {
  const [tab, setTab] = useState<Platform>('meituan')
  const [history, setHistory] = useState<Upload[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storeName, setStoreName] = useState('')
  const [storeId, setStoreId] = useState<string | null>(null)

  useEffect(() => {
    const u = getUser()
    setStoreId(u?.storeId || u?.store?.id || null)
    setStoreName(u?.store?.name || '本店')
    loadHistory()
  }, [])

  function loadHistory() {
    apiFetch<Upload[]>('/api/platform-uploads?limit=10')
      .then(setHistory)
      .catch(() => setHistory([]))   // 后端未就绪时降级显示空
  }

  async function pickFile(platform: Platform) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,.xlsx,.xls,text/csv'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      if (file.size > 5 * 1024 * 1024) { setError('文件过大 (上限 5MB)'); return }
      setSubmitting(true); setError(null)
      try {
        const form = new FormData()
        form.append('file', file)
        form.append('platform', platform)
        if (storeId) form.append('storeId', storeId)
        const res = await fetch('/api/platform-uploads', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token') || ''}` },
          body: form,
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error || '上传失败')
        }
        loadHistory()
      } catch (e: any) { setError(e.message || '上传失败') }
      setSubmitting(false)
    }
    input.click()
  }

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history && history.length > 0 ? location.href = '/v2/manager/ops' : history.back?.()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div>
          <h1 className="text-h1">上传平台对账</h1>
          <p className="text-caption text-gray3">{storeName} · 美团 / 抖音 CSV 自动入账</p>
        </div>
      </header>

      <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-3 text-caption text-gray2">
        <p><span className="text-amber-fg">为何上传?</span> 美团/抖音 API 接入需企业资质审核 1-3 月,
          先用商户后台导出的 CSV 作为过桥, 系统按日期匹配到营业额记录。</p>
        <p className="text-micro text-gray3 mt-1">⏱ 建议每周一次, 涵盖前一周核销明细</p>
      </div>

      {/* 平台切换 */}
      <div className="px-4 mt-3 flex gap-2">
        {PLATFORMS.map(p => (
          <button key={p.key}
            onClick={() => setTab(p.key)}
            className={`px-3 py-1.5 rounded-cta text-button ${tab === p.key ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* 上传卡 */}
      <div className="mx-4 mt-3">
        {PLATFORMS.filter(p => p.key === tab).map(p => (
          <div key={p.key} className="bg-white rounded-card border border-border p-4">
            <div className="text-h2 mb-1">{p.label}</div>
            <p className="text-caption text-gray3 mb-3">{p.hint}</p>
            <button
              onClick={() => pickFile(p.key)}
              disabled={submitting}
              className="w-full py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40"
            >
              {submitting ? '上传中…' : '选择 CSV 文件'}
            </button>
            <p className="text-micro text-gray3 mt-2">支持: CSV / XLSX, 单文件 ≤ 5MB</p>
          </div>
        ))}
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {/* 历史 */}
      <Section title="上传历史" right={history === null ? '加载中…' : `${history.length} 次`}>
        {history === null && <p className="text-caption text-gray3 text-center py-6">加载中…</p>}
        {history?.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">暂无上传记录</p>
            <p className="text-micro text-gray4 mt-1">第一次上传后, 这里会显示解析进度 + 入账金额</p>
          </div>
        )}
        {history && history.length > 0 && (
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {history.map(u => (
              <li key={u.id} className="px-3 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-caption text-gray3">{u.platform === 'meituan' ? '美团' : '抖音'}</span>
                  <span className={`text-micro px-2 py-0.5 rounded-chip ${
                    u.status === 'DONE' ? 'bg-green-bg text-green-fg' :
                    u.status === 'FAILED' ? 'bg-red-bg text-red-fg' :
                    'bg-orange-bg text-orange-fg'
                  }`}>
                    {u.status === 'DONE' ? '已入账' : u.status === 'FAILED' ? '失败' : u.status === 'PROCESSING' ? '处理中' : '待处理'}
                  </span>
                  <span className="text-micro text-gray3 ml-auto">{new Date(u.uploadedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="text-body truncate">{u.filename}</div>
                {u.status === 'DONE' && u.rowsImported != null && (
                  <p className="text-caption text-gray2 mt-0.5 font-num">
                    导入 {u.rowsImported} 行 · GMV ¥{u.totalGmv?.toLocaleString()} · 净到账 ¥{u.totalNet?.toLocaleString()}
                  </p>
                )}
                {u.error && <p className="text-micro text-red-fg mt-1">{u.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>
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
