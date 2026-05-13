/**
 * 老板 · 门店收款配置 (Sprint A.2 · 聚合通道一等公民)
 *
 * 配置组合 (按 80% 中型连锁场景排序):
 *   1. 主通道 (50% 收款) — 聚合平台 (收钱吧/钱方等), 一店一码自动分账
 *   2. 平台券 (40%) — 美团 / 抖音 商户ID, 用于 CSV 对账
 *   3. 自营生态 (折叠, 选填) — 微信支付 / 支付宝 直连 (做小程序时才需)
 *   4. 出账银行卡 — 所有通道 T+1 都打这里
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'

type Cfg = {
  id?: string; name?: string; no?: string
  paymentChannelType?: 'AGGREGATOR' | 'WECHAT_DIRECT' | 'ALIPAY_DIRECT' | string
  aggregatorVendor?: string | null
  aggregatorMerchantId?: string | null
  aggregatorApiKeyConfigured?: boolean
  aggregatorSecretConfigured?: boolean
  wechatMerchantId?: string | null
  wechatApiV3Configured?: boolean
  alipayAppId?: string | null
  alipayPrivateConfigured?: boolean
  meituanShopId?: string | null
  douyinShopId?: string | null
  bankAccountNoMasked?: string | null
  bankAccountName?: string | null
  bankName?: string | null
  autoSyncRevenue?: boolean
}

const AGGREGATORS = [
  { key: 'qianqian', label: '收钱吧',   note: '餐饮聚合龙头 · API 全' },
  { key: 'qfpay',    label: '钱方好近', note: '茶饮零售口碑好' },
  { key: 'lakala',   label: '拉卡拉',   note: '银联背景 · 上市公司' },
  { key: 'hesh',     label: '合利宝',   note: '费率较低' },
]

const LS_KEY = (id: string) => `store-pay-cfg:${id}`

export default function StoreSettingsPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params?.id as string
  const [cfg, setCfg] = useState<Cfg>({})
  const [vals, setVals] = useState<Record<string, string>>({})
  const [auto, setAuto] = useState(false)
  const [showDirect, setShowDirect] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)
  const [usingLocalStorage, setUsingLocalStorage] = useState(false)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    apiFetch<Cfg>(`/api/stores/${id}/payment-config`)
      .then(d => {
        setCfg(d); setAuto(!!d.autoSyncRevenue)
        setVals({
          aggregatorVendor: d.aggregatorVendor || 'qianqian',
          aggregatorMerchantId: d.aggregatorMerchantId || '',
          wechatMerchantId: d.wechatMerchantId || '',
          alipayAppId: d.alipayAppId || '',
          meituanShopId: d.meituanShopId || '',
          douyinShopId: d.douyinShopId || '',
          bankAccountNoMasked: d.bankAccountNoMasked || '',
          bankAccountName: d.bankAccountName || '',
          bankName: d.bankName || '',
        })
        setShowDirect(!!d.wechatMerchantId || !!d.alipayAppId)
      })
      .catch(() => {
        setUsingLocalStorage(true)
        Promise.all([
          apiFetch<any[]>('/api/stores').catch(() => []),
          Promise.resolve().then(() => {
            try { return JSON.parse(localStorage.getItem(LS_KEY(id)) || '{}') } catch { return {} }
          }),
        ]).then(([list, ls]) => {
          const s = (Array.isArray(list) ? list : []).find(x => x.id === id)
          setCfg({ ...ls, id: id, name: s?.name, no: s?.no })
          setAuto(!!ls.autoSyncRevenue)
          setVals({ aggregatorVendor: 'qianqian', ...ls })
          setShowDirect(!!ls.wechatMerchantId || !!ls.alipayAppId)
        })
      })
      .finally(() => setLoading(false))
  }, [id])

  function setV(k: string, v: string) { setVals(prev => ({ ...prev, [k]: v })); setSavedOk(false) }

  async function save() {
    setError(null); setSubmitting(true); setSavedOk(false)
    const body: any = {
      paymentChannelType: 'AGGREGATOR',
      aggregatorVendor: vals.aggregatorVendor,
      aggregatorMerchantId: vals.aggregatorMerchantId,
      wechatMerchantId: vals.wechatMerchantId,
      alipayAppId:      vals.alipayAppId,
      meituanShopId:    vals.meituanShopId,
      douyinShopId:     vals.douyinShopId,
      bankAccountName:  vals.bankAccountName,
      bankName:         vals.bankName,
      autoSyncRevenue:  auto,
    }
    if (vals.aggregatorApiKey) body.aggregatorApiKey = vals.aggregatorApiKey
    if (vals.aggregatorSecret) body.aggregatorSecret = vals.aggregatorSecret
    if (vals.wechatApiV3Key)   body.wechatApiV3Key   = vals.wechatApiV3Key
    if (vals.alipayPrivateKey) body.alipayPrivateKey = vals.alipayPrivateKey
    if (vals.bankAccountNo)    body.bankAccountNo    = vals.bankAccountNo

    try {
      await apiFetch(`/api/stores/${id}/payment-config`, { method: 'PATCH', body: JSON.stringify(body) })
      setSavedOk(true)
    } catch (e: any) {
      try {
        localStorage.setItem(LS_KEY(id), JSON.stringify({
          ...body,
          ...(vals.bankAccountNo ? { bankAccountNoMasked: `**** ${vals.bankAccountNo.slice(-4)}` } : {})
        }))
        setUsingLocalStorage(true); setSavedOk(true)
      } catch { setError(e.message || '保存失败') }
    }
    setSubmitting(false)
  }

  if (loading) return <div className="min-h-screen bg-bg flex items-center justify-center"><span className="text-caption text-gray3">加载中…</span></div>

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div>
          <h1 className="text-h1">门店收款配置</h1>
          <p className="text-caption text-gray3">{cfg.name || '门店'} · {cfg.no || ''}</p>
        </div>
      </header>

      {usingLocalStorage && (
        <div className="mx-4 mt-3 bg-amber/10 border border-amber/30 rounded-card p-3 text-caption text-gray2">
          <span className="text-amber-fg">⚠ 临时模式</span> · 后端 API 未部署, 配置已暂存到本浏览器
        </div>
      )}

      {/* 自动同步开关 */}
      <div className="px-4 mt-3">
        <div className="bg-ink text-white rounded-card p-3 flex items-start gap-3">
          <div className="flex-1">
            <div className="text-button">每日自动同步营业额</div>
            <div className="text-micro text-white/60 mt-0.5">凌晨从 聚合 / 微信 / 支付宝 拉昨日流水</div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer mt-1">
            <input type="checkbox" className="sr-only peer" checked={auto} onChange={e => { setAuto(e.target.checked); setSavedOk(false) }} />
            <span className="w-11 h-6 bg-white/20 rounded-full peer-checked:bg-amber transition-all relative
                              after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:bg-white after:rounded-full after:transition-transform peer-checked:after:translate-x-5" />
          </label>
        </div>
      </div>

      {/* 主通道:聚合平台 */}
      <Section title="主收款通道" right="店内扫码 / 小程序 / 桌签码">
        <div className="bg-white rounded-card border border-border p-3">
          <p className="text-caption text-gray2 mb-1">推荐 <span className="text-amber-fg font-medium">收钱吧服务商模式</span>: 一套通道覆盖店内扫码 + 自营小程序, 0.31% 全场景统一费率</p>
          <p className="text-micro text-gray3">省去"申请微信/支付宝商户号"的 1-2 月审核周期, 收钱吧代办特约商户</p>
          <div className="grid grid-cols-2 gap-2 mt-3">
            {AGGREGATORS.map(a => (
              <label key={a.key}
                className={`p-3 rounded-card border cursor-pointer transition-all ${
                  vals.aggregatorVendor === a.key
                    ? 'border-amber bg-amber/5'
                    : 'border-border bg-white'
                }`}>
                <input type="radio" name="vendor" className="sr-only"
                       checked={vals.aggregatorVendor === a.key}
                       onChange={() => setV('aggregatorVendor', a.key)} />
                <div className="text-h2">{a.label}</div>
                <div className="text-micro text-gray3 mt-0.5">{a.note}</div>
              </label>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-card border border-border divide-y divide-border mt-2">
          <Field label="商户号 / 店铺ID">
            <input value={vals.aggregatorMerchantId || ''} onChange={e => setV('aggregatorMerchantId', e.target.value)}
                   placeholder="平台后台分配" className={IN} />
          </Field>
          <Field label="API Key" hint={cfg.aggregatorApiKeyConfigured ? '已存, 留空不修改' : '从平台开放接口处获取'}>
            <input value={vals.aggregatorApiKey || ''} onChange={e => setV('aggregatorApiKey', e.target.value)}
                   placeholder={cfg.aggregatorApiKeyConfigured ? '••••••••' : '示例: app_id_xxx'} className={IN} />
          </Field>
          <Field label="API Secret" hint={cfg.aggregatorSecretConfigured ? '已存, 留空不修改' : '部分平台需要(收钱吧需要)'}>
            <input value={vals.aggregatorSecret || ''} onChange={e => setV('aggregatorSecret', e.target.value)}
                   placeholder={cfg.aggregatorSecretConfigured ? '••••••••' : ''} className={IN} />
          </Field>
        </div>
      </Section>

      {/* 平台券核销 */}
      <Section title="平台券" right="美团 / 抖音 用 CSV 对账">
        <div className="bg-white rounded-card border border-border divide-y divide-border">
          <Field label="美团/大众点评 门店 ID">
            <input value={vals.meituanShopId || ''} onChange={e => setV('meituanShopId', e.target.value)}
                   placeholder="美团商户后台获取" className={IN} />
          </Field>
          <Field label="抖音生活服务 门店 ID">
            <input value={vals.douyinShopId || ''} onChange={e => setV('douyinShopId', e.target.value)}
                   placeholder="抖音生活服务后台" className={IN} />
          </Field>
        </div>
        <p className="text-micro text-gray3 px-1 mt-1">⏱ 录入后, 店长每周到 <a href="/v2/manager/upload-platform" className="text-amber-fg">「上传平台对账」</a> 上传 CSV</p>
      </Section>

      {/* 出账银行卡 */}
      <Section title="出账银行卡" right={cfg.bankAccountNoMasked ? '已绑' : '未绑'}>
        <div className="bg-white rounded-card border border-border divide-y divide-border">
          <Field label="开户行">
            <input value={vals.bankName || ''} onChange={e => setV('bankName', e.target.value)} placeholder="招商银行 南京 XX 支行" className={IN} />
          </Field>
          <Field label="户名">
            <input value={vals.bankAccountName || ''} onChange={e => setV('bankAccountName', e.target.value)} placeholder="南京XX餐饮有限公司" className={IN} />
          </Field>
          <Field label="账号" hint={cfg.bankAccountNoMasked ? `当前:${cfg.bankAccountNoMasked} · 留空不修改` : '完整账号'}>
            <input value={vals.bankAccountNo || ''} onChange={e => setV('bankAccountNo', e.target.value)}
                   placeholder={cfg.bankAccountNoMasked || '6225 XXXX XXXX XXXX'} className={IN + ' font-num'} />
          </Field>
        </div>
        <p className="text-micro text-gray3 px-1 mt-1">提示: 招行 cmb apiKey 为<a className="text-amber-fg" href="#">租户级配置</a>, 此处只录卡号</p>
      </Section>

      {/* 自营直连 (高级, 默认折叠) */}
      <Section title="自营生态(高级 · 备用)" right={
        <button onClick={() => setShowDirect(!showDirect)} className="text-caption text-amber-fg">
          {showDirect ? '收起 ▴' : '展开 ▾'}
        </button>
      }>
        {!showDirect ? (
          <div className="bg-white rounded-card border border-border p-3 text-caption text-gray3">
            收钱吧服务商模式已覆盖小程序场景 · 此处仅在未来想完全自主管理商户号时启用
          </div>
        ) : (
          <>
            <div className="bg-white rounded-card border border-border divide-y divide-border">
              <Field label="微信支付商户号 (mchid)" hint="从微信支付商户后台获取">
                <input value={vals.wechatMerchantId || ''} onChange={e => setV('wechatMerchantId', e.target.value)}
                       placeholder="1234567890" className={IN} />
              </Field>
              <Field label="微信 APIv3 密钥" hint={cfg.wechatApiV3Configured ? '已存, 留空不修改' : '32 位字符'}>
                <input value={vals.wechatApiV3Key || ''} onChange={e => setV('wechatApiV3Key', e.target.value)}
                       placeholder={cfg.wechatApiV3Configured ? '••••••••' : ''} className={IN} />
              </Field>
              <Field label="支付宝 应用 ID">
                <input value={vals.alipayAppId || ''} onChange={e => setV('alipayAppId', e.target.value)}
                       placeholder="2021000000000000" className={IN} />
              </Field>
              <Field label="支付宝 商户私钥" hint={cfg.alipayPrivateConfigured ? '已存, 留空不修改' : 'PKCS#1 RSA2048'}>
                <textarea value={vals.alipayPrivateKey || ''} onChange={e => setV('alipayPrivateKey', e.target.value)}
                          placeholder={cfg.alipayPrivateConfigured ? '••••••••' : 'MIIEvQIBADAN...'}
                          rows={3} className={IN + ' resize-none'} />
              </Field>
            </div>
          </>
        )}
      </Section>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
      {savedOk && <div className="mx-4 mt-3 bg-green-bg text-green-fg rounded-card p-3 text-caption">✓ 已保存</div>}

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button onClick={() => router.back()} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
        <button onClick={save} disabled={submitting} className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {submitting ? '保存中…' : '保存配置'}
        </button>
      </div>
    </div>
  )
}

const IN = 'w-full text-body bg-transparent outline-none py-1'

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && (typeof right === 'string' ? <span className="text-caption text-gray3">{right}</span> : right)}
      </div>
      {children}
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5">
      <label className="text-micro text-gray3 block mb-0.5">{label}</label>
      {children}
      {hint && <p className="text-micro text-gray4 mt-0.5">{hint}</p>}
    </div>
  )
}
