/** 总厨 · 日报缺失 BOM 待办与历史消耗回补。 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

type Dish = { id: string; name: string; category?: string | null }
type Recipe = { id: string; variantKey: string; quantity: string; unit: string; product: { name: string; unit: string } }
type BomTask = {
  id: string
  businessDate: string
  rawDishName: string
  spec: string
  variantKey: string
  reasonCode: 'DISH_UNMATCHED' | 'BOM_MISSING' | 'INVENTORY_UNIT_PENDING'
  quantity: number
  grossAmount: number
  netIncome: number
  recipeReady: boolean
  unitIssues: Array<{ productId: string; productName: string; sourceUnit: string; inventoryUnit: string }>
  status: 'PENDING' | 'BACKFILLED' | 'SUPERSEDED'
  store: { id: string; name: string; no: string }
  dish: { id: string; name: string; recipes: Recipe[] } | null
}
type Coverage = {
  days: number
  salesQuantityCoverage: number
  salesRevenueCoverage: number
  pendingTaskCount: number
  activeDishCount: number
  masterReadyCount: number
  masterCoverage: number
  uncoveredRevenue: number
}

const shortDate = (value: string) => String(value || '').slice(0, 10)

export default function ChefDirectorBomPage() {
  const [tasks, setTasks] = useState<BomTask[] | null>(null)
  const [dishes, setDishes] = useState<Dish[]>([])
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    try {
      const [pending, allDishes, nextCoverage] = await Promise.all([
        apiFetch<BomTask[]>('/api/daily-business-imports/bom-tasks?status=PENDING'),
        apiFetch<Dish[]>('/api/dishes'),
        apiFetch<Coverage>('/api/dishes/bom-coverage?days=30'),
      ])
      setTasks([...pending].sort((left, right) => right.netIncome - left.netIncome || right.quantity - left.quantity))
      setDishes(allDishes)
      setCoverage(nextCoverage)
      setError(null)
    } catch (reason: any) {
      setError(reason.message || 'BOM 待办加载失败')
    }
  }

  useEffect(() => { reload() }, [])

  const readyCount = useMemo(() => tasks?.filter(task => task.recipeReady).length || 0, [tasks])

  async function linkDish(task: BomTask) {
    const dishId = selected[task.id]
    if (!dishId) return
    setBusyId(task.id)
    try {
      await apiFetch(`/api/daily-business-imports/bom-tasks/${task.id}/dish`, {
        method: 'PUT', body: JSON.stringify({ dishId }),
      })
      await reload()
    } catch (reason: any) { setError(reason.message || '关联失败') }
    finally { setBusyId(null) }
  }

  async function backfill(task: BomTask) {
    if (!window.confirm(`确认按当前 BOM 回补 ${shortDate(task.businessDate)} 的库存消耗？\n${task.rawDishName}${task.spec ? `（${task.spec}）` : ''} · ${task.quantity} 份\n\n该操作有幂等保护，不会重复扣减。`)) return
    setBusyId(task.id)
    try {
      await apiFetch(`/api/daily-business-imports/bom-tasks/${task.id}/backfill`, { method: 'POST' })
      await reload()
    } catch (reason: any) { setError(reason.message || '回补失败') }
    finally { setBusyId(null) }
  }

  function recipeUrl(task: BomTask) {
    const query = new URLSearchParams()
    if (task.variantKey) query.set('variant', task.variantKey)
    if (task.spec) query.set('spec', task.spec)
    query.set('task', task.id)
    query.set('effectiveFrom', shortDate(task.businessDate))
    query.set('changeType', 'HISTORICAL_CORRECTION')
    return `/v2/chef-director/dishes/${task.dish!.id}?${query.toString()}`
  }

  return (
    <div className="min-h-screen bg-bg pb-16">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">菜品 BOM 待办</h1>
          <p className="text-caption text-gray3">补齐日报缺失配方，并回补对应营业日库存消耗</p>
        </div>
      </header>

      <div className="mx-4 mt-3 grid grid-cols-2 gap-2">
        <div className="bg-white rounded-card border border-border p-3">
          <div className="text-micro text-gray3">近30天销量覆盖</div>
          <div className="text-h1 font-num mt-1">{coverage ? `${(coverage.salesQuantityCoverage * 100).toFixed(1)}%` : '—'}</div>
        </div>
        <div className="bg-green-bg rounded-card border border-green-fg/20 p-3">
          <div className="text-micro text-green-fg">近30天收入覆盖</div>
          <div className="text-h1 font-num text-green-fg mt-1">{coverage ? `${(coverage.salesRevenueCoverage * 100).toFixed(1)}%` : '—'}</div>
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <div className="text-micro text-gray3">待处理 / 已就绪</div>
          <div className="text-h2 font-num mt-1">{tasks?.length ?? '—'} / {readyCount} 项</div>
        </div>
        <div className="bg-orange-bg rounded-card border border-orange-fg/20 p-3">
          <div className="text-micro text-orange-fg">未覆盖营业收入</div>
          <div className="text-h2 font-num text-orange-fg mt-1">¥{coverage ? coverage.uncoveredRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</div>
        </div>
      </div>

      <div className="mx-4 mt-3 bg-amber/10 border border-amber/30 rounded-card p-3 text-caption text-amber-fg">
        流程：关联菜品 → 补齐对应规格 BOM 与原材料单位 → 返回本页核对 → 完成并回补。回补使用独立审计来源，同一待办只会扣减一次。
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      <section className="px-4 mt-4 space-y-3">
        {tasks === null && <div className="bg-white rounded-card border border-border p-6 text-center text-caption text-gray3">加载中…</div>}
        {tasks?.length === 0 && <div className="bg-green-bg rounded-card border border-green-fg/20 p-6 text-center text-green-fg">✓ 当前没有待处理 BOM</div>}
        {tasks?.map(task => (
          <article key={task.id} className="bg-white rounded-card border border-border overflow-hidden">
            <div className="p-3">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-h2">{task.rawDishName}{task.spec && <span className="text-gray2">（{task.spec}）</span>}</div>
                  <div className="text-micro text-gray3 mt-1">{task.store.name} · {shortDate(task.businessDate)} · 销售 {task.quantity} 份</div>
                </div>
                <span className={`text-micro px-2 py-1 rounded-chip ${task.recipeReady ? 'bg-green-bg text-green-fg' : 'bg-orange-bg text-orange-fg'}`}>
                  {task.recipeReady ? '可回补' : task.unitIssues?.length ? '待补单位' : task.dish ? '待补配方' : '待关联菜品'}
                </span>
              </div>

              {!task.dish ? (
                <div className="mt-3">
                  <div className="text-caption text-red-fg mb-2">收银菜品尚未关联系统菜品</div>
                  <div className="flex gap-2">
                    <select
                      value={selected[task.id] || ''}
                      onChange={event => setSelected(current => ({ ...current, [task.id]: event.target.value }))}
                      className="min-w-0 flex-1 bg-bg rounded-cta px-3 py-2 text-caption"
                    >
                      <option value="">选择已有菜品…</option>
                      {dishes.map(dish => <option key={dish.id} value={dish.id}>{dish.name}{dish.category ? ` · ${dish.category}` : ''}</option>)}
                    </select>
                    <button onClick={() => linkDish(task)} disabled={!selected[task.id] || busyId === task.id} className="px-3 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-35">关联</button>
                  </div>
                  <a href={`/v2/chef-director/dishes/new?${new URLSearchParams({
                    name: task.rawDishName,
                    fromBomTask: task.id,
                    variant: task.variantKey,
                    spec: task.spec,
                    effectiveFrom: shortDate(task.businessDate),
                    changeType: 'HISTORICAL_CORRECTION',
                  }).toString()}`} className="inline-block mt-2 text-caption text-amber-fg">没有对应菜品？新建菜品 ›</a>
                </div>
              ) : (
                <div className="mt-3 bg-bg rounded-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-caption">已关联：{task.dish.name}</div>
                      <div className="text-micro text-gray3 mt-0.5">{task.spec ? `需要“${task.spec}”规格或默认配方` : '需要默认配方'}</div>
                    </div>
                    <a href={recipeUrl(task)} className="whitespace-nowrap px-3 py-2 bg-white border border-border rounded-cta text-button">维护 BOM</a>
                  </div>
                  {task.unitIssues?.length > 0 && (
                    <div className="mt-2 text-micro text-red-fg">
                      原材料单位待核验：{task.unitIssues.map(item => `${item.productName}（${item.sourceUnit} → ${item.inventoryUnit}）`).join('、')}
                    </div>
                  )}
                </div>
              )}
            </div>

            {task.dish && (
              <div className="border-t border-border p-3">
                <button
                  onClick={() => backfill(task)}
                  disabled={!task.recipeReady || busyId === task.id}
                  className="w-full py-3 rounded-cta bg-amber text-white text-button disabled:opacity-35"
                >{busyId === task.id ? '处理中…' : task.recipeReady ? '完成并回补历史库存消耗' : task.unitIssues?.length ? '请先补齐原材料单位' : '请先补齐 BOM'}</button>
              </div>
            )}
          </article>
        ))}
      </section>
    </div>
  )
}
