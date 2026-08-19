/**
 * 多店门店切换器（方案 C 第一阶段）
 *
 * 登录用户的 stores 数组 > 1 时渲染下拉；切换后写入 activeStoreId 并整页刷新，
 * 之后所有 apiFetch 自动带 X-Active-Store 头，后端按活动门店过滤。
 * 单店用户不渲染（无感）。
 */
'use client'
import { useEffect, useState } from 'react'
import { getUser, getActiveStoreId, setActiveStoreId } from '@/lib/v2-auth'

type StoreOption = { id: string; name: string; no?: string }

export function StoreSwitcher({ className = '' }: { className?: string }) {
  const [stores, setStores] = useState<StoreOption[]>([])
  const [active, setActive] = useState('')

  useEffect(() => {
    const user = getUser()
    const list: StoreOption[] = user?.stores?.length
      ? user.stores
      : (user?.store ? [user.store] : [])
    setStores(list)
    setActive(getActiveStoreId() || list[0]?.id || '')
  }, [])

  if (stores.length <= 1) return null

  return (
    <select
      className={`bg-white border border-border rounded-full px-3 py-1 text-caption text-gray1 ${className}`}
      value={active}
      onChange={e => {
        setActiveStoreId(e.target.value)
        // 整页刷新：各页面的数据请求都带 X-Active-Store，刷新即切换到新门店口径
        location.reload()
      }}
      aria-label="切换门店"
    >
      {stores.map(s => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  )
}
