/**
 * 招行交易流水 + 电子回单 抽屉
 *
 * 用法:
 *   <BankTransactionsDrawer
 *     open={open}
 *     account={account}     // 留空 = 母公司默认账户
 *     accountLabel={...}     // 抽屉标题用
 *     onClose={() => ...}
 *   />
 *
 * 功能:
 *   - 选日期范围 (默认今日) → 拉 /api/cmb/transactions
 *   - 列表展示出账/入账, 入账绿、出账红
 *   - 每条 SUC 流水可点 ⬇ 回单 → /api/cmb/receipt → base64 PDF 下载
 *
 * 限流: 招行同账号 10s 一次, 抽屉内自带 loading lock 防连点
 */
'use client'
import { useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

type Tx = {
  date: string         // yyyymmdd
  time: string         // HHMMSS
  sequence: string
  direction: 'D' | 'C' | string
  amount: string
  counterName: string
  counterAcct: string
  remark: string
  yurRef: string
}

type TxResp = {
  success: boolean
  resultCode: string
  resultMsg: string
  hasMore?: boolean
  summary?: {
    credit: { amount: string; count: string }
    debit:  { amount: string; count: string }
  }
  transactions?: Tx[]
}

type ReceiptResp = {
  success:   boolean
  resultCode: string
  resultMsg: string
  url?:      string         // 后端落盘后的相对 URL, 前端 window.open 即可
  filename?: string
  checkCode?: string
  expiresAt?: number
}

function todayYmd() {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
function ymdToDash(ymd: string) {
  // 20260514 → 2026-05-14 (DCSIGREC 要求带横杠)
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}
function fmtAmount(amt: string, dir: string) {
  const n = Number(amt)
  const sign = dir === 'C' ? '+' : dir === 'D' ? '−' : ''
  return `${sign}¥${Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
}
function fmtTime(t: string) {
  // HHMMSS → HH:MM
  return `${t.slice(0, 2)}:${t.slice(2, 4)}`
}

export function BankTransactionsDrawer({
  open, account, accountLabel, onClose,
}: {
  open: boolean
  account?: string
  accountLabel?: string
  onClose: () => void
}) {
  const [beginDate, setBeginDate] = useState(todayYmd())
  const [endDate, setEndDate]     = useState(todayYmd())
  const [resp, setResp]           = useState<TxResp | null>(null)
  const [loading, setLoading]     = useState(false)
  const [err, setErr]             = useState<string | null>(null)
  const [downloadingSeq, setDownloadingSeq] = useState<string | null>(null)

  async function query() {
    setLoading(true); setErr(null); setResp(null)
    try {
      const r = await apiFetch<TxResp>('/api/cmb/transactions', {
        method: 'POST',
        body: JSON.stringify({
          account: account || undefined,
          beginDate,
          endDate,
        }),
      })
      if (!r.success) {
        setErr(r.resultMsg || r.resultCode || '查询失败')
      } else {
        setResp(r)
      }
    } catch (e: any) {
      setErr(e?.message || '请求失败')
    } finally {
      setLoading(false)
    }
  }

  async function downloadReceipt(tx: Tx) {
    if (!tx.yurRef) {
      alert('该笔流水缺 yurRef (银行未返业务参考号), 无法下载回单。入账流水通常没有 yurRef。')
      return
    }
    setDownloadingSeq(tx.sequence)
    try {
      const r = await apiFetch<ReceiptResp>('/api/cmb/receipt', {
        method: 'POST',
        body: JSON.stringify({
          account: account || undefined,
          yurRef:   tx.yurRef,
          date:     ymdToDash(tx.date),
          sequence: tx.sequence,
        }),
      })
      if (!r.success || !r.url) {
        alert(`下载失败: ${r.resultMsg || r.resultCode || '银行无返回'}`)
        return
      }
      const fullUrl = new URL(r.url, window.location.origin).toString()
      const cap = (window as any).Capacitor
      const platform = cap?.getPlatform?.()

      // ─ Android Capacitor ─ Chrome Custom Tabs (Browser plugin)
      //   Chrome 自带 PDF viewer 渲染 + 顶部 ⋮ 菜单分享, 关闭后回到 app 原位置
      if (cap?.isNativePlatform?.() && platform === 'android' && cap.Plugins?.Browser) {
        await cap.Plugins.Browser.open({ url: fullUrl })
        return
      }

      // ─ iOS Capacitor ─ 下载到 Cache → UIActivityViewController 系统分享菜单
      //   菜单里 PDF 缩略图直接可见, 选「存到文件」/「微信」/「邮件」/「AirDrop」一步到位
      if (cap?.isNativePlatform?.() && platform === 'ios'
          && cap.Plugins?.Share && cap.Plugins?.Filesystem) {
        const resp = await fetch(fullUrl, { credentials: 'include' })
        if (!resp.ok) throw new Error(`PDF 加载失败 HTTP ${resp.status}`)
        const blob = await resp.blob()
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve((reader.result as string).split(',')[1])
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
        const fname = `招行回单_${tx.date}_${tx.sequence}.pdf`
        await cap.Plugins.Filesystem.writeFile({
          path: fname,
          data: base64,
          directory: 'CACHE',
        })
        const { uri } = await cap.Plugins.Filesystem.getUri({
          path: fname,
          directory: 'CACHE',
        })
        await cap.Plugins.Share.share({
          title: '招行回单',
          url: uri,
          dialogTitle: '分享回单',
        })
        return
      }

      // ─ 桌面 / 普通浏览器 ─ window.open 内嵌 PDF preview
      const win = window.open(fullUrl, '_blank')
      if (!win) window.location.href = fullUrl
    } catch (e: any) {
      // 用户在系统分享菜单里点取消会抛 error, 静默处理 (不弹错误 alert)
      const msg = String(e?.message || e || '').toLowerCase()
      if (msg.includes('cancel') || msg.includes('canceled') || msg.includes('cancelled')) return
      alert(e?.message || '操作失败')
    } finally {
      setDownloadingSeq(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50" onClick={() => !loading && !downloadingSeq && onClose()}>
      <div className="absolute inset-0 bg-ink/60" />
      <div
        className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[85vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
        <div className="px-4 pt-3 pb-2 flex items-center justify-between">
          <div>
            <h3 className="text-h2">招行流水 · 回单</h3>
            {accountLabel && <p className="text-caption text-gray3">{accountLabel}</p>}
          </div>
          <button onClick={onClose} disabled={loading || !!downloadingSeq}
                  className="text-gray3 px-2 py-1 disabled:opacity-40">关闭</button>
        </div>

        {/* 日期范围 */}
        <div className="px-4 pb-3 flex items-end gap-2">
          <div className="flex-1">
            <label className="text-micro text-gray3 block mb-0.5">起 (yyyymmdd)</label>
            <input
              value={beginDate}
              onChange={e => setBeginDate(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="20260501"
              inputMode="numeric"
              className="w-full bg-bg rounded-chip px-3 py-2 text-body outline-none font-num"
            />
          </div>
          <div className="flex-1">
            <label className="text-micro text-gray3 block mb-0.5">止 (yyyymmdd)</label>
            <input
              value={endDate}
              onChange={e => setEndDate(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="20260514"
              inputMode="numeric"
              className="w-full bg-bg rounded-chip px-3 py-2 text-body outline-none font-num"
            />
          </div>
          <button onClick={query} disabled={loading || beginDate.length !== 8 || endDate.length !== 8}
                  className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {loading ? '查询中…' : '查询'}
          </button>
        </div>

        {err && (
          <div className="mx-4 mb-3 bg-red-bg text-red-fg rounded p-2 text-caption">⚠ {err}</div>
        )}

        {resp?.summary && (
          <div className="mx-4 mb-3 grid grid-cols-2 gap-2">
            <div className="bg-green-bg/40 rounded-card p-3 border border-border">
              <div className="text-micro text-gray3">入账 ({resp.summary.credit.count} 笔)</div>
              <div className="font-num text-h2 text-green-fg">+¥{Number(resp.summary.credit.amount).toLocaleString()}</div>
            </div>
            <div className="bg-red-bg/40 rounded-card p-3 border border-border">
              <div className="text-micro text-gray3">出账 ({resp.summary.debit.count} 笔)</div>
              <div className="font-num text-h2 text-red-fg">−¥{Number(resp.summary.debit.amount).toLocaleString()}</div>
            </div>
          </div>
        )}

        {resp && (resp.transactions?.length ?? 0) === 0 && (
          <p className="text-caption text-gray3 text-center py-8">所选日期范围内无流水</p>
        )}

        {resp?.transactions && resp.transactions.length > 0 && (
          <ul className="px-4 pb-4 space-y-2">
            {resp.transactions.map(tx => {
              const isCredit = tx.direction === 'C'
              return (
                <li key={`${tx.date}-${tx.sequence}`} className="bg-white border border-border rounded-card p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-micro px-1.5 py-0.5 rounded ${isCredit ? 'bg-green-bg text-green-fg' : 'bg-red-bg text-red-fg'}`}>
                      {isCredit ? '入' : '出'}
                    </span>
                    <span className="text-body truncate flex-1">{tx.counterName || '—'}</span>
                    <span className={`font-num text-h2 ${isCredit ? 'text-green-fg' : 'text-red-fg'}`}>
                      {fmtAmount(tx.amount, tx.direction)}
                    </span>
                  </div>
                  <p className="text-micro text-gray3">
                    {tx.date.slice(4, 6)}/{tx.date.slice(6, 8)} {fmtTime(tx.time)}
                    {tx.counterAcct ? ` · 对方 尾号 ${tx.counterAcct.slice(-4)}` : ''}
                    {tx.yurRef ? ` · #${tx.yurRef}` : ''}
                  </p>
                  {tx.remark && <p className="text-micro text-gray2 mt-0.5">附言: {tx.remark}</p>}
                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={() => downloadReceipt(tx)}
                      disabled={!!downloadingSeq || !tx.yurRef}
                      className="text-micro text-amber-fg px-3 py-1 rounded border border-amber/30 hover:bg-amber/10 disabled:opacity-40"
                    >
                      {downloadingSeq === tx.sequence ? '生成中…' : '⬇ 回单'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {resp?.hasMore && (
          <p className="text-caption text-gray3 text-center pb-3">⚠ 还有更多流水未返, 请缩小日期范围</p>
        )}

        <div className="bg-bg-warm border-t border-border px-4 py-2 text-micro text-gray3">
          💡 招行限流: 同账号 10 秒内只能查一次. 回单仅供 SUC 流水使用.
        </div>
      </div>
    </div>
  )
}
