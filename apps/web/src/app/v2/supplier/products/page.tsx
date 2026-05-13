/**
 * 供应商 · 商品报价表
 *
 * 接 GET /api/products （后端按 supplierId 自动过滤）
 * 行内可改：单价 / 安全库存 / 状态
 * PATCH /api/products/:id { price, stock, minStock, status }
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { EmptyState, SkeletonCard, FriendlyError } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'

type Product = {
  id: string; code: string; name: string; category: string; unit: string
  price: number | string; stock: number | string; minStock: number | string
  minOrderQty?: number | string; stepQty?: number | string
  status: string
}

type NewSku = {
  code: string; name: string; spec: string; category: string; unit: string
  price: string; stock: string; minStock: string; shelfDays: string
  minOrderQty: string; stepQty: string
}
// 默认值跟报价模板对齐: 必填只有 名称 + 规格 + 单位 + 单价
// code 留空会自动生成 (供应商前缀+时间戳), category 缺省"其他"
const EMPTY_SKU: NewSku = { code: '', name: '', spec: '', category: '', unit: '件', price: '', stock: '0', minStock: '0', shelfDays: '7', minOrderQty: '1', stepQty: '1' }

type Batch = {
  id: string; filename: string | null
  totalRows: number; createdCount: number; failedCount: number
  revokedAt: string | null
  createdAt: string
  _count?: { products: number }
}

function timeAgo(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  const d = new Date(iso)
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`
}

export default function SupplierProductsPage() {
  const [tab, setTab] = useState('me')
  const [products, setProducts] = useState<Product[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ price: string; stock: string }>({ price: '', stock: '' })
  const [submitting, setSubmitting] = useState(false)
  const [confirmState, openConfirm] = useConfirmSheet()
  const [createOpen, setCreateOpen] = useState(false)
  const [newSku, setNewSku] = useState<NewSku>(EMPTY_SKU)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [batches, setBatches] = useState<Batch[] | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  function load() {
    apiFetch<Product[]>('/api/products')
      .then(d => setProducts(Array.isArray(d) ? d : []))
      .catch(e => setError(String(e?.message || e)))
    apiFetch<Batch[]>('/api/products/batches')
      .then(d => setBatches(Array.isArray(d) ? d : []))
      .catch(() => setBatches([]))
  }
  useEffect(() => { load() }, [])

  function revokeBatch(b: Batch) {
    openConfirm({
      title: `撤回这次上传?`,
      body: `${b.filename || '(未命名)'} · 上架 ${b.createdCount} 个商品\n撤回会删除该批次仍未单独删除的商品 (${b._count?.products ?? '?'} 个), 不可恢复`,
      confirmLabel: '撤回',
      tone: 'danger',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/products/batches/${b.id}/revoke`, { method: 'PATCH' })
          load()
        } catch (e: any) { alert(e.message || '撤回失败'); throw e }
      },
    })
  }

  function startEdit(p: Product) {
    setEditing(p.id)
    setDraft({ price: String(p.price), stock: String(p.stock) })
  }
  function cancelEdit() {
    setEditing(null)
  }
  async function save(p: Product) {
    if (submitting) return
    const newPrice = Number(draft.price)
    if (Math.abs(newPrice - Number(p.price)) < 0.01) {
      setEditing(null); return
    }
    const oldPrice = Number(p.price)
    const isUp = newPrice > oldPrice && oldPrice > 0
    openConfirm({
      title: `${isUp ? '涨价' : oldPrice === 0 ? '首次定价' : '降价'}「${p.name}」`,
      body: `单价 ¥${oldPrice.toFixed(2)} → ¥${newPrice.toFixed(2)}\n\n${
        isUp ? '⚠ 涨价需总厨审批通过后才生效.' : '✓ 立即生效, 无需审批.'
      }`,
      confirmLabel: isUp ? '提交审批' : '立即生效',
      tone: isUp ? 'primary' : 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          const res: any = await apiFetch(`/api/products/${p.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ price: newPrice }),
          })
          setEditing(null)
          if (res?.priceChangeStatus === 'PENDING_APPROVAL') {
            alert(`⏳ 涨价单 ${res.documentNo} 已提交总厨审批 (通过后才生效)`)
          } else {
            alert('✓ 价格已更新')
          }
          load()
        } catch (e: any) {
          alert(e.message || '保存失败')
          throw e
        } finally {
          setSubmitting(false)
        }
      },
    })
  }
  async function toggleStatus(p: Product) {
    const next = p.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'
    openConfirm({
      title: next === 'ENABLED' ? `恢复供应「${p.name}」?` : `停止供应「${p.name}」?`,
      body: next === 'DISABLED' ? '停止后餐厅下单时不会显示此商品' : '恢复后餐厅可重新下单',
      confirmLabel: next === 'ENABLED' ? '恢复' : '停止',
      tone: next === 'ENABLED' ? 'primary' : 'danger',
      onConfirm: async () => {
        try {
          const res: any = await apiFetch(`/api/products/${p.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: next }),
          })
          if (res?.statusChange === 'PENDING_APPROVAL') {
            alert(`✓ 停售申请已提交总厨审批 (单号 ${res.documentNo})`)
          }
          load()
        } catch (e: any) { alert(e.message || '操作失败'); throw e }
      },
    })
  }

  // 按 category 分组
  const byCat: Record<string, Product[]> = {}
  ;(products || []).forEach(p => { (byCat[p.category] = byCat[p.category] || []).push(p) })

  function openCreate() {
    setNewSku(EMPTY_SKU)
    setCreateErr(null)
    setCreateOpen(true)
  }
  function clearAll() {
    if (!products || products.length === 0) { alert('已经是空的'); return }
    openConfirm({
      title: `⚠ 危险操作: 清除全部 ${products.length} 个 SKU?`,
      body: `将永久删除你名下所有商品 + 库存流水 + 上传批次记录, 不可恢复.\n如果有商品被订单引用, 系统会拒绝并提示.\n\n仅在: 测试环境清理 / 重新规划 SKU 时使用.`,
      confirmLabel: '我确认, 全部清除',
      tone: 'danger',
      onConfirm: async () => {
        try {
          const res: any = await apiFetch('/api/products/clear-all', {
            method: 'DELETE',
            body: JSON.stringify({ confirm: 'CLEAR_ALL' }),
          })
          alert(`✓ 已清除 ${res.deletedProducts} 商品 / ${res.deletedMovements} 流水 / ${res.deletedBatches} 批次`)
          load()
        } catch (e: any) { alert(e.message || '清除失败'); throw e }
      },
    })
  }

  async function submitNew() {
    if (submitting) return
    // 必填: 名称 + 单价 (跟报价模板一致). code 留空后端自动生成, category 默认"其他"
    if (!newSku.name.trim() || !newSku.price) {
      setCreateErr('品项名称 + 金额 必填'); return
    }
    setCreateErr(null); setSubmitting(true)
    try {
      const body: any = {
        name: newSku.name.trim(),
        unit: newSku.unit.trim() || '件',
        price: Number(newSku.price),
        stock: Number(newSku.stock) || 0,
        minStock: Number(newSku.minStock) || 0,
        shelfDays: Number(newSku.shelfDays) || 7,
        minOrderQty: Number(newSku.minOrderQty) || 1,
        stepQty: Number(newSku.stepQty) || 1,
      }
      if (newSku.code.trim()) body.code = newSku.code.trim()
      if (newSku.spec.trim()) body.spec = newSku.spec.trim()
      if (newSku.category.trim()) body.category = newSku.category.trim()
      await apiFetch('/api/products', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setCreateOpen(false)
      alert('✓ 新建 SKU 已提交总厨审批, 通过后才会上架显示给餐厅')
      load()
    } catch (e: any) {
      setCreateErr(e.message || '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">商品报价表</h1>
          <p className="text-caption text-gray3">
            {products ? `${products.length} SKU · ${Object.keys(byCat).length} 类` : '加载中…'}
          </p>
        </div>
        <div className="flex gap-2">
          {products && products.length > 0 && (
            <button
              onClick={clearAll}
              className="px-2 py-2 bg-white border border-red/30 rounded-cta text-caption text-red-fg"
              title="清除当前供应商所有 SKU (谨慎)"
            >🗑 全清</button>
          )}
          <a
            href="/v2/supplier/products/upload"
            className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2"
          >⤒ 批量上传</a>
          <button
            onClick={openCreate}
            className="px-3 py-2 bg-accent text-white rounded-cta text-button"
          >+ 新建 SKU</button>
        </div>
      </header>

      <p className="px-4 mt-1 text-micro text-gray3">点单价数字可改 (走总厨审批) · 库存请去「库存」页操作</p>

      {/* 上传历史 toggle */}
      {(batches?.length ?? 0) > 0 && (
        <div className="px-4 mt-3">
          <button
            onClick={() => setHistoryOpen(v => !v)}
            className="w-full flex items-center justify-between bg-bg-card border border-border rounded-card p-3"
          >
            <span className="text-button">📋 上传历史 <span className="text-caption text-gray3">({batches!.length})</span></span>
            <span className="text-gray3">{historyOpen ? '▾' : '▸'}</span>
          </button>
          {historyOpen && (
            <ul className="mt-2 space-y-2">
              {batches!.map(b => {
                const revoked = !!b.revokedAt
                return (
                  <li key={b.id} className={`bg-bg-card border border-border rounded-card p-3 ${revoked ? 'opacity-60' : ''}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-caption text-gray2 truncate flex-1">{b.filename || '(未命名)'}</span>
                      <span className="text-micro text-gray3">{timeAgo(b.createdAt)}</span>
                      {revoked && <Chip tone="gray">已撤回</Chip>}
                    </div>
                    <div className="flex items-center gap-3 text-caption text-gray3">
                      <span>共 {b.totalRows} 行</span>
                      <span className="text-green-fg">✓ {b.createdCount} 上架</span>
                      {b.failedCount > 0 && <span className="text-red-fg">✗ {b.failedCount} 失败</span>}
                      <span className="ml-auto">现存 {b._count?.products ?? '?'} SKU</span>
                    </div>
                    {!revoked && (b._count?.products ?? 0) > 0 && (
                      <button
                        onClick={() => revokeBatch(b)}
                        className="mt-2 text-caption text-red-fg"
                      >↶ 撤回这次上传</button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {error && <div className="px-4 mt-3"><FriendlyError message={error} /></div>}
      {!products && !error && (
        <div className="px-4 mt-3 space-y-2">{[1,2,3].map(i => <SkeletonCard key={i} />)}</div>
      )}
      {products && products.length === 0 && (
        <div className="px-4 mt-4">
          <EmptyState icon="📋" title="还没有上架商品" hint="联系平台运营开通商品" />
        </div>
      )}

      {products && Object.entries(byCat).map(([cat, items]) => (
        <section key={cat} className="px-4 mt-4">
          <h2 className="text-h2 mb-2">{cat}<span className="text-caption text-gray3 ml-2">({items.length})</span></h2>
          <ul className="bg-bg-card rounded-card border border-border divide-y divide-border">
            {items.map(p => {
              const isEdit = editing === p.id
              return (
                <li key={p.id} className="px-3 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-h2 truncate flex-1">{p.name}</span>
                    {p.status === 'DISABLED' && <Chip tone="gray">已停售</Chip>}
                    {p.status === 'PENDING_APPROVAL' && <Chip tone="orange">待审核</Chip>}
                    {p.status === 'PENDING_DISABLE' && <Chip tone="orange">停售待审</Chip>}
                    <span className="text-micro text-gray3 font-num">#{p.code}</span>
                  </div>
                  {isEdit ? (
                    <div className="flex items-center gap-2 mt-2">
                      <label className="text-micro text-gray3">单价</label>
                      <span className="text-gray3">¥</span>
                      <input
                        type="number" step="0.01" min="0"
                        value={draft.price}
                        onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                        className="flex-1 bg-bg rounded-chip px-2 py-1 font-num"
                      />
                      <span className="text-micro text-gray3">/ {p.unit}</span>
                      <button onClick={() => save(p)} disabled={submitting}
                              className="px-3 py-1 bg-accent text-white rounded-cta text-button">保存</button>
                      <button onClick={cancelEdit} className="text-gray3 px-2">×</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 text-caption mt-1">
                      <button onClick={() => startEdit(p)} className="text-gray2">
                        单价 <span className="font-num text-ink">¥{Number(p.price).toFixed(2)}</span> / {p.unit}
                      </button>
                      {p.status === 'ENABLED' && (
                        <button onClick={() => toggleStatus(p)} className="ml-auto text-caption text-accent">停售</button>
                      )}
                      {p.status === 'DISABLED' && (
                        <button onClick={() => toggleStatus(p)} className="ml-auto text-caption text-accent">恢复</button>
                      )}
                      {(p.status === 'PENDING_APPROVAL' || p.status === 'PENDING_DISABLE') && (
                        <span className="ml-auto text-caption text-amber-fg">总厨审批中…</span>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      <BottomNav
        tabs={[
          { key: 'home',    label: '首页', icon: '⌂' },
          { key: 'orders',  label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me',      label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')    location.href = '/v2/supplier/home'
          if (k === 'orders')  location.href = '/v2/supplier/orders'
          if (k === 'inventory') location.href = '/v2/supplier/inventory'
          if (k === 'billing') location.href = '/v2/supplier/billing'
        }}
      />
      <ConfirmSheet {...confirmState} />

      {/* 新建 SKU sheet */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40" onClick={() => setCreateOpen(false)}>
          <div className="bg-bg-card w-full max-w-md rounded-t-2xl p-5 max-h-[90vh] overflow-y-auto"
               style={{ paddingBottom: 'calc(28px + env(safe-area-inset-bottom))' }}
               onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-4" />
            <h3 className="text-h2 text-ink">新建 SKU</h3>
            <p className="text-micro text-gray3 mt-1">上架后餐厅下单时可见, 价格 / 库存随时可改</p>

            <div className="grid grid-cols-2 gap-3 mt-4">
              {/* —— 报价模板必填的 4 项 —— */}
              <Field label="品项名称 *">
                <input value={newSku.name} onChange={e => setNewSku({...newSku, name: e.target.value})}
                       placeholder="例: 见手青啤酒" className={INPUT_CLS} />
              </Field>
              <Field label="规格型号">
                <input value={newSku.spec} onChange={e => setNewSku({...newSku, spec: e.target.value})}
                       placeholder="例: 24瓶*330ml/件" className={INPUT_CLS} />
              </Field>
              <Field label="采购单位">
                <input value={newSku.unit} onChange={e => setNewSku({...newSku, unit: e.target.value})}
                       placeholder="件 / 箱 / kg" className={INPUT_CLS} />
              </Field>
              <Field label="金额 (¥) *">
                <input type="number" step="0.01" min="0" value={newSku.price}
                       onChange={e => setNewSku({...newSku, price: e.target.value})}
                       placeholder="0.00" className={INPUT_CLS} />
              </Field>

              {/* —— 选填扩展 —— */}
              <Field label="编码 (留空自动生成)">
                <input value={newSku.code} onChange={e => setNewSku({...newSku, code: e.target.value})}
                       placeholder="例: SH001" className={INPUT_CLS} />
              </Field>
              <Field label="类目 (默认其他)">
                <input value={newSku.category} onChange={e => setNewSku({...newSku, category: e.target.value})}
                       placeholder="例: 酒水 / 水产" className={INPUT_CLS} />
              </Field>
              <Field label="保质期 (天)">
                <input type="number" min="0" value={newSku.shelfDays}
                       onChange={e => setNewSku({...newSku, shelfDays: e.target.value})}
                       className={INPUT_CLS} />
              </Field>
              <Field label="初始库存">
                <input type="number" step="0.01" min="0" value={newSku.stock}
                       onChange={e => setNewSku({...newSku, stock: e.target.value})}
                       className={INPUT_CLS} />
              </Field>
              <Field label="安全库存">
                <input type="number" step="0.01" min="0" value={newSku.minStock}
                       onChange={e => setNewSku({...newSku, minStock: e.target.value})}
                       className={INPUT_CLS} />
              </Field>
              <Field label="起订量 (默认1)">
                <input type="number" step="0.01" min="0.01" value={newSku.minOrderQty}
                       onChange={e => setNewSku({...newSku, minOrderQty: e.target.value})}
                       placeholder="1" className={INPUT_CLS} />
              </Field>
              <Field label="订量步长 (默认1)">
                <input type="number" step="0.01" min="0.01" value={newSku.stepQty}
                       onChange={e => setNewSku({...newSku, stepQty: e.target.value})}
                       placeholder="如 10 = 必须 10/20/30..." className={INPUT_CLS} />
              </Field>
            </div>

            {createErr && (
              <p className="text-caption text-red-fg mt-3 bg-red-bg rounded-cta p-2">{createErr}</p>
            )}

            <div className="grid grid-cols-2 gap-2 mt-5">
              <button onClick={() => setCreateOpen(false)} disabled={submitting}
                      className="py-3 rounded-cta text-button bg-white border border-border text-gray2 disabled:opacity-50">取消</button>
              <button onClick={submitNew} disabled={submitting}
                      className="py-3 rounded-cta text-button bg-accent text-white disabled:opacity-50">
                {submitting ? '上架中…' : '上架'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const INPUT_CLS = 'w-full bg-bg border border-border rounded-cta px-2 py-2 text-body text-ink placeholder:text-gray3 focus:outline-none focus:border-accent focus:bg-white'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-micro text-gray3 block mb-1">{label}</label>
      {children}
    </div>
  )
}
