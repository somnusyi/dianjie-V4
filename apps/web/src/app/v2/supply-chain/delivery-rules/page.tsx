/**
 * 供应链 · 配送班表
 * 门店订货→到货节奏自助维护：线路（名称/供货机构）+ 送货日规则 + 到货期 + 订货时段
 * + 适用门店 + 生效区间 + 强制开关，附月历视图看每天发哪条线。
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { deliveryScheduleText, isDeliveryScheduleDate, nextDeliveryScheduleDates } from '@/lib/delivery-rule-cycle'
import dayjs from 'dayjs'

type Store = { id: string; no: string; name: string }
type Supplier = { id: string; name: string }
type Rule = {
  id: string; no: string; name: string
  supplierId: string | null
  supplier?: Supplier | null
  deliveryScheduleMode: 'WEEKLY' | 'INTERVAL'
  weekdays: number[]; leadDays: number
  deliveryIntervalDays: number | null; deliveryIntervalStart: string | null
  orderWindowStart: string | null; orderWindowEnd: string | null
  enforce: boolean
  effectiveFrom: string | null; effectiveTo: string | null
  status: 'ENABLED' | 'DISABLED'
  note: string | null
  stores: { storeId: string; store: Store }[]
}

const WEEKDAYS = [
  { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' },
  { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' }, { value: 7, label: '日' },
]

function weekdayText(weekdays: number[]) {
  return weekdays.map(day => `周${WEEKDAYS.find(item => item.value === day)?.label}`).join('、')
}

function dateText(value: string | null) {
  return value ? dayjs(value).format('YYYY/M/D') : '不限'
}

type Form = {
  name: string; supplierId: string; deliveryScheduleMode: 'WEEKLY' | 'INTERVAL'; weekdays: number[]; leadDays: string
  deliveryIntervalDays: string; deliveryIntervalStart: string
  orderWindowStart: string; orderWindowEnd: string; enforce: boolean
  effectiveFrom: string; effectiveTo: string; note: string; storeIds: string[]
}

const emptyForm: Form = {
  name: '', supplierId: '', deliveryScheduleMode: 'INTERVAL', weekdays: [], leadDays: '1',
  deliveryIntervalDays: '1', deliveryIntervalStart: dayjs().format('YYYY-MM-DD'),
  orderWindowStart: '', orderWindowEnd: '', enforce: false,
  effectiveFrom: '', effectiveTo: '', note: '', storeIds: [],
}

export default function DeliveryRulesPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [form, setForm] = useState<Form>(emptyForm)
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [calendarMonth, setCalendarMonth] = useState(() => dayjs().format('YYYY-MM'))

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [ruleRows, storeRows, supplierRows] = await Promise.all([
        apiFetch<Rule[]>('/api/delivery-rules'),
        apiFetch<Store[]>('/api/stores'),
        apiFetch<Supplier[]>('/api/suppliers'),
      ])
      setRules(ruleRows || [])
      setStores(storeRows || [])
      setSuppliers(supplierRows || [])
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setFormError('')
    setFormOpen(true)
  }

  function openEdit(rule: Rule) {
    setEditing(rule)
    setForm({
      name: rule.name,
      supplierId: rule.supplierId || '',
      deliveryScheduleMode: rule.deliveryScheduleMode || 'WEEKLY',
      weekdays: rule.weekdays,
      leadDays: String(rule.leadDays),
      deliveryIntervalDays: rule.deliveryIntervalDays == null ? '' : String(rule.deliveryIntervalDays),
      deliveryIntervalStart: rule.deliveryIntervalStart ? dayjs(rule.deliveryIntervalStart).format('YYYY-MM-DD') : '',
      orderWindowStart: rule.orderWindowStart || '',
      orderWindowEnd: rule.orderWindowEnd || '',
      enforce: rule.enforce,
      effectiveFrom: rule.effectiveFrom ? dayjs(rule.effectiveFrom).format('YYYY-MM-DD') : '',
      effectiveTo: rule.effectiveTo ? dayjs(rule.effectiveTo).format('YYYY-MM-DD') : '',
      note: rule.note || '',
      storeIds: rule.stores.map(item => item.storeId),
    })
    setFormError('')
    setFormOpen(true)
  }

  function toggleWeekday(day: number) {
    setForm(current => ({
      ...current,
      weekdays: current.weekdays.includes(day)
        ? current.weekdays.filter(item => item !== day)
        : [...current.weekdays, day].sort((a, b) => a - b),
    }))
  }

  function toggleStore(storeId: string) {
    setForm(current => ({
      ...current,
      storeIds: current.storeIds.includes(storeId)
        ? current.storeIds.filter(item => item !== storeId)
        : [...current.storeIds, storeId],
    }))
  }

  async function submitForm() {
    if (!form.name.trim()) { setFormError('请填写班表名称'); return }
    if (form.deliveryScheduleMode === 'WEEKLY' && form.weekdays.length === 0) { setFormError('请至少选择一个星期'); return }
    const deliveryIntervalDays = form.deliveryScheduleMode === 'INTERVAL' ? Number(form.deliveryIntervalDays) : null
    if (deliveryIntervalDays != null && (!Number.isInteger(deliveryIntervalDays) || deliveryIntervalDays < 1 || deliveryIntervalDays > 6)) {
      setFormError('送货间隔必须在 1～6 天之间'); return
    }
    if (form.deliveryScheduleMode === 'INTERVAL' && !form.deliveryIntervalStart) { setFormError('请选择开始计算日期'); return }
    if (form.storeIds.length === 0) { setFormError('请至少选择一家适用门店'); return }
    if ((form.orderWindowStart && !form.orderWindowEnd) || (!form.orderWindowStart && form.orderWindowEnd)) {
      setFormError('订货时段起止要同时填写或同时留空'); return
    }
    setFormError('')
    setSubmitting(true)
    const body = {
      name: form.name.trim(),
      supplierId: form.supplierId || null,
      deliveryScheduleMode: form.deliveryScheduleMode,
      weekdays: form.deliveryScheduleMode === 'WEEKLY' ? form.weekdays : [],
      leadDays: Number(form.leadDays) || 1,
      deliveryIntervalDays,
      deliveryIntervalStart: form.deliveryScheduleMode === 'INTERVAL' ? form.deliveryIntervalStart : null,
      orderWindowStart: form.orderWindowStart || null,
      orderWindowEnd: form.orderWindowEnd || null,
      enforce: form.enforce,
      effectiveFrom: form.effectiveFrom || null,
      effectiveTo: form.effectiveTo || null,
      note: form.note.trim() || null,
      storeIds: form.storeIds,
    }
    try {
      if (editing) {
        await apiFetch(`/api/delivery-rules/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        setNotice(`班表「${form.name}」已更新`)
      } else {
        await apiFetch('/api/delivery-rules', { method: 'POST', body: JSON.stringify(body) })
        setNotice(`班表「${form.name}」已创建`)
      }
      setFormOpen(false)
      load()
    } catch (reason: any) {
      setFormError(String(reason?.message || reason))
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleStatus(rule: Rule) {
    const next = rule.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'
    if (next === 'DISABLED' && !window.confirm(`确认停用「${rule.name}」？停用后门店下单不再受该班表约束。`)) return
    try {
      await apiFetch(`/api/delivery-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) })
      setNotice(`班表「${rule.name}」已${next === 'ENABLED' ? '启用' : '停用'}`)
      load()
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    }
  }

  // 月历：两种规则都统一计算为送货日。
  const calendar = useMemo(() => {
    const monthStart = dayjs(`${calendarMonth}-01`)
    const daysInMonth = monthStart.daysInMonth()
    const firstWeekday = (monthStart.day() + 6) % 7 // 周一开头
    const cells: { key: string; day: number; deliveryRules: Rule[] }[] = []
    for (let i = 0; i < firstWeekday; i += 1) cells.push({ key: `blank-${i}`, day: 0, deliveryRules: [] })
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = monthStart.date(day).format('YYYY-MM-DD')
      const dayRules = rules.filter(rule => rule.status === 'ENABLED'
        && isDeliveryScheduleDate(rule, key)
        && (!rule.effectiveFrom || key >= dayjs(rule.effectiveFrom).format('YYYY-MM-DD'))
        && (!rule.effectiveTo || key <= dayjs(rule.effectiveTo).format('YYYY-MM-DD')))
      cells.push({ key, day, deliveryRules: dayRules })
    }
    return cells
  }, [rules, calendarMonth])

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-h1">配送班表</h1>
          <p className="mt-1 text-micro text-gray3">送货日可选择“按间隔”或“按每周”设置，到货期与适用门店统一按班表执行。</p>
        </div>
        <button onClick={openCreate} className="h-11 rounded-cta bg-accent px-5 text-button text-white">+ 新建班表</button>
      </div>

      {error && <div className="mt-3 rounded-card bg-red-bg px-4 py-2 text-caption text-red-fg">{error}</div>}
      {notice && <div className="mt-3 rounded-card bg-green-bg px-4 py-2 text-caption text-green-fg">{notice}</div>}

      <div className="mt-4 overflow-hidden rounded-card border border-border bg-white">
        <table className="w-full min-w-[980px] text-left text-caption">
          <thead className="bg-bg text-gray3"><tr>
            <th className="px-4 py-3">班表</th><th className="px-4 py-3">供货机构</th><th className="px-4 py-3">送货规则</th>
            <th className="px-4 py-3">到货期</th><th className="px-4 py-3">订货时段</th><th className="px-4 py-3">适用门店</th>
            <th className="px-4 py-3">生效区间</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">操作</th>
          </tr></thead>
          <tbody className="divide-y divide-border">
            {rules.map(rule => <tr key={rule.id} className={rule.status === 'DISABLED' ? 'opacity-50' : ''}>
              <td className="px-4 py-3"><b>{rule.name}</b><div className="text-micro text-gray3">{rule.no}{rule.enforce && <span className="ml-1 rounded bg-red-bg px-1 text-red-fg">强制</span>}</div></td>
              <td className="px-4 py-3">{rule.supplier?.name || '内部供应链总仓'}</td>
              <td className="px-4 py-3"><b>{deliveryScheduleText(rule)}</b>{rule.deliveryIntervalStart && <div className="text-micro text-gray3">从 {dateText(rule.deliveryIntervalStart)} 起算</div>}</td>
              <td className="px-4 py-3">第 {rule.leadDays} 个送货日</td>
              <td className="px-4 py-3">{rule.orderWindowStart ? `${rule.orderWindowStart}~${rule.orderWindowEnd}` : '全天'}</td>
              <td className="px-4 py-3"><b>{rule.stores.length} 家</b><div className="max-w-52 truncate text-micro text-gray3">{rule.stores.map(item => item.store.name).join('、')}</div></td>
              <td className="px-4 py-3 text-micro">{dateText(rule.effectiveFrom)} ~ {dateText(rule.effectiveTo)}</td>
              <td className="px-4 py-3">{rule.status === 'ENABLED' ? <span className="text-green-fg">启用中</span> : <span className="text-gray3">已停用</span>}</td>
              <td className="px-4 py-3">
                <button onClick={() => openEdit(rule)} className="mr-3 text-button text-accent underline">编辑</button>
                <button onClick={() => toggleStatus(rule)} className="text-button text-gray2 underline">{rule.status === 'ENABLED' ? '停用' : '启用'}</button>
              </td>
            </tr>)}
          </tbody>
        </table>
        {!loading && rules.length === 0 && <div className="py-12 text-center text-caption text-gray3">还没有配送班表，点右上角「新建班表」创建第一条线路</div>}
      </div>

      <div className="mt-4 rounded-card border border-border bg-white p-4">
        <div className="flex items-center justify-between">
          <div><h2 className="text-h2">送货月历</h2><p className="mt-0.5 text-micro text-gray3">按当前班表规则显示送货日期</p></div>
          <input type="month" value={calendarMonth} onChange={event => setCalendarMonth(event.target.value)} className="h-10 rounded-cta border border-border px-3" />
        </div>
        <div className="mt-3 grid grid-cols-7 gap-px overflow-hidden rounded-cta border border-border bg-border text-center text-micro">
          {WEEKDAYS.map(day => <div key={day.value} className="bg-bg py-2 text-gray3">周{day.label}</div>)}
          {calendar.map(cell => <div key={cell.key} className={`min-h-16 bg-white p-1.5 text-left ${cell.day === 0 ? 'invisible' : ''}`}>
            <div className="text-micro text-gray3">{cell.day || ''}</div>
            {cell.deliveryRules.map(rule => <div key={`delivery-${rule.id}`} className="mt-1 truncate rounded bg-orange-bg px-1.5 py-0.5 text-micro text-orange-fg" title={`${rule.name} · 送货日 · ${rule.stores.length} 家门店`}>{rule.name} · 送货</div>)}
          </div>)}
        </div>
      </div>

      {formOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setFormOpen(false)}>
        <div className="max-h-[92vh] w-full max-w-2xl overflow-auto rounded-card bg-white p-5 shadow-xl" onClick={event => event.stopPropagation()}>
          <div className="flex items-start justify-between">
            <h2 className="text-h2">{editing ? `编辑班表 · ${editing.no}` : '新建配送班表'}</h2>
            <button onClick={() => setFormOpen(false)} className="px-2 text-h2 text-gray3">×</button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label><span className="mb-1 block text-micro text-gray3">班表名称 *</span><input value={form.name} maxLength={80} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="如：南京线 / 合肥线" className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">供货机构</span>
              <select value={form.supplierId} onChange={event => setForm({ ...form, supplierId: event.target.value })} className="h-11 w-full rounded-cta border border-border bg-white px-3">
                <option value="">内部供应链总仓</option>
                {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </label>
          </div>

          <div className="mt-3 rounded-card border border-border p-3">
            <div className="grid grid-cols-2 gap-1 rounded-cta bg-bg p-1">
              <button type="button" onClick={() => setForm(current => ({ ...current, deliveryScheduleMode: 'INTERVAL', weekdays: [], deliveryIntervalDays: current.deliveryIntervalDays || '1', deliveryIntervalStart: current.deliveryIntervalStart || dayjs().format('YYYY-MM-DD') }))} className={`h-11 rounded-cta text-button ${form.deliveryScheduleMode === 'INTERVAL' ? 'bg-white text-ink shadow-sm' : 'text-gray2'}`}>按间隔送货</button>
              <button type="button" onClick={() => setForm(current => ({ ...current, deliveryScheduleMode: 'WEEKLY', deliveryIntervalDays: '', deliveryIntervalStart: '' }))} className={`h-11 rounded-cta text-button ${form.deliveryScheduleMode === 'WEEKLY' ? 'bg-white text-ink shadow-sm' : 'text-gray2'}`}>按每周送货</button>
            </div>
            {form.deliveryScheduleMode === 'INTERVAL' ? <>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label><span className="mb-1 block text-micro text-gray3">每隔几天</span><select value={form.deliveryIntervalDays} onChange={event => setForm({ ...form, deliveryIntervalDays: event.target.value })} className="h-11 w-full rounded-cta border border-border bg-white px-3">{Array.from({ length: 6 }, (_, index) => index + 1).map(days => <option key={days} value={days}>每隔 {days} 天</option>)}</select></label>
                <label><span className="mb-1 block text-micro text-gray3">开始计算日期</span><input type="date" value={form.deliveryIntervalStart} onChange={event => setForm({ ...form, deliveryIntervalStart: event.target.value })} className="h-11 w-full rounded-cta border border-border px-3" /></label>
              </div>
              {form.deliveryIntervalDays && form.deliveryIntervalStart && <p className="mt-2 text-micro text-gray3">预计送货日：{nextDeliveryScheduleDates({ deliveryScheduleMode: 'INTERVAL', deliveryIntervalDays: Number(form.deliveryIntervalDays), deliveryIntervalStart: form.deliveryIntervalStart }, form.deliveryIntervalStart, 6).map(date => dayjs(date).format('M/D')).join('、')}</p>}
            </> : <div className="mt-3">
              <span className="mb-1 block text-micro text-gray3">每周送货日（可多选）</span>
              <div className="flex gap-2">{WEEKDAYS.map(day => <button key={day.value} type="button" onClick={() => toggleWeekday(day.value)} className={`h-10 flex-1 rounded-cta text-button ${form.weekdays.includes(day.value) ? 'bg-ink text-white' : 'bg-bg text-gray2'}`}>周{day.label}</button>)}</div>
            </div>}
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label><span className="mb-1 block text-micro text-gray3">到货期 *</span>
              <select value={form.leadDays} onChange={event => setForm({ ...form, leadDays: event.target.value })} className="h-11 w-full rounded-cta border border-border bg-white px-3">
                {[1, 2, 3, 4, 5, 6, 7].map(day => <option key={day} value={day}>下单后第 {day} 个送货日</option>)}
              </select>
            </label>
            <label><span className="mb-1 block text-micro text-gray3">订货开始（可空）</span><input type="time" value={form.orderWindowStart} onChange={event => setForm({ ...form, orderWindowStart: event.target.value })} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">订货结束（可空）</span><input type="time" value={form.orderWindowEnd} onChange={event => setForm({ ...form, orderWindowEnd: event.target.value })} className="h-11 w-full rounded-cta border border-border px-3" /></label>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label><span className="mb-1 block text-micro text-gray3">生效日期（可空）</span><input type="date" value={form.effectiveFrom} onChange={event => setForm({ ...form, effectiveFrom: event.target.value })} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">失效日期（可空）</span><input type="date" value={form.effectiveTo} onChange={event => setForm({ ...form, effectiveTo: event.target.value })} className="h-11 w-full rounded-cta border border-border px-3" /></label>
          </div>

          <div className="mt-3">
            <span className="mb-1 block text-micro text-gray3">适用门店 *（{form.storeIds.length} 家）</span>
            <div className="max-h-44 overflow-auto rounded-cta border border-border">
              {stores.map(store => <label key={store.id} className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-caption last:border-0 hover:bg-bg">
                <input type="checkbox" checked={form.storeIds.includes(store.id)} onChange={() => toggleStore(store.id)} />
                <b>{store.name}</b><span className="text-micro text-gray3">{store.no}</span>
              </label>)}
            </div>
          </div>

          <label className="mt-3 block"><span className="mb-1 block text-micro text-gray3">备注</span><input value={form.note} maxLength={240} onChange={event => setForm({ ...form, note: event.target.value })} className="h-11 w-full rounded-cta border border-border px-3" /></label>

          <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-card bg-bg px-3 py-3 text-caption">
            <input type="checkbox" checked={form.enforce} onChange={event => setForm({ ...form, enforce: event.target.checked })} />
            <span><b>强制管控</b>：开启后，不在订货时段下单，或到货日期不符合当前送货规则，将被直接拦截；关闭则只做提示和默认预填。</span>
          </label>

          {formError && <div className="mt-3 rounded-card bg-red-bg px-4 py-2 text-caption text-red-fg">{formError}</div>}
          <button onClick={submitForm} disabled={submitting} className="mt-4 h-11 w-full rounded-cta bg-accent text-button text-white disabled:opacity-40">{submitting ? '保存中…' : editing ? '保存修改' : '创建班表'}</button>
        </div>
      </div>}
    </div>
  )
}
