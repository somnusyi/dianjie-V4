'use client'

import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import FinanceTopNav from '../../_topnav'
import { apiFetch } from '@/lib/v2-auth'

type StoreLifecyclePhase =
  | 'PLANNING'
  | 'NEGOTIATING'
  | 'CONSTRUCTION'
  | 'EQUIPMENT'
  | 'LICENSING'
  | 'TRIAL'
  | 'OPERATING'

type FormState = {
  no: string
  name: string
  address: string
  phone: string
  managerName: string
  lifecyclePhase: StoreLifecyclePhase
  expectedOpenAt: string
  bankAccountName: string
  invoiceTaxId: string
  bankName: string
  bankAccountNo: string
}

const lifecycleOptions: Array<{ value: StoreLifecyclePhase; label: string }> = [
  { value: 'PLANNING', label: '选址筹备' },
  { value: 'NEGOTIATING', label: '合同谈判' },
  { value: 'CONSTRUCTION', label: '装修施工' },
  { value: 'EQUIPMENT', label: '设备物料' },
  { value: 'LICENSING', label: '证照办理' },
  { value: 'TRIAL', label: '试营业' },
  { value: 'OPERATING', label: '正常营业' },
]

const initialForm: FormState = {
  no: '',
  name: '',
  address: '',
  phone: '',
  managerName: '',
  lifecyclePhase: 'PLANNING',
  expectedOpenAt: '',
  bankAccountName: '',
  invoiceTaxId: '',
  bankName: '',
  bankAccountNo: '',
}

