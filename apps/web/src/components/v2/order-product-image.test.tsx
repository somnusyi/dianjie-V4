// @vitest-environment jsdom
import React from 'react'
import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { OrderProductImage } from './order-product-image'

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

function getImg(container: HTMLElement) {
  return container.querySelector('img') as HTMLImageElement | null
}

function getPlaceholder(container: HTMLElement) {
  return container.querySelector('[aria-hidden="true"]') as HTMLElement | null
}

describe('OrderProductImage', () => {
  describe('有图渲染', () => {
    it('渲染 img 并设置正确的 src', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="https://cdn.example.com/a.jpg" name="土豆" />,
      )
      const img = getImg(container)
      expect(img).not.toBeNull()
      expect(img!.src).toBe('https://cdn.example.com/a.jpg')
      cleanup()
    })

    it('alt 只含商品名（无编码）', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="https://cdn.example.com/a.jpg" name="土豆" />,
      )
      expect(getImg(container)!.alt).toBe('土豆')
      cleanup()
    })

    it('alt 包含商品名和编码', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="https://cdn.example.com/a.jpg" name="土豆" code="VG-001" />,
      )
      expect(getImg(container)!.alt).toBe('土豆 #VG-001')
      cleanup()
    })

    it('设置 loading=lazy 和 decoding=async', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="https://cdn.example.com/a.jpg" name="土豆" />,
      )
      const img = getImg(container)!
      expect(img.getAttribute('loading')).toBe('lazy')
      expect(img.getAttribute('decoding')).toBe('async')
      cleanup()
    })

    it('compact 尺寸: h-10 w-10', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="https://cdn.example.com/a.jpg" name="土豆" size="compact" />,
      )
      const img = getImg(container)!
      expect(img.className).toContain('h-10')
      expect(img.className).toContain('w-10')
      cleanup()
    })

    it('picker 尺寸: h-12 w-12', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="https://cdn.example.com/a.jpg" name="土豆" size="picker" />,
      )
      const img = getImg(container)!
      expect(img.className).toContain('h-12')
      expect(img.className).toContain('w-12')
      cleanup()
    })

    it('默认尺寸为 compact', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="https://cdn.example.com/a.jpg" name="土豆" />,
      )
      const img = getImg(container)!
      expect(img.className).toContain('h-10')
      expect(img.className).toContain('w-10')
      cleanup()
    })

    it('trim 前后空白 src 后正常渲染', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="  https://cdn.example.com/a.jpg  " name="土豆" />,
      )
      const img = getImg(container)!
      expect(img.src).toBe('https://cdn.example.com/a.jpg')
      cleanup()
    })
  })

  describe('无图占位', () => {
    it('src 为 null 时渲染占位、无 img', () => {
      const { container, cleanup } = render(
        <OrderProductImage src={null} name="土豆" />,
      )
      expect(getImg(container)).toBeNull()
      expect(getPlaceholder(container)).not.toBeNull()
      cleanup()
    })

    it('src 为 undefined 时渲染占位、无 img', () => {
      const { container, cleanup } = render(
        <OrderProductImage src={undefined} name="土豆" />,
      )
      expect(getImg(container)).toBeNull()
      expect(getPlaceholder(container)).not.toBeNull()
      cleanup()
    })

    it('src 为空字符串时渲染占位', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="" name="土豆" />,
      )
      expect(getImg(container)).toBeNull()
      expect(getPlaceholder(container)).not.toBeNull()
      cleanup()
    })

    it('src 为纯空白字符串时渲染占位', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="   " name="土豆" />,
      )
      expect(getImg(container)).toBeNull()
      expect(getPlaceholder(container)).not.toBeNull()
      cleanup()
    })

    it('占位元素 aria-hidden=true 且无交互', () => {
      const { container, cleanup } = render(
        <OrderProductImage src={null} name="土豆" />,
      )
      const ph = getPlaceholder(container)!
      expect(ph.getAttribute('aria-hidden')).toBe('true')
      expect(ph.className).toContain('pointer-events-none')
      expect(ph.className).toContain('select-none')
      cleanup()
    })

    it('占位保持 compact 固定尺寸', () => {
      const { container, cleanup } = render(
        <OrderProductImage src={null} name="土豆" size="compact" />,
      )
      const ph = getPlaceholder(container)!
      expect(ph.className).toContain('h-10')
      expect(ph.className).toContain('w-10')
      cleanup()
    })

    it('占位保持 picker 固定尺寸', () => {
      const { container, cleanup } = render(
        <OrderProductImage src={null} name="土豆" size="picker" />,
      )
      const ph = getPlaceholder(container)!
      expect(ph.className).toContain('h-12')
      expect(ph.className).toContain('w-12')
      cleanup()
    })
  })

  describe('不改变下单业务状态', () => {
    it('组件不渲染任何 input/button/表单元素', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="https://cdn.example.com/a.jpg" name="土豆" code="VG-001" />,
      )
      expect(container.querySelector('input')).toBeNull()
      expect(container.querySelector('button')).toBeNull()
      expect(container.querySelector('form')).toBeNull()
      cleanup()
    })

    it('组件不渲染价格或数量文案', () => {
      const { container, cleanup } = render(
        <OrderProductImage src="https://cdn.example.com/a.jpg" name="土豆" code="VG-001" />,
      )
      const text = container.textContent || ''
      expect(text).not.toMatch(/¥/)
      expect(text).not.toMatch(/\d+\.\d{2}/)
      cleanup()
    })

    it('占位态同样不含价格/数量/交互元素', () => {
      const { container, cleanup } = render(
        <OrderProductImage src={null} name="土豆" />,
      )
      expect(container.querySelector('input')).toBeNull()
      expect(container.querySelector('button')).toBeNull()
      const text = container.textContent || ''
      expect(text).not.toMatch(/¥/)
      cleanup()
    })
  })
})
