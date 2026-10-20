// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { printSheet } from './print-sheet'
afterEach(() => { window.dispatchEvent(new Event('afterprint')); document.body.innerHTML=''; vi.restoreAllMocks() })
it('keeps a pending snapshot off screen and cleans up on focus when afterprint is missing', () => {
  document.body.innerHTML='<article id="sheet">原单据</article>'
  vi.spyOn(window,'print').mockImplementation(()=>undefined)
  printSheet('sheet')
  expect((document.querySelector('[data-print-clone]') as HTMLElement).style.display).toBe('none')
  window.dispatchEvent(new Event('focus'))
  expect(document.querySelector('[data-print-clone]')).toBeNull()
  expect(document.body.dataset.procurementPrinting).toBeUndefined()
  expect(document.getElementById('sheet')?.textContent).toBe('原单据')
})
it('replaces an unfinished print and removes both snapshots and listeners after failure', () => {
  document.body.innerHTML='<article id="sheet">原单据</article>'
  const print=vi.spyOn(window,'print').mockImplementation(()=>undefined)
  printSheet('sheet');printSheet('sheet')
  expect(document.querySelectorAll('[data-print-clone]')).toHaveLength(1)
  print.mockImplementation(()=>{throw new Error('no printer')})
  expect(()=>printSheet('sheet')).toThrow('no printer')
  expect(document.querySelector('[data-print-clone]')).toBeNull()
  expect(document.body.dataset.procurementPrinting).toBeUndefined()
})