export default function FinanceNewStorePage() {
  const router = useRouter()
  const [form, setForm] = useState<FormState>(initialForm)
  const [submitting, setSubmitting] = useState(false)
  const [loadingNo, setLoadingNo] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<{ suggested: string }>('/api/stores/next-no')
      .then(data => setForm(current => ({ ...current, no: data.suggested || current.no })))
      .catch(e => setError(e?.message || '无法生成门店编号'))
      .finally(() => setLoadingNo(false))
  }, [])

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(current => ({ ...current, [key]: value }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)

    if (!form.no.trim() || !form.name.trim()) {
      setError('门店编号和门店名称为必填项')
      return
    }

    const invoiceFields = [form.bankAccountName, form.invoiceTaxId, form.bankName, form.bankAccountNo]
    const filledInvoiceFields = invoiceFields.filter(value => value.trim()).length
    if (filledInvoiceFields > 0 && filledInvoiceFields < invoiceFields.length) {
      setError('开票信息需要同时填写公司全称、税号、开户行和银行账户')
      return
    }
    if (form.bankAccountNo.trim() && !/^[\d\s-]+$/.test(form.bankAccountNo.trim())) {
      setError('银行账户只能包含数字、空格或短横线')
      return
    }

    setSubmitting(true)
    try {
      const expectedOpenAt = form.expectedOpenAt
        ? new Date(`${form.expectedOpenAt}T00:00:00+08:00`).toISOString()
        : undefined
      const created = await apiFetch<{ id: string }>('/api/stores', {
        method: 'POST',
        body: JSON.stringify({
          no: form.no.trim().toUpperCase(),
          name: form.name.trim(),
          address: form.address.trim() || undefined,
          phone: form.phone.trim() || undefined,
          managerName: form.managerName.trim() || undefined,
          lifecyclePhase: form.lifecyclePhase,
          expectedOpenAt,
          bankAccountName: form.bankAccountName.trim() || undefined,
          invoiceTaxId: form.invoiceTaxId.trim().toUpperCase() || undefined,
          bankName: form.bankName.trim() || undefined,
          bankAccountNo: form.bankAccountNo.trim() || undefined,
        }),
      })
      router.replace(`/v2/finance-pc/stores?created=${encodeURIComponent(created.id)}`)
    } catch (e: any) {
      setError(e?.message || '创建店铺失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[980px] mx-auto px-6 py-6">
        <div className="flex items-center gap-2 mb-4">
          <a href="/v2/finance-pc/stores" className="text-gray2 hover:text-ink text-caption">← 各店</a>
          <span className="text-gray3">/</span>
          <span className="text-caption text-gray2">新建店铺</span>
        </div>

        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-h1">新建店铺</h1>
            <p className="text-caption text-gray3 mt-1">建立门店主档案，后续再为店长、厨师长创建账号并绑定该店铺</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => router.back()}
              className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">
              取消
            </button>
            <button form="new-store-form" type="submit" disabled={submitting || loadingNo}
              className="px-5 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
              {submitting ? '创建中…' : '创建店铺'}
            </button>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        <form id="new-store-form" onSubmit={submit} className="space-y-4">
          <section className="bg-white rounded-card border border-border p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-h2">① 门店基础信息</h2>
              <span className="text-micro text-gray3">* 为必填</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="门店编号 *" hint="系统内唯一，建议 DJ + 三位数">
                <input value={form.no} onChange={e => update('no', e.target.value.toUpperCase())}
                  maxLength={20} placeholder={loadingNo ? '生成中…' : 'DJ001'}
                  className="input-control font-num" />
              </Field>
              <Field label="门店名称 *">
                <input value={form.name} onChange={e => update('name', e.target.value)}
                  maxLength={80} placeholder="例：合肥政务区店" className="input-control" />
              </Field>
              <Field label="门店地址">
                <input value={form.address} onChange={e => update('address', e.target.value)}
                  maxLength={240} placeholder="省 / 市 / 区 / 街道 / 商场楼层" className="input-control" />
              </Field>
              <Field label="门店电话">
                <input value={form.phone} onChange={e => update('phone', e.target.value)}
                  maxLength={40} placeholder="座机或门店联系手机" className="input-control font-num" />
              </Field>
              <Field label="店长姓名" hint="此处只建档，账号需在团队成员中另行创建">
                <input value={form.managerName} onChange={e => update('managerName', e.target.value)}
                  maxLength={40} placeholder="可稍后补充" className="input-control" />
              </Field>
            </div>
          </section>

          <section className="bg-white rounded-card border border-border p-4">
            <h2 className="text-h2 mb-4">② 开店阶段</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="当前阶段 *">
                <select value={form.lifecyclePhase}
                  onChange={e => update('lifecyclePhase', e.target.value as StoreLifecyclePhase)}
                  className="input-control">
                  {lifecycleOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="预计开业日期">
                <input type="date" value={form.expectedOpenAt}
                  onChange={e => update('expectedOpenAt', e.target.value)}
                  className="input-control font-num" />
              </Field>
            </div>
            <p className="text-caption text-gray3 mt-3">门店创建后默认启用；筹建店可先建账号、商品和供应链关系，营业后再切换为“正常营业”。</p>
          </section>

          <section className="bg-white rounded-card border border-border p-4">
            <h2 className="text-h2 mb-1">③ 开票与收款档案</h2>
            <p className="text-caption text-gray3 mb-4">选填；如填写，四项需同时完整。敏感支付密钥不在这里配置。</p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="户名（公司全称）">
                <input value={form.bankAccountName} onChange={e => update('bankAccountName', e.target.value)}
                  maxLength={80} placeholder="营业执照上的公司全称" className="input-control" />
              </Field>
              <Field label="税号">
                <input value={form.invoiceTaxId} onChange={e => update('invoiceTaxId', e.target.value.toUpperCase())}
                  maxLength={40} placeholder="统一社会信用代码" className="input-control font-num" />
              </Field>
              <Field label="开户行">
                <input value={form.bankName} onChange={e => update('bankName', e.target.value)}
                  maxLength={60} placeholder="开户银行及支行" className="input-control" />
              </Field>
              <Field label="银行账户">
                <input value={form.bankAccountNo} onChange={e => update('bankAccountNo', e.target.value)}
                  maxLength={40} inputMode="numeric" placeholder="对公账户" className="input-control font-num" />
              </Field>
            </div>
          </section>

          <div className="bg-orange-bg border border-orange/30 rounded-card p-4 text-caption text-orange-fg">
            创建完成后，还需在“团队成员”中为新店建立店长、厨师长账号，并将账号绑定到该店铺。
          </div>
        </form>
      </main>

      <style jsx>{`
        .input-control {
          width: 100%;
          border: 1px solid var(--border, #e6dfd5);
          border-radius: 10px;
          background: #fff;
          padding: 10px 12px;
          color: #221b15;
          outline: none;
        }
        .input-control:focus {
          border-color: #a8722a;
          box-shadow: 0 0 0 3px rgba(168, 114, 42, 0.1);
        }
      `}</style>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-micro text-gray3 block mb-1">{label}</span>
      {children}
      {hint && <span className="text-micro text-gray3 block mt-1">{hint}</span>}
    </label>
  )
}
