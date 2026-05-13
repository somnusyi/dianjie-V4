'use client'

import { useEffect, useMemo, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { Btn, Field, Input, Select, fmt, useToast } from '@/components/ui'
import api from '@/lib/api'
import dayjs from 'dayjs'

type FilterAlert = '' | 'low' | 'expiring'

export default function InventoryPage() {
  const [products, setProducts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filterAlert, setFilterAlert] = useState<FilterAlert>('')
  const [showConsume, setShowConsume] = useState(false)
  const [consumeItems, setConsumeItems] = useState([{ productId: '', quantity: '' }])
  const [consumeDate, setConsumeDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [consumeNote, setConsumeNote] = useState('')
  const { show, ToastEl } = useToast()

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    try {
      const r = await api.get('/api/inventory')
      setProducts(Array.isArray(r.data) ? r.data : [])
    } catch {
      show('库存数据读取失败', 'error')
    }
    setLoading(false)
  }

  const summary = useMemo(() => {
    const low = products.filter(p => p.isLowStock)
    const expiring = products.filter(p => p.isExpiringSoon || p.isExpired)
    const expired = products.filter(p => p.isExpired)
    const totalStockValue = products.reduce((sum, p) => sum + Math.max(0, Number(p.stock || 0)) * Math.max(0, Number(p.price || p.unitPrice || 0)), 0)
    return {
      lowCount: low.length,
      expiringCount: expiring.length,
      expiredCount: expired.length,
      totalStockValue,
      monthIn: products.reduce((sum, p) => sum + Math.max(0, Number(p.monthIn || 0)), 0),
      monthOut: products.reduce((sum, p) => sum + Math.max(0, Number(p.monthOut || 0)), 0),
    }
  }, [products])

  const filtered = products.filter(p => {
    if (filterAlert === 'low') return p.isLowStock
    if (filterAlert === 'expiring') return p.isExpiringSoon || p.isExpired
    return true
  })

  const riskItems = useMemo(() => {
    return [...products]
      .filter(p => p.isLowStock || p.isExpiringSoon || p.isExpired)
      .sort((a, b) => Number(b.isExpired) - Number(a.isExpired) || Number(b.isLowStock) - Number(a.isLowStock))
      .slice(0, 6)
  }, [products])

  const submitConsume = async () => {
    const valid = consumeItems.filter(i => i.productId && Number(i.quantity) > 0)
    if (!valid.length) return show('请填写消耗明细', 'error')
    try {
      await api.post('/api/inventory/consume', {
        items: valid.map(i => ({ productId: i.productId, quantity: Number(i.quantity) })),
        date: consumeDate,
        note: consumeNote,
      })
      show(`已录入 ${valid.length} 种食材消耗`)
      setShowConsume(false)
      setConsumeItems([{ productId: '', quantity: '' }])
      setConsumeNote('')
      load()
    } catch (e: any) {
      show(e.response?.data?.error || '录入失败', 'error')
    }
  }

  const getExpiryStyle = (p: any) => {
    if (p.isExpired) return { color: '#a32d2d', bg: '#fcebeb', text: '已过期' }
    if (p.isExpiringSoon) return { color: '#854f0b', bg: '#faeeda', text: `${p.daysToExpiry}天后到期` }
    if (p.nearestExpiry) return { color: '#888780', bg: '#f2f1eb', text: `${p.daysToExpiry}天后到期` }
    return null
  }

  const filters = [
    { v: '' as FilterAlert, l: '全部' },
    { v: 'low' as FilterAlert, l: '库存不足' },
    { v: 'expiring' as FilterAlert, l: '临期/过期' },
  ]

  return (
    <AppLayout>
      {ToastEl}
      <main className="dj-page">
        <div className="dj-topbar">
          <div>
            <span>库存管理 · 厨师长高频工作台</span>
            <h1>库存风控台</h1>
            <p>看清食材库存、安全线、临期风险，并快速录入今日消耗</p>
          </div>
          <Btn variant="primary" onClick={() => setShowConsume(true)}>录入今日消耗</Btn>
        </div>

        <section className="dj-hero inventory-hero">
          <div className="dj-hero-meta">
            <span>食材状态 <i /> 实时库存</span>
            <span>{dayjs().format('HH:mm')}</span>
          </div>
          <div className="dj-hero-main">
            <strong>{products.length} 种</strong>
            <em className={summary.lowCount || summary.expiringCount ? 'is-orange' : 'is-green'}>
              {summary.lowCount || summary.expiringCount ? '存在库存风险' : '库存健康'}
            </em>
          </div>
          <p>库存不足 {summary.lowCount} 种 · 临期/过期 {summary.expiringCount} 种 · 今日可在 APP 端快速盘点与消耗录入</p>
          <div className="inventory-bars">
            <span style={{ height: `${Math.max(16, Math.min(90, summary.monthIn * 3))}%` }} />
            <span style={{ height: `${Math.max(16, Math.min(90, summary.monthOut * 3))}%` }} />
            <span style={{ height: `${Math.max(16, Math.min(90, summary.lowCount * 18))}%` }} />
          </div>
          <div className="dj-hero-stats">
            <div><span>库存不足</span><strong className={summary.lowCount ? 'is-red' : ''}>{summary.lowCount} 种</strong></div>
            <div><span>临期风险</span><strong className={summary.expiringCount ? 'is-orange' : ''}>{summary.expiringCount} 种</strong></div>
            <div><span>已过期</span><strong className={summary.expiredCount ? 'is-red' : ''}>{summary.expiredCount} 种</strong></div>
          </div>
        </section>

        <section className="dj-metric-grid">
          <article>
            <span>食材总数</span>
            <strong>{products.length} 种</strong>
            <em>按商品 SKU 汇总</em>
          </article>
          <article className={summary.lowCount ? 'tone-red' : 'tone-green'}>
            <span>安全库存预警</span>
            <strong>{summary.lowCount} 种</strong>
            <em>需要补货或调拨</em>
          </article>
          <article className={summary.expiringCount ? 'tone-orange' : 'tone-green'}>
            <span>临期/过期</span>
            <strong>{summary.expiringCount} 种</strong>
            <em>优先消耗或报损</em>
          </article>
          <article>
            <span>本月消耗</span>
            <strong>{summary.monthOut.toFixed(1)}</strong>
            <em>用于厨师长复盘损耗</em>
          </article>
        </section>

        <section className="dj-dashboard-grid dj-section">
          <div>
            <div className="dj-section-title">
              <h2>库存清单</h2>
              <span>{loading ? '读取中' : `${filtered.length} 种食材`}</span>
            </div>
            <div className="finance-filter">
              {filters.map(f => (
                <button key={f.v} className={filterAlert === f.v ? 'active' : ''} onClick={() => setFilterAlert(f.v)}>{f.l}</button>
              ))}
            </div>
            <div className="dj-card inventory-list">
              {loading ? (
                <div className="dj-empty-row">正在读取库存...</div>
              ) : filtered.length === 0 ? (
                <div className="dj-empty-row">暂无食材</div>
              ) : filtered.map(p => {
                const expiryStyle = getExpiryStyle(p)
                const stockPct = Number(p.minStock) > 0 ? Number(p.stock) / Number(p.minStock) : 1
                return (
                  <article key={p.id} className={p.isExpired || p.isLowStock ? 'risk' : ''}>
                    <div>
                      <strong>{p.name}</strong>
                      <span>{p.category || '未分类'}</span>
                    </div>
                    <div className="inventory-stock">
                      <b className={p.isLowStock ? 'is-red' : ''}>{Number(p.stock || 0).toFixed(1)} {p.unit}</b>
                      <em>安全线 {Number(p.minStock || 0).toFixed(1)} {p.unit}</em>
                      <i><small style={{ width: `${Math.min(stockPct * 100, 100)}%` }} /></i>
                    </div>
                    <div className="inventory-flow">
                      <span className="is-green">+{Number(p.monthIn || 0).toFixed(1)}</span>
                      <span className="is-orange">-{Number(p.monthOut || 0).toFixed(1)}</span>
                    </div>
                    <div>
                      {expiryStyle ? (
                        <span className="dj-chip" style={{ background: expiryStyle.bg, color: expiryStyle.color }}>{expiryStyle.text}</span>
                      ) : p.nearestExpiry ? (
                        <span className="dj-muted">{dayjs(p.nearestExpiry).format('MM/DD')}</span>
                      ) : (
                        <span className="dj-muted">未记录</span>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          </div>

          <aside>
            <div className="dj-section-title">
              <h2>物料风险</h2>
              <span>厨师长优先处理</span>
            </div>
            <div className="dj-card inventory-risk-card">
              {riskItems.length === 0 ? (
                <div className="dj-empty-row">当前没有明显库存风险。</div>
              ) : riskItems.map(p => (
                <article key={p.id}>
                  <div>
                    <strong>{p.name}</strong>
                    <span>{p.isExpired ? '已过期' : p.isLowStock ? '库存不足' : '临期风险'}</span>
                  </div>
                  <b className={p.isExpired || p.isLowStock ? 'is-red' : 'is-orange'}>{Number(p.stock || 0).toFixed(1)} {p.unit}</b>
                </article>
              ))}
            </div>

            <div className="dj-section-title finance-side-title">
              <h2>APP 端动作</h2>
              <span>移动高频</span>
            </div>
            <div className="dj-card receipt-decision-card">
              <article>
                <strong>每日消耗录入</strong>
                <span>厨师长晚市后在手机端快速录入实际用量。</span>
              </article>
              <article>
                <strong>临期优先处理</strong>
                <span>手机端优先展示临期食材，减少损耗。</span>
              </article>
              <article>
                <strong>库存不足补货</strong>
                <span>后续可一键生成采购建议给店长确认。</span>
              </article>
            </div>
          </aside>
        </section>
      </main>

      {showConsume && (
        <div className="inventory-modal-backdrop" onClick={e => e.target === e.currentTarget && setShowConsume(false)}>
          <div className="inventory-modal">
            <div className="dj-section-title">
              <div>
                <h2>录入今日消耗</h2>
                <span>记录今日食材实际使用量，系统自动扣减库存</span>
              </div>
            </div>

            <Field label="消耗日期">
              <Input type="date" value={consumeDate} onChange={setConsumeDate} />
            </Field>

            <div className="inventory-consume-list">
              {consumeItems.map((item, idx) => (
                <div key={idx} className="inventory-consume-row">
                  <Select
                    value={item.productId}
                    onChange={v => {
                      const arr = [...consumeItems]
                      arr[idx].productId = v
                      setConsumeItems(arr)
                    }}
                    options={products.map(p => ({ value: p.id, label: `${p.name}（库存：${Number(p.stock).toFixed(1)}${p.unit}）` }))}
                    placeholder="选择食材"
                  />
                  <Input
                    type="number"
                    value={item.quantity}
                    onChange={v => {
                      const arr = [...consumeItems]
                      arr[idx].quantity = v
                      setConsumeItems(arr)
                    }}
                    placeholder="数量"
                  />
                  {idx > 0 && <Btn size="sm" variant="danger" onClick={() => setConsumeItems(consumeItems.filter((_, i) => i !== idx))}>删</Btn>}
                </div>
              ))}
            </div>

            <button className="inventory-add-line" onClick={() => setConsumeItems([...consumeItems, { productId: '', quantity: '' }])}>添加食材</button>

            <Field label="备注（可选）">
              <Input value={consumeNote} onChange={setConsumeNote} placeholder="如：晚市消耗" />
            </Field>

            <div className="finance-modal-actions">
              <Btn onClick={() => setShowConsume(false)}>取消</Btn>
              <Btn variant="primary" onClick={submitConsume}>确认录入</Btn>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  )
}
