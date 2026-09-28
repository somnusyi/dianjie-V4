// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UiDialogHost } from './ui-dialog-host'
import { cancelDialogs, confirmDialog, dismissNotice, getDialogs, notifyUser, promptDialog } from '@/lib/ui-dialogs'
vi.mock('next/navigation', () => ({ usePathname: () => '/test' }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => { cancelDialogs(); getDialogs().notices.forEach(notice => dismissNotice(notice.id)) })
function render() { const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container); act(() => root.render(<UiDialogHost />)); return { container, close: () => { act(() => root.unmount()); container.remove() } } }
function click(container: HTMLElement, label: string) { act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === label)?.click()) }
describe('应用内确认和提示', () => {
  it('确认前不执行，取消返回false，重复请求不会排第二次操作', async () => {
    const { container, close } = render()
    let result!: Promise<boolean>, repeated!: Promise<boolean>
    act(() => { result = confirmDialog('确认发货？'); repeated = confirmDialog('确认发货？') })
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('确认发货？')
    expect(container.querySelector('[role="dialog"]')?.className).toContain('z-[110]')
    expect(await repeated).toBe(false)
    click(container, '取消'); expect(await result).toBe(false)
    expect(container.querySelector('[role="dialog"]')).toBeNull(); close()
  })
  it('必填理由不能为空，保存返回输入；预填值可编辑', async () => {
    const { container, close } = render(); let result!: Promise<string | null>
    act(() => { result = promptDialog('请输入驳回原因（必填）', '资料不完整') })
    const input = container.querySelector('textarea')!
    expect(input.value).toBe('资料不完整')
    act(() => Simulate.change(input, { target: { value: '' } } as any))
    expect(Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认')?.disabled).toBe(true)
    act(() => Simulate.change(input, { target: { value: '  缺少附件  ' } } as any))
    await act(async () => click(container, '确认'))
    expect(await result).toBe('缺少附件'); close()
  })
  it('通知为可关闭页内提示，取消待处理输入不继续业务操作', async () => {
    const { container, close } = render(); let result!: Promise<string | null>
    act(() => { notifyUser('保存失败，请重试'); result = promptDialog('填写原因') })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('保存失败')
    act(() => cancelDialogs()); expect(await result).toBeNull()
    act(() => (container.querySelector('[aria-label="关闭提示"]') as HTMLButtonElement).click())
    expect(container.querySelector('[role="status"]')).toBeNull(); close()
  })
})
