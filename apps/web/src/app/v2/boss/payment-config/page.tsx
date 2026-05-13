/**
 * 老板 · 选门店配置收款 (列表入口)
 * 显示 tenant 下所有真实门店, 点击进入 /v2/boss/stores/:id/settings
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'

type Store = {
  id: string; name: string; no: string
  wechatMerchantId?: string | null
  alipayAppId?: string | null
  bankAccountName?: string | null
  autoSyncRevenue?: boolean
}

export default function PaymentConfigListPage() {
  const [stores, setStores] = useState<Store[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<Store[]>('/api/stores')
      .then(setStores)
      .catch(e => setError(e.message))
  }, [])

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div>
          <h1 className="text-h1">门店收款配置</h1>
          <p className="text-caption text-gray3">微信 / 支付宝 / 美团 / 抖音 / 银行卡</p>
        </div>
      </header>

      <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-3 text-caption text-gray2">
        <p>一店一卡: 每家门店关联自己的银行账户, 收款 T+1 自动到账; 集团账户由租户级配置(统一 cmb apiKey).</p>
        <p className="text-micro text-gray3 mt-1">📌 Sprint A 仅录入字段, 后端定时同步(Sprint B)上线后开关「自动同步」生效</p>
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      <ul className="px-4 mt-3 space-y-2">
        {stores === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {stores?.map(s => {
          const channels: string[] = []
          if (s.wechatMerchantId) channels.push('微信')
          if (s.alipayAppId)      channels.push('支付宝')
          const configured = channels.length > 0 || !!s.bankAccountName
          return (
            <li key={s.id}>
              <a href={`/v2/boss/stores/${s.id}/settings`}
                 className="block bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-h2">{s.name}</span>
                  <span className="text-micro text-gray3 font-num">{s.no}</span>
                  {s.autoSyncRevenue
                    ? <Chip tone="green">自动同步</Chip>
                    : configured
                      ? <Chip tone="orange">仅录入</Chip>
                      : <Chip tone="gray">未配置</Chip>}
                </div>
                <p className="text-caption text-gray2">
                  {channels.length > 0 ? `已开 ${channels.join(' / ')} 收款` : '未配置收款渠道'}
                  {s.bankAccountName ? ` · 银行: ${s.bankAccountName}` : ' · 未绑银行卡'}
                </p>
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
