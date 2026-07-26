/**
 * 内部供应链 · 供应商管理（桌面端）
 *
 * 服务供应链员工，替代面向老板/管理员的通用账号维护页。
 * 读取能力复用 GET /api/suppliers；状态启停用复用 PATCH /api/suppliers/:id/toggle。
 * 不展示银行账号、密钥等敏感字段；不实现外部小程序、上游采购、付款审批。
 */
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { EmptyState, FriendlyError, SkeletonList } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'
import {
  applySupplierFilters,
  DEFAULT_SUPPLY_SUPPLIER_FILTERS,
  formatCreditDays,
  formatSupplierStatusLabel,
  getSupplierDetailStats,
  hasActiveFilters,
  keepFiltersForPage,
  paginateSuppliers,
  resetPageFilters,
  supplierStatusTone,
  SUPPLY_SUPPLIER_STATUS_OPTIONS,
  type SupplySupplier,
  type SupplySupplierFilters,
} from '@/lib/supply-supplier-pc'

export default function InternalSupplyChainSuppliersPage() {
  const [allSuppliers, setAllSuppliers] = useState<SupplySupplier[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<SupplySupplierFilters>(DEFAULT_SUPPLY_SUPPLIER_FILTERS)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [confirmState, openConfirm] = useConfirmSheet()
  const abortRef = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)

  const filtered = useMemo(() => applySupplierFilters(allSuppliers ?? [], filters), [allSuppliers, filters])
  const paged = useMemo(() => paginateSuppliers(filtered, filters.page, filters.pageSize), [filtered, filters.page, filters.pageSize])
  const totalPages = Math.max(1, Math.ceil(filtered.length / filters.pageSize))
  const selected = useMemo(() => allSuppliers?.find(s => s.id === selectedId) || null, [allSuppliers, selectedId])

  function load() {
    const sequence = ++requestSequence.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    apiFetch<SupplySupplier[]>('/api/suppliers', { signal: controller.signal })
      .then(data => {
        if (sequence !== requestSequence.current) return
        const list = Array.isArray(data) ? data : []
        setAllSuppliers(list)
        if (selectedId && !list.some(s => s.id === selectedId)) {
          setSelectedId(null)
        }
      })
      .catch(reason => {
        if (sequence !== requestSequence.current) return
        if (reason?.name === 'AbortError') return
        setError(String(reason?.message || reason))
      })
      .finally(() => {
        if (sequence === requestSequence.current) setLoading(false)
      })
  }

  useEffect(() => {
    load()
    return () => { abortRef.current?.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function updateFilters(changes: Partial<SupplySupplierFilters>) {
    setFilters(current => resetPageFilters(current, changes))
  }

  function clearFilters() {
    setFilters({ ...DEFAULT_SUPPLY_SUPPLIER_FILTERS })
  }

  function toggleStatus(supplier: SupplySupplier) {
    const next = supplier.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'
    const isDisable = next === 'DISABLED'
    openConfirm({
      title: isDisable ? `停用供应商「${supplier.name}」？` : `启用供应商「${supplier.name}」？`,
      body: isDisable
        ? '停用后餐厅订货、商品关联等场景将不再显示该供应商。'
        : '启用后该供应商将重新出现在业务候选中。',
      confirmLabel: isDisable ? '确认停用' : '确认启用',
      tone: isDisable ? 'danger' : 'primary',
      onConfirm: async () => {
        setTogglingId(supplier.id)
        try {
          await apiFetch<{ status: string }>(`/api/suppliers/${supplier.id}/toggle`, { method: 'PATCH' })
          setNotice(`${supplier.name} 已${isDisable ? '停用' : '启用'}`)
          setAllSuppliers(prev =>
            prev
              ? prev.map(s => (s.id === supplier.id ? { ...s, status: next } : s))
              : prev,
          )
        } catch (reason: any) {
          setError(reason?.message || '操作失败')
        } finally {
          setTogglingId(null)
        }
      },
    })
  }

  const filterActive = hasActiveFilters(filters)

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="green">内部管理</Chip>
            <span className="text-caption text-gray3">供应商档案 · 账期与状态</span>
          </div>
          <h1 className="text-h1">供应商管理</h1>
          <p className="mt-1 text-caption text-gray2">
            {allSuppliers ? `${allSuppliers.length} 家供应商` : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/v2/supply-chain/home" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button text-gray2">← 返回工作台</a>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1440px] gap-5 lg:grid-cols-[1fr_360px]">
        <section>
          <div className="flex flex-wrap items-end gap-3 py-4">
            <FilterInput
              label="关键字"
              value={filters.q}
              onChange={value => updateFilters({ q: value })}
              placeholder="名称 / 编号"
            />
            <FilterSelect label="状态" value={filters.status} onChange={value => updateFilters({ status: value })}>
              <option value="">全部状态</option>
              {SUPPLY_SUPPLIER_STATUS_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </FilterSelect>
            <button
              onClick={clearFilters}
              disabled={!filterActive}
              className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2 disabled:opacity-40"
            >清空</button>
          </div>

          {notice && (
            <div className="mb-4 flex items-center justify-between rounded-card border border-green-fg/20 bg-green-bg px-4 py-3 text-caption text-green-fg">
              <span>{notice}</span>
              <button onClick={() => setNotice(null)} className="text-button">关闭</button>
            </div>
          )}

          {error && (
            <div className="mb-4">
              <FriendlyError message={error} onRetry={load} />
            </div>
          )}

          {loading && !allSuppliers && <SkeletonList count={5} />}

          {!loading && allSuppliers && filtered.length === 0 && (
            <EmptyState
              icon="🏭"
              title={filterActive ? '没有匹配的供应商' : '暂无供应商'}
              hint={filterActive ? '尝试调整筛选条件' : '供应商档案由管理岗维护后可见'}
            />
          )}

          {allSuppliers && filtered.length > 0 && (
            <div className="overflow-hidden rounded-card border border-border bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-caption">
                  <thead className="bg-bg text-gray3">
                    <tr>
                      <th className="px-4 py-3">编号</th>
                      <th className="px-4 py-3">名称</th>
                      <th className="px-4 py-3">状态</th>
                      <th className="px-4 py-3">联系人</th>
                      <th className="px-4 py-3">联系电话</th>
                      <th className="px-4 py-3">账期</th>
                      <th className="px-4 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {paged.map(supplier => (
                      <tr
                        key={supplier.id}
                        className={`cursor-pointer hover:bg-bg/50 ${selectedId === supplier.id ? 'bg-accent/5' : ''}`}
                        onClick={() => setSelectedId(supplier.id)}
                      >
                        <td className="px-4 py-3 font-num text-gray2">{supplier.no}</td>
                        <td className="px-4 py-3">
                          <b>{supplier.name}</b>
                          {supplier.category && <span className="ml-2 text-micro text-gray3">{supplier.category}</span>}
                        </td>
                        <td className="px-4 py-3">
                          <Chip tone={supplierStatusTone(supplier.status)}>{formatSupplierStatusLabel(supplier.status)}</Chip>
                        </td>
                        <td className="px-4 py-3 text-gray2">{supplier.contactName || '—'}</td>
                        <td className="px-4 py-3 font-num text-gray2">{supplier.contactPhone || '—'}</td>
                        <td className="px-4 py-3 text-gray2">{formatCreditDays(supplier)}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={e => { e.stopPropagation(); toggleStatus(supplier) }}
                            disabled={togglingId === supplier.id}
                            className={`text-button ${supplier.status === 'ENABLED' ? 'text-red-fg' : 'text-green-fg'}`}
                          >
                            {supplier.status === 'ENABLED' ? '停用' : '启用'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {filtered.length > 0 && (
                <PaginationBar
                  page={filters.page}
                  totalPages={totalPages}
                  pageSize={filters.pageSize}
                  total={filtered.length}
                  onPage={page => setFilters(current => keepFiltersForPage(current, page))}
                />
              )}
            </div>
          )}
        </section>

        <aside className="lg:pt-4">
          <div className="rounded-card border border-border bg-white p-4">
            <h2 className="text-h2">供应商档案</h2>
            {!selected ? (
              <div className="mt-6 rounded-card bg-bg p-6 text-center text-caption text-gray3">
                点击左侧列表查看详情
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div>
                  <div className="text-micro text-gray3">供应商名称</div>
                  <div className="text-body font-medium">{selected.name}</div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-micro text-gray3">编号</div>
                    <div className="font-num text-body">{selected.no}</div>
                  </div>
                  <div>
                    <div className="text-micro text-gray3">状态</div>
                    <div className="mt-0.5">
                      <Chip tone={supplierStatusTone(selected.status)}>{formatSupplierStatusLabel(selected.status)}</Chip>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-micro text-gray3">联系人</div>
                    <div className="text-body text-gray2">{selected.contactName || '—'}</div>
                  </div>
                  <div>
                    <div className="text-micro text-gray3">联系电话</div>
                    <div className="font-num text-body text-gray2">{selected.contactPhone || '—'}</div>
                  </div>
                </div>
                <div>
                  <div className="text-micro text-gray3">账期</div>
                  <div className="text-body text-gray2">{formatCreditDays(selected)}</div>
                </div>
                {selected.category && (
                  <div>
                    <div className="text-micro text-gray3">类目</div>
                    <div className="text-body text-gray2">{selected.category}</div>
                  </div>
                )}
                <div className="border-t border-border pt-4">
                  <div className="text-micro text-gray3">商品数量</div>
                  <div className="mt-1 text-h2 text-amber">{getSupplierDetailStats(selected).productCountLabel}</div>
                  <p className="mt-1 text-micro text-gray3">该统计需接入商品主数据后展示。</p>
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>

      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function FilterInput({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro text-gray3">{label}</span>
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 min-w-44 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
      />
    </label>
  )
}

function FilterSelect({ label, value, onChange, children }: {
  label: string; value: string; onChange: (v: string) => void; children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro text-gray3">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-10 min-w-36 rounded-cta border border-border bg-white px-3 text-body"
      >
        {children}
      </select>
    </label>
  )
}

function PaginationBar({ page, totalPages, pageSize, total, onPage }: {
  page: number; totalPages: number; total: number; pageSize: number; onPage: (p: number) => void
}) {
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-3 text-caption text-gray2">
      <span>第 {start}–{end} 项，共 {total} 项</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="rounded-cta border border-border bg-white px-3 py-1.5 text-button disabled:opacity-40"
        >上一页</button>
        <span className="font-num">{page} / {totalPages}</span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          className="rounded-cta border border-border bg-white px-3 py-1.5 text-button disabled:opacity-40"
        >下一页</button>
      </div>
    </div>
  )
}
