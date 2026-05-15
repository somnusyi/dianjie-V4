/**
 * 招行实时账户接口（前端 → api → cmb 微服务转发）
 * 权限: ADMIN / FINANCE / SUPER_ADMIN
 * 文档: docs/cmb/2026-05-13-招行BB1PAY-报文规范.md
 *
 * GET  /api/cmb/balance?account=          余额查询 NTQACINF (服务端 11s 缓存)
 * POST /api/cmb/transactions               交易明细 trsQryByBreakPoint
 * POST /api/cmb/receipt                    电子回单 DCSIGREC, 返 { url } 不再返 base64
 * GET  /api/cmb/receipt/:token             公开下载入口 (token = 凭证, 32 hex)
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  cmbBalance,
  cmbTransactions,
  cmbReceipt,
  cmbHealthCheck,
} from '../services/cmbPayment'
import { prisma } from '@dianjie/db'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

// 回单 PDF 落盘目录
//   生产: /app/dianjie-v4/receipts/
//   本地 dev: <repo>/.receipts/
// 启动时确保目录存在 + 启动 24h 清理 timer
const RECEIPT_DIR = process.env.RECEIPT_STORAGE_DIR
  || path.resolve(process.cwd(), '../../.receipts')
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000

function ensureReceiptDir() {
  try { fs.mkdirSync(RECEIPT_DIR, { recursive: true }) } catch {}
}

function cleanupReceipts() {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(RECEIPT_DIR)) {
      if (!/^[a-f0-9]{32}\.pdf$/.test(f)) continue
      const p = path.join(RECEIPT_DIR, f)
      try {
        const st = fs.statSync(p)
        if (now - st.mtimeMs > RECEIPT_TTL_MS) fs.unlinkSync(p)
      } catch {}
    }
  } catch {}
}

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const ROLES_OK = new Set(['ADMIN', 'FINANCE', 'SUPER_ADMIN'])

function requireFinance(req: any, reply: any): boolean {
  if (!ROLES_OK.has(req.user?.role)) {
    reply.status(403).send({ error: '需要 ADMIN / FINANCE 权限' })
    return false
  }
  return true
}

// 服务端缓存 30s + singleflight · 应对招行同账号 10s 限流
//   TTL 30s 比 prewarm 周期 (20s) 长, 保证 cache 永远 fresh, 用户不 loading
//   30s 内余额延迟可接受 (财务看银行余额, 不需秒级实时)
//   singleflight 挡并发雷击 (同账号 1 秒多次请求合并发 1 次)
const BALANCE_TTL_MS = 30_000
const balanceCache = new Map<string, { data: any; at: number }>()
const inflightBalance = new Map<string, Promise<any>>()

async function cachedBalance(account?: string) {
  const key = account || '__default__'
  // 1. 缓存命中且新鲜 (11s 内)
  const hit = balanceCache.get(key)
  if (hit && Date.now() - hit.at < BALANCE_TTL_MS) {
    return { ...hit.data, cached: true, cachedAgeMs: Date.now() - hit.at }
  }
  // 2. singleflight: 当下已有同 key 请求在路上, 直接等它的结果
  //    防并发雷击撞招行限流 (1 秒内 N 个并发请求只发 1 次银行)
  const inflight = inflightBalance.get(key)
  if (inflight) return await inflight
  // 3. 发起新请求 + 内部 retry on 429 + stale cache fallback
  //    招行限流时不直接 502, 而是等 4s / 8s 重试; 全失败仍有过期 cache 时返 stale
  const p = (async () => {
    try {
      let lastFresh: any = null
      let lastErr: any = null
      const delays = [0, 4000, 8000]  // 第 1 次立刻, 第 2 次等 4s, 第 3 次等 8s
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt]) await new Promise(r => setTimeout(r, delays[attempt]))
        try {
          const fresh = await cmbBalance(account)
          if (fresh.success) {
            balanceCache.set(key, { data: fresh, at: Date.now() })
            return fresh
          }
          lastFresh = fresh
          // 招行限流码 → 继续 retry, 其他业务错直接返 (不重试)
          if (fresh.resultCode !== 'RATE_LIMITED') return fresh
        } catch (e: any) {
          lastErr = e
        }
      }
      // 3 次都失败 → stale fallback
      const stale = balanceCache.get(key)
      if (stale) {
        return {
          ...stale.data,
          cached: true,
          degraded: true,
          cachedAgeMs: Date.now() - stale.at,
          resultMsg: `招行接口繁忙, 显示 ${Math.round((Date.now() - stale.at) / 1000)}s 前数据`,
        }
      }
      // 完全没缓存 → 把最后一次错抛出去, endpoint 转 502
      if (lastErr) throw lastErr
      return lastFresh ?? { success: false, resultCode: 'CMB_RETRY_EXHAUSTED', resultMsg: '招行接口持续繁忙, 请稍后再试' }
    } finally {
      inflightBalance.delete(key)
    }
  })()
  inflightBalance.set(key, p)
  return await p
}

// 后台定时预热: 主动刷新所有 cmbBindAccount 非空账户的余额 cache
// 用户开 app 时几乎都命中 cache, 几乎不 loading
// 招行限流维度是 funcode+account, 不同账户**互不撞限流** → 并发预热
// 银行调用频率: 每账户每 20s 一次, 远低于 10s/账户限流上限
let prewarmRunning = false
async function prewarmAllCmbAccounts() {
  if (prewarmRunning) return  // 防并发 (上轮还没跑完时下轮触发)
  prewarmRunning = true
  try {
    const accounts = await prisma.cashAccount.findMany({
      where: { cmbBindAccount: { not: null }, status: 'ACTIVE' },
      select: { cmbBindAccount: true, name: true },
    })
    if (accounts.length === 0) return
    // 并发预热: 不同账户独立 10s 窗口, 互不阻塞, 完成时间 ≈ 1 次银行 RT (~1s)
    const results = await Promise.allSettled(
      accounts.map(a => cachedBalance(a.cmbBindAccount!)),
    )
    const ok = results.filter(r => r.status === 'fulfilled' && ((r.value as any)?.success || (r.value as any)?.cached)).length
    const fail = accounts.length - ok
    console.log(`🔥 cmb prewarm: ${accounts.length} 账户 (${ok} ok / ${fail} fail)`)
  } catch (e: any) {
    console.error('cmb prewarm error:', e?.message || e)
  } finally {
    prewarmRunning = false
  }
}

export const cmbRoutes: FastifyPluginAsync = async (app) => {

  // 健康 / 在线状态（不返钱相关数据，给前端探活用）
  app.get('/status', auth(app), async (req: any, reply: any) => {
    if (!requireFinance(req, reply)) return
    const online = await cmbHealthCheck()
    return { online }
  })

  // 余额 (服务端 11s 缓存避撞招行 10s 限流)
  app.get('/balance', auth(app), async (req: any, reply: any) => {
    if (!requireFinance(req, reply)) return
    const { account } = req.query as { account?: string }
    try {
      return await cachedBalance(account || undefined)
    } catch (e: any) {
      // 网关错(429/网络异常) → 若有缓存仍可用, 返缓存 + degraded 标记
      const key = account || '__default__'
      const hit = balanceCache.get(key)
      if (hit) {
        return {
          ...hit.data, cached: true, degraded: true,
          cachedAgeMs: Date.now() - hit.at,
          resultMsg: `招行限流/异常, 显示 ${Math.round((Date.now() - hit.at) / 1000)}s 前数据`,
        }
      }
      return reply.status(502).send({ success: false, resultCode: 'CMB_UPSTREAM_ERROR', resultMsg: e.message })
    }
  })

  // 交易明细（对账）
  app.post('/transactions', auth(app), async (req: any, reply: any) => {
    if (!requireFinance(req, reply)) return
    const { account, beginDate, endDate } = (req.body || {}) as {
      account?: string; beginDate?: string; endDate?: string
    }
    try {
      return await cmbTransactions({ account, beginDate, endDate })
    } catch (e: any) {
      return reply.status(502).send({ success: false, resultCode: 'CMB_UPSTREAM_ERROR', resultMsg: e.message })
    }
  })

  // 电子回单 — 落盘后返 url, 前端 window.open 即可
  // 不再返 base64 (旧实现 Capacitor webview 下 <a download> + Filesystem API 找不到下载位置, 体验差)
  app.post('/receipt', auth(app), async (req: any, reply: any) => {
    if (!requireFinance(req, reply)) return
    const { account, yurRef, date, sequence } = (req.body || {}) as {
      account?: string; yurRef: string; date: string; sequence: string
    }
    if (!yurRef || !date || !sequence) {
      return reply.status(400).send({ error: '缺少 yurRef / date / sequence' })
    }
    try {
      const r = await cmbReceipt({ account, yurRef, date, sequence })
      if (!r.success || !r.pdfBase64) {
        return { success: false, resultCode: r.resultCode, resultMsg: r.resultMsg }
      }
      ensureReceiptDir()
      const token = crypto.randomBytes(16).toString('hex')
      const filename = `${token}.pdf`
      fs.writeFileSync(path.join(RECEIPT_DIR, filename), Buffer.from(r.pdfBase64, 'base64'))
      return {
        success:   true,
        resultCode: r.resultCode,
        url:       `/api/cmb/receipt/${filename}`,   // 相对 URL, 前端 window.open 走当前 origin
        filename,
        checkCode: r.checkCode,
        expiresAt: Date.now() + RECEIPT_TTL_MS,
      }
    } catch (e: any) {
      return reply.status(502).send({ success: false, resultCode: 'CMB_UPSTREAM_ERROR', resultMsg: e.message })
    }
  })

  // 公开下载入口 — token 即凭证, 24h 内有效, 不需 JWT
  //   token entropy = 128 bit, 暴力枚举不现实
  //   不暴露目录列表, 路径用正则锁死
  //   query ?download=1 → Content-Disposition: attachment (Android WebView 触发 DownloadManager)
  //   默认 inline → iOS WKWebView / 桌面浏览器内嵌 PDF preview
  app.get('/receipt/:token', async (req: any, reply: any) => {
    const { token } = req.params as { token: string }
    const { download } = (req.query || {}) as { download?: string }
    if (!/^[a-f0-9]{32}\.pdf$/.test(token)) {
      return reply.status(400).send({ error: 'invalid token format' })
    }
    const filepath = path.join(RECEIPT_DIR, token)
    try {
      const stat = await fs.promises.stat(filepath)
      if (Date.now() - stat.mtimeMs > RECEIPT_TTL_MS) {
        try { await fs.promises.unlink(filepath) } catch {}
        return reply.status(410).send({ error: '回单已过期 (24h TTL)' })
      }
      const stream = fs.createReadStream(filepath)
      // 文件名给用户看着舒服一些 (实际 entropy 还在 token 上)
      const friendlyName = `招行回单_${new Date().toISOString().slice(0, 10)}.pdf`
      const disposition = download
        ? `attachment; filename="${encodeURIComponent(friendlyName)}"`
        : `inline; filename="${encodeURIComponent(friendlyName)}"`
      return reply
        .type('application/pdf')
        .header('Content-Disposition', disposition)
        .header('Cache-Control', 'private, max-age=300')
        .send(stream)
    } catch {
      return reply.status(404).send({ error: '回单不存在或已过期' })
    }
  })

  // 启动期: 确保目录在 + 启清理 timer
  ensureReceiptDir()
  cleanupReceipts()
  setInterval(cleanupReceipts, 60 * 60 * 1000).unref()  // 每小时清一次, unref 不阻止进程退出

  // 后台 cmb 余额预热: 启动 5s 后第一次, 之后每 20s 一次 (覆盖 30s TTL)
  // 不同账户并发预热, 单轮 ≈ 1 秒 RT, 完美填补 cache 窗口
  setTimeout(() => { prewarmAllCmbAccounts() }, 5_000)
  setInterval(() => { prewarmAllCmbAccounts() }, 20_000).unref()
}
