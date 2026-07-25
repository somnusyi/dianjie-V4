// @vitest-environment jsdom
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { ProductFilterSidebar } from './product-filter-sidebar'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(ui))
  return {
    container,
    cleanup() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function findButtonByLabel(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find(b =>
    b.textContent?.includes(label),
  )
}

describe('ProductFilterSidebar', () => {
  const products = [
    { status: 'ENABLED' },
    { status: 'ENABLED' },
    { status: 'PENDING_APPROVAL' },
    { status: 'DISABLED' },
    { status: 'PENDING_DISABLE' },
  ]

  const categories = [
    { name: '蔬菜', count: 2 },
    { name: '肉类', count: 3 },
  ]

  it('渲染分类与全部计数', () => {
    const { container, cleanup } = render(
      <ProductFilterSidebar
        products={products}
        categories={categories}
        categoryFilter=""
        statusFilter=""
        onCategoryChange={vi.fn()}
        onStatusChange={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('分类')
    expect(container.textContent).toContain(`全部${products.length}`)
    expect(container.textContent).toContain('蔬菜2')
    expect(container.textContent).toContain('肉类3')
    cleanup()
  })

  it('渲染状态与计数', () => {
    const { container, cleanup } = render(
      <ProductFilterSidebar
        products={products}
        categories={categories}
        categoryFilter=""
        statusFilter=""
        onCategoryChange={vi.fn()}
        onStatusChange={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('状态')
    expect(container.textContent).toContain('供应中2')
    expect(container.textContent).toContain('上架待审1')
    expect(container.textContent).toContain('停售待审1')
    expect(container.textContent).toContain('已停售1')
    cleanup()
  })

  it('点击分类触发 onCategoryChange', () => {
    const onCategoryChange = vi.fn()
    const { container, cleanup } = render(
      <ProductFilterSidebar
        products={products}
        categories={categories}
        categoryFilter=""
        statusFilter=""
        onCategoryChange={onCategoryChange}
        onStatusChange={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    const meatBtn = findButtonByLabel(container, '肉类')
    expect(meatBtn).not.toBeUndefined()
    act(() => meatBtn!.click())
    expect(onCategoryChange).toHaveBeenCalledWith('肉类')
    cleanup()
  })

  it('点击「全部」分类传空字符串', () => {
    const onCategoryChange = vi.fn()
    const { container, cleanup } = render(
      <ProductFilterSidebar
        products={products}
        categories={categories}
        categoryFilter="肉类"
        statusFilter=""
        onCategoryChange={onCategoryChange}
        onStatusChange={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    const allBtn = findButtonByLabel(container, '全部')
    expect(allBtn).not.toBeUndefined()
    act(() => allBtn!.click())
    expect(onCategoryChange).toHaveBeenCalledWith('')
    cleanup()
  })

  it('点击状态触发 onStatusChange', () => {
    const onStatusChange = vi.fn()
    const { container, cleanup } = render(
      <ProductFilterSidebar
        products={products}
        categories={categories}
        categoryFilter=""
        statusFilter=""
        onCategoryChange={vi.fn()}
        onStatusChange={onStatusChange}
        onClear={vi.fn()}
      />,
    )
    const disabledBtn = findButtonByLabel(container, '已停售')
    expect(disabledBtn).not.toBeUndefined()
    act(() => disabledBtn!.click())
    expect(onStatusChange).toHaveBeenCalledWith('DISABLED')
    cleanup()
  })

  it('存在筛选条件时显示清除按钮', () => {
    const onClear = vi.fn()
    const { container, cleanup } = render(
      <ProductFilterSidebar
        products={products}
        categories={categories}
        categoryFilter="蔬菜"
        statusFilter=""
        onCategoryChange={vi.fn()}
        onStatusChange={vi.fn()}
        onClear={onClear}
      />,
    )
    const clearBtn = findButtonByLabel(container, '清除筛选')
    expect(clearBtn).not.toBeUndefined()
    act(() => clearBtn!.click())
    expect(onClear).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('无筛选条件时不显示清除按钮', () => {
    const { container, cleanup } = render(
      <ProductFilterSidebar
        products={products}
        categories={categories}
        categoryFilter=""
        statusFilter=""
        onCategoryChange={vi.fn()}
        onStatusChange={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    expect(findButtonByLabel(container, '清除筛选')).toBeUndefined()
    cleanup()
  })
})
