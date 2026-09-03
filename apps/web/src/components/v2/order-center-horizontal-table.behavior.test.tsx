// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderCenterHorizontalTable } from './order-center-horizontal-table'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

class ResizeObserverHarness {
  static instances: ResizeObserverHarness[] = []
  readonly observed: Element[] = []

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverHarness.instances.push(this)
  }

  observe(element: Element) {
    this.observed.push(element)
  }

  disconnect() {}
  unobserve() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

function pointerEvent(type: string, clientX: number, options?: { pointerId?: number; pointerType?: string }) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
  })
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: options?.pointerId ?? 1 },
    pointerType: { configurable: true, value: options?.pointerType ?? 'mouse' },
  })
  return event
}

function renderHorizontalTable() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <OrderCenterHorizontalTable>
        <table><tbody><tr><td>wide content</td></tr></tbody></table>
      </OrderCenterHorizontalTable>,
    )
  })

  const scrollbar = container.querySelector('[role="scrollbar"]') as HTMLDivElement | null
  if (!scrollbar) throw new Error('persistent scrollbar was not rendered')
  const thumb = scrollbar.querySelector('[data-scrollbar-thumb]') as HTMLDivElement | null
  if (!thumb) throw new Error('scrollbar thumb was not rendered')
  const viewport = scrollbar.parentElement?.previousElementSibling as HTMLDivElement | null
  if (!viewport) throw new Error('horizontal viewport was not rendered')
  const observer = ResizeObserverHarness.instances.at(-1)
  if (!observer) throw new Error('ResizeObserver was not created')

  let clientWidth = 400
  let scrollWidth = 1_000
  let scrollLeft = 0
  let trackWidth = 800
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => clientWidth },
    scrollWidth: { configurable: true, get: () => scrollWidth },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: value => { scrollLeft = Number(value) },
    },
  })
  Object.defineProperties(scrollbar, {
    clientWidth: { configurable: true, get: () => trackWidth },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        bottom: 12,
        height: 12,
        left: 100,
        right: 100 + trackWidth,
        top: 0,
        width: trackWidth,
        x: 100,
        y: 0,
        toJSON() { return this },
      }),
    },
  })

  const resize = (nextClientWidth = clientWidth, nextScrollWidth = scrollWidth, nextTrackWidth = trackWidth) => {
    clientWidth = nextClientWidth
    scrollWidth = nextScrollWidth
    trackWidth = nextTrackWidth
    act(() => observer.trigger())
  }
  const nativeScroll = (left: number) => {
    scrollLeft = left
    act(() => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
  }
  const clickTrack = (clientX: number) => {
    act(() => scrollbar.dispatchEvent(pointerEvent('pointerdown', clientX)))
  }
  const dragThumb = (from: number, to: number, pointerType = 'mouse') => {
    act(() => {
      thumb.dispatchEvent(pointerEvent('pointerdown', from, { pointerType }))
      thumb.dispatchEvent(pointerEvent('pointermove', to, { pointerType }))
      thumb.dispatchEvent(pointerEvent('pointerup', to, { pointerType }))
    })
  }

  resize()
  return {
    container,
    observer,
    scrollbar,
    thumb,
    viewport,
    resize,
    nativeScroll,
    clickTrack,
    dragThumb,
    cleanup() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('OrderCenterHorizontalTable behavior', () => {
  beforeEach(() => {
    ResizeObserverHarness.instances = []
    vi.stubGlobal('ResizeObserver', ResizeObserverHarness)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('always renders one track and thumb without a range input, percentage or instruction', () => {
    const view = renderHorizontalTable()

    expect(view.container.querySelectorAll('[role="scrollbar"]')).toHaveLength(1)
    expect(view.container.querySelector('input')).toBeNull()
    expect(view.container.textContent).toBe('wide content')
    expect(view.scrollbar.getAttribute('aria-valuemax')).toBe('600')
    expect(view.thumb.style.width).toBe('320px')
    expect(view.observer.observed).toContain(view.viewport)
    expect(view.observer.observed).toContain(view.scrollbar)
    expect(view.observer.observed).toContain(view.viewport.firstElementChild)
    view.cleanup()
  })

  it('mirrors native wheel or touch scrolling into the persistent thumb', () => {
    const view = renderHorizontalTable()

    view.nativeScroll(300)

    expect(view.scrollbar.getAttribute('aria-valuenow')).toBe('300')
    expect(view.thumb.style.transform).toBe('translate3d(240px, 0, 0)')
    view.cleanup()
  })

  it('moves the native viewport when the track is clicked', () => {
    const view = renderHorizontalTable()

    view.clickTrack(500)

    expect(view.viewport.scrollLeft).toBe(300)
    expect(view.scrollbar.getAttribute('aria-valuenow')).toBe('300')
    view.cleanup()
  })

  it.each(['mouse', 'touch'])('drags the thumb with a %s pointer', pointerType => {
    const view = renderHorizontalTable()

    view.dragThumb(100, 340, pointerType)

    expect(view.viewport.scrollLeft).toBe(300)
    expect(view.scrollbar.getAttribute('aria-valuenow')).toBe('300')
    view.cleanup()
  })

  it('clamps elastic overscroll and remains visibly disabled when content fits', () => {
    const view = renderHorizontalTable()

    view.nativeScroll(-80)
    expect(view.viewport.scrollLeft).toBe(0)
    view.nativeScroll(900)
    expect(view.viewport.scrollLeft).toBe(600)

    view.resize(1_000, 1_000)

    expect(view.viewport.scrollLeft).toBe(0)
    expect(view.container.querySelector('[role="scrollbar"]')).toBe(view.scrollbar)
    expect(view.scrollbar.getAttribute('aria-disabled')).toBe('true')
    expect(view.scrollbar.getAttribute('aria-valuemax')).toBe('0')
    expect(view.thumb.style.width).toBe('800px')
    expect(view.thumb.style.transform).toBe('translate3d(0px, 0, 0)')
    view.cleanup()
  })

  it('supports standard keyboard scrolling controls', () => {
    const view = renderHorizontalTable()

    act(() => view.scrollbar.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'End' })))
    expect(view.viewport.scrollLeft).toBe(600)

    act(() => view.scrollbar.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Home' })))
    expect(view.viewport.scrollLeft).toBe(0)
    view.cleanup()
  })
})
