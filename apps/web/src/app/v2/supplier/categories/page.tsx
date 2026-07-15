'use client'

import { useEffect, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

type Category = {
  id: string | null
  name: string
  count: number
  sortOrder: number
  isActive: boolean
  isSystem: boolean
}

export default function SupplierCategoriesPage() {
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const rows = await apiFetch<Category[]>('/api/products/categories')
      setCategories(Array.isArray(rows) ? rows : [])
      setError(null)
    } catch (e: any) {
      setError(e.message || '分类加载失败')
    }
  }

  useEffect(() => { void load() }, [])

  async function createCategory() {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true); setError(null)
    try {
      await apiFetch('/api/products/categories', {
        method: 'POST', body: JSON.stringify({ name }),
      })
      setNewName('')
      await load()
    } catch (e: any) {
      setError(e.message || '新增分类失败')
    } finally {
      setBusy(false)
    }
  }

  async function saveRename(category: Category) {
    const name = editingName.trim()
    if (!category.id || !name || name === category.name || busy) {
      setEditingId(null); return
    }
    setBusy(true); setError(null)
    try {
      await apiFetch(`/api/products/categories/${category.id}`, {
        method: 'PATCH', body: JSON.stringify({ name }),
      })
      setEditingId(null)
      await load()
    } catch (e: any) {
      setError(e.message || '分类改名失败')
    } finally {
      setBusy(false)
    }
  }

  async function toggle(category: Category) {
    if (!category.id || category.isSystem || busy) return
    setBusy(true); setError(null)
    try {
      await apiFetch(`/api/products/categories/${category.id}`, {
        method: 'PATCH', body: JSON.stringify({ isActive: !category.isActive }),
      })
      await load()
    } catch (e: any) {
      setError(e.message || '分类状态修改失败')
    } finally {
      setBusy(false)
    }
  }

  async function move(index: number, direction: -1 | 1) {
    if (!categories || busy) return
    const target = index + direction
    if (target < 0 || target >= categories.length) return
    const next = [...categories]
    ;[next[index], next[target]] = [next[target], next[index]]
    const ids = next.map(category => category.id).filter((id): id is string => !!id)
    if (ids.length !== next.length) {
      setError('存在尚未纳入主数据的历史分类，请刷新或先执行分类迁移')
      return
    }
    setCategories(next)
    setBusy(true); setError(null)
    try {
      await apiFetch('/api/products/categories-order', {
        method: 'PATCH', body: JSON.stringify({ ids }),
      })
      await load()
    } catch (e: any) {
      setError(e.message || '分类排序失败')
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/supplier/products" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <div className="flex-1">
          <h1 className="text-h1">分类管理</h1>
          <p className="text-caption text-gray3">商品报价与供应商库存共用</p>
        </div>
        <a href="/v2/supplier/inventory" className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2">查看库存</a>
      </header>

      <section className="px-4 mt-2">
        <div className="bg-bg-card border border-border rounded-card p-3">
          <div className="text-h2">新增分类</div>
          <div className="flex gap-2 mt-2">
            <input
              value={newName}
              onChange={event => setNewName(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void createCategory() }}
              maxLength={40}
              placeholder="如：蔬菜、冻品、调味料"
              className="flex-1 min-w-0 bg-bg border border-border rounded-cta px-3 py-2 text-body outline-none focus:border-accent"
            />
            <button
              onClick={() => void createCategory()}
              disabled={!newName.trim() || busy}
              className="px-4 rounded-cta bg-accent text-white text-button disabled:opacity-40"
            >新增</button>
          </div>
          <p className="text-micro text-gray3 mt-2">停用后历史商品和库存仍保留，但新建、导入和批量改类不能再选用。</p>
        </div>
      </section>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-cta p-3 text-caption">{error}</div>}

      <section className="px-4 mt-3">
        <div className="flex items-center mb-2">
          <h2 className="text-h2">全部分类</h2>
          <span className="ml-2 text-caption text-gray3">{categories?.length ?? 0} 类</span>
          <span className="ml-auto text-micro text-gray3">上下箭头调整库存展示顺序</span>
        </div>
        {categories === null && <div className="text-caption text-gray3 text-center py-8">加载中…</div>}
        {categories?.length === 0 && (
          <div className="bg-white border border-border rounded-card p-8 text-center text-caption text-gray3">暂无分类</div>
        )}
        <ul className="space-y-2">
          {categories?.map((category, index) => (
            <li key={category.id || category.name} className={`bg-white border border-border rounded-card p-3 ${category.isActive ? '' : 'opacity-65'}`}>
              <div className="flex items-center gap-2">
                <div className="flex flex-col gap-1">
                  <button onClick={() => void move(index, -1)} disabled={index === 0 || busy} className="w-7 h-6 rounded bg-bg text-gray2 disabled:opacity-20" aria-label={`上移 ${category.name}`}>↑</button>
                  <button onClick={() => void move(index, 1)} disabled={index === categories.length - 1 || busy} className="w-7 h-6 rounded bg-bg text-gray2 disabled:opacity-20" aria-label={`下移 ${category.name}`}>↓</button>
                </div>
                <div className="flex-1 min-w-0">
                  {editingId === category.id ? (
                    <div className="flex gap-2">
                      <input
                        autoFocus value={editingName} maxLength={40}
                        onChange={event => setEditingName(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void saveRename(category)
                          if (event.key === 'Escape') setEditingId(null)
                        }}
                        className="flex-1 min-w-0 bg-bg border border-accent rounded-cta px-2 py-1 text-body"
                      />
                      <button onClick={() => void saveRename(category)} className="px-3 rounded-cta bg-accent text-white text-button">保存</button>
                      <button onClick={() => setEditingId(null)} className="px-2 text-caption text-gray3">取消</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-h2 truncate">{category.name}</span>
                      {category.isSystem && <Chip tone="gray">系统</Chip>}
                      {!category.isActive && <Chip tone="gray">已停用</Chip>}
                    </div>
                  )}
                  <div className="text-caption text-gray3 mt-1">{category.count} 个 SKU · 商品和库存同步归类</div>
                </div>
                {!category.isSystem && category.id && editingId !== category.id && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => { setEditingId(category.id); setEditingName(category.name) }}
                      className="text-caption text-accent"
                    >改名</button>
                    <button onClick={() => void toggle(category)} className={`text-caption ${category.isActive ? 'text-red-fg' : 'text-green-fg'}`}>
                      {category.isActive ? '停用' : '恢复'}
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <BottomNav
        tabs={[
          { key: 'home', label: '首页', icon: '⌂' },
          { key: 'orders', label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me', label: '我的', icon: '◐' },
        ]}
        activeKey="inventory"
        onChange={key => {
          if (key === 'home') location.href = '/v2/supplier/home'
          if (key === 'orders') location.href = '/v2/supplier/orders'
          if (key === 'inventory') location.href = '/v2/supplier/inventory'
          if (key === 'billing') location.href = '/v2/supplier/billing'
          if (key === 'me') location.href = '/v2/supplier/history'
        }}
      />
    </div>
  )
}
