/**
 * 招行实时账户卡片
 * - 接 /api/cmb/balance 拿实时余额
 * - 区分「母公司·主账户」/「子公司·xxx」标签
 * - 数组化设计: <BankAccountList accounts={[...]} />, 现在 1 个总账户, 未来加子公司只 push entry
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { BankTransactionsDrawer } from './bank-transactions-drawer'

export type BankAccountConfig = {
  /** 内部标识，用于 fetch */
  account?: string         // 留空 = 用后端 env 默认 (母公司总账户)
  /** UI 显示用 */
  label: string            // "母公司·主账户" / "子公司·昆明翠湖店"
  accountName: string      // "南京云洱之境餐饮有限公司"
  bankName: string         // "招商银行南京城东支行"
  accountType?: string     // "一般户"
}

type BalanceResp = {
  success:     boolean
  resultCode:  string
  resultMsg:   string
  account?:    string
  accountName?: string
  balance?:    string
  available?:  string
  held?:       string
  currency?:   string
  status?:     string
}

// 招行同账号 10s 限流, 用 sessionStorage 共享缓存
// 跟服务端 30s TTL 对齐: 后台 prewarm 每 20s 自动刷新 cache, 用户开 app 几乎都命中
const CACHE_TTL_MS = 30_000

type Cached = { data: BalanceResp; at: number }
function cacheKey(account?: string) { return `cmb:balance:${account || 'default'}` }
function readCache(account?: string): Cached | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(cacheKey(account))
    if (!raw) return null
    const c = JSON.parse(raw) as Cached
    if (Date.now() - c.at > CACHE_TTL_MS) return null
    return c
  } catch { return null }
}
function writeCache(account: string | undefined, data: BalanceResp) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(cacheKey(account), JSON.stringify({ data, at: Date.now() }))
  } catch {}
}

export function BankAccountCard({ config, onTransfer }: {
  config: BankAccountConfig
  onTransfer?: () => void   // 传了就显示「⇄ 转账」按钮 (放在刷新按钮左边, 财务用)
}) {
  const [data, setData] = useState<BalanceResp | null>(null)
  const [err, setErr]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshAt, setRefreshAt] = useState<Date | null>(null)
  const [txDrawerOpen, setTxDrawerOpen] = useState(false)

  async function load(opts: { force?: boolean } = {}) {
    // 缓存命中且非强制刷新, 直接用缓存, 不打银行
    if (!opts.force) {
      const cached = readCache(config.account)
      if (cached) {
        setData(cached.data); setRefreshAt(new Date(cached.at))
        setLoading(false); setErr(null)
        return
      }
    }
    setLoading(true); setErr(null)
    try {
      const qs = config.account ? `?account=${encodeURIComponent(config.account)}` : ''
      const resp = await apiFetch<BalanceResp>(`/api/cmb/balance${qs}`)
      if (!resp.success) {
        setErr(resp.resultMsg || resp.resultCode || '未知错误')
      } else {
        setData(resp); setRefreshAt(new Date())
        writeCache(config.account, resp)
      }
    } catch (e: any) {
      // 失败时若有过期缓存仍保留显示, 仅提示
      setErr(e?.message || '请求失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() /* eslint-disable-next-line */ }, [])

  const balance   = Number(data?.balance || 0)
  const available = Number(data?.available || 0)
  const held      = Number(data?.held || 0)
  const isMain    = config.label.startsWith('母公司')

  return (
    <div className="bg-white rounded-card border border-border p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-micro px-2 py-0.5 rounded ${isMain ? 'bg-amber-bg text-amber-fg' : 'bg-gray-bg text-gray2'} font-medium`}>
              {config.label}
            </span>
            {config.accountType && (
              <span className="text-micro text-gray3">{config.accountType}</span>
            )}
          </div>
          <h3 className="text-body font-medium truncate">{config.accountName}</h3>
          <p className="text-micro text-gray3 mt-0.5 truncate">
            {config.bankName}
            {data?.account ? ` · 尾号 ${String(data.account).slice(-4)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {onTransfer && (
            <button
              onClick={onTransfer}
              className="text-micro text-amber-fg px-2 py-1 rounded hover:bg-bg"
              title="向其他招行账户转账"
            >
              ⇄ 转账
            </button>
          )}
          <button
            onClick={() => load({ force: true })}
            disabled={loading}
            className="text-micro text-amber-fg px-2 py-1 rounded hover:bg-bg disabled:opacity-50"
          >
            {loading ? '刷新中…' : '⟳ 刷新'}
          </button>
        </div>
      </div>

      {err && (
        <div className="bg-red-bg text-red-fg text-caption rounded p-2 mb-2">
          ⚠ {err}
        </div>
      )}

      {loading && !data && (
        <p className="text-caption text-gray3 text-center py-4">加载招行实时余额…</p>
      )}

      {data && (
        <div className="grid grid-cols-3 gap-3 pt-2 border-t border-border">
          <div>
            <div className="text-micro text-gray3">账户余额</div>
            <div className="font-num text-h2 mt-0.5">¥{balance.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
          </div>
          <div>
            <div className="text-micro text-gray3">可用</div>
            <div className="font-num text-h2 mt-0.5 text-green-fg">¥{available.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
          </div>
          <div>
            <div className="text-micro text-gray3">冻结</div>
            <div className={`font-num text-h2 mt-0.5 ${held > 0 ? 'text-red-fg' : 'text-gray3'}`}>¥{held.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
          </div>
        </div>
      )}

      {data && (
        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={() => setTxDrawerOpen(true)}
            className="text-micro text-amber-fg px-2 py-1 rounded hover:bg-bg"
          >
            查流水 · 下回单 ›
          </button>
          {refreshAt && (
            <span className="text-micro text-gray4">
              更新于 {refreshAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
      )}

      <BankTransactionsDrawer
        open={txDrawerOpen}
        account={config.account}
        accountLabel={`${config.label} · ${config.accountName}`}
        onClose={() => setTxDrawerOpen(false)}
      />
    </div>
  )
}

/** 多账户列表，未来加子公司直接 push entry */
export function BankAccountList({ accounts }: { accounts: BankAccountConfig[] }) {
  return (
    <div className="space-y-3">
      {accounts.map((acc, i) => (
        <BankAccountCard key={i} config={acc} />
      ))}
      {accounts.length === 0 && (
        <p className="text-caption text-gray3 text-center py-4">未配置银行账户</p>
      )}
    </div>
  )
}
