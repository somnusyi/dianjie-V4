import { describe, expect, it } from 'vitest'
import { clampFeedbackPosition } from './feedback-fab'

describe('feedback floating button position', () => {
  const viewport = { width: 390, height: 844 }
  const button = { width: 72, height: 44 }

  it('keeps a dragged button fully inside the viewport', () => {
    expect(clampFeedbackPosition({ x: -100, y: -20 }, viewport, button))
      .toEqual({ x: 8, y: 8 })
    expect(clampFeedbackPosition({ x: 999, y: 999 }, viewport, button))
      .toEqual({ x: 310, y: 792 })
  })

  it('preserves a valid user-selected position', () => {
    expect(clampFeedbackPosition({ x: 126, y: 240 }, viewport, button))
      .toEqual({ x: 126, y: 240 })
  })

  it('fails closed on a viewport smaller than the button', () => {
    expect(clampFeedbackPosition(
      { x: 40, y: 40 },
      { width: 50, height: 30 },
      { width: 72, height: 44 },
    )).toEqual({ x: 8, y: 8 })
  })
})
