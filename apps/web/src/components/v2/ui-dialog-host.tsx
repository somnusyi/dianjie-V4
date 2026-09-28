'use client'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation'
import { ConfirmSheet } from './confirm-sheet'
import { cancelDialogs, dismissNotice, finishDialog, getDialogs, getServerDialogs, subscribeDialogs } from '@/lib/ui-dialogs'
export function UiDialogHost() {
  const { dialog, notices } = useSyncExternalStore(subscribeDialogs, getDialogs, getServerDialogs)
  const pathname = usePathname()
  const previousPath = useRef(pathname)
  useEffect(() => { if (previousPath.current !== pathname) { cancelDialogs(); previousPath.current = pathname } }, [pathname])
  return <>
    {notices.length > 0 && <aside aria-label="操作提示" className="fixed left-4 right-4 top-4 z-[80] mx-auto max-w-xl space-y-2">{notices.map(notice => <div role="status" key={notice.id} className="flex items-start justify-between gap-4 rounded-xl border border-border bg-white p-4 text-caption shadow-lg"><span className="whitespace-pre-wrap break-words">{notice.message}</span><button aria-label="关闭提示" className="shrink-0" onClick={() => dismissNotice(notice.id)}>×</button></div>)}</aside>}
    {dialog && <ConfirmSheet key={dialog.id} open title={dialog.kind === 'prompt' ? '请填写信息' : '请确认操作'} body={dialog.message} withInput={dialog.kind === 'prompt'} inputRequired={dialog.kind === 'prompt' && !/可不填|可选|留空|选填/.test(dialog.message)} inputInitialValue={dialog.initialValue} layerClassName="z-[110]" onConfirm={value => finishDialog(dialog.id, true, value)} onCancel={() => finishDialog(dialog.id, false)} close={() => {}} />}
  </>
}
