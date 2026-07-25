// @vitest-environment jsdom
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { ProductImagePreview } from './product-image-preview'

// 告诉 React 当前测试环境支持 act，避免 jsdom 下的警告
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

function getOverlay(container: HTMLElement) {
  return container.querySelector('[data-testid="image-preview-overlay"]') as HTMLElement | null
}

function getCloseButton(container: HTMLElement) {
  return container.querySelector('[data-testid="image-preview-close"]') as HTMLElement | null
}

function getImage(container: HTMLElement) {
  return container.querySelector('[data-testid="image-preview-img"]') as HTMLImageElement | null
}

describe('ProductImagePreview', () => {
  it('关闭时不渲染任何内容', () => {
    const { container, cleanup } = render(
      <ProductImagePreview src="https://example.com/a.jpg" isOpen={false} onClose={vi.fn()} />,
    )
    expect(getOverlay(container)).toBeNull()
    expect(getImage(container)).toBeNull()
    cleanup()
  })

  it('打开时渲染大图并显示 alt', () => {
    const { container, cleanup } = render(
      <ProductImagePreview src="https://example.com/a.jpg" alt="测试商品" isOpen onClose={vi.fn()} />,
    )
    const img = getImage(container)
    expect(img).not.toBeNull()
    expect(img?.src).toBe('https://example.com/a.jpg')
    expect(img?.alt).toBe('测试商品')
    cleanup()
  })

  it('点击关闭按钮触发 onClose', () => {
    const onClose = vi.fn()
    const { container, cleanup } = render(
      <ProductImagePreview src="https://example.com/a.jpg" isOpen onClose={onClose} />,
    )
    const closeBtn = getCloseButton(container)
    expect(closeBtn).not.toBeNull()
    act(() => closeBtn!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('点击遮罩层触发 onClose', () => {
    const onClose = vi.fn()
    const { container, cleanup } = render(
      <ProductImagePreview src="https://example.com/a.jpg" isOpen onClose={onClose} />,
    )
    const overlay = getOverlay(container)
    expect(overlay).not.toBeNull()
    act(() => overlay!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('按 ESC 键触发 onClose', () => {
    const onClose = vi.fn()
    const { container, cleanup } = render(
      <ProductImagePreview src="https://example.com/a.jpg" isOpen onClose={onClose} />,
    )
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('src 为空时不渲染', () => {
    const { container, cleanup } = render(
      <ProductImagePreview src={null} isOpen onClose={vi.fn()} />,
    )
    expect(getOverlay(container)).toBeNull()
    cleanup()
  })
})
