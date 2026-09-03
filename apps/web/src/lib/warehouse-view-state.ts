'use client'

import { useEffect } from 'react'

export function readWarehouseViewState<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const value = sessionStorage.getItem(key)
    return value ? { ...fallback, ...JSON.parse(value) } : fallback
  } catch {
    return fallback
  }
}

export function writeWarehouseViewState(key: string, value: object) {
  try {
    const current = readWarehouseViewState<Record<string, unknown>>(key, {})
    sessionStorage.setItem(key, JSON.stringify({ ...current, ...value }))
  } catch {}
}

export function useWarehouseScrollRestoration(key: string) {
  useEffect(() => {
    const saved = readWarehouseViewState(key, { scrollY: 0 }).scrollY
    let restoring = saved > 0
    let attempts = 0
    const restore = window.setInterval(() => {
      attempts += 1
      if (saved > 0) window.scrollTo({ top: saved })
      if (Math.abs(window.scrollY - saved) < 2 || attempts >= 20) {
        restoring = false
        window.clearInterval(restore)
      }
    }, 100)
    const save = () => { if (!restoring) writeWarehouseViewState(key, { scrollY: window.scrollY }) }
    window.addEventListener('scroll', save, { passive: true })
    return () => {
      window.clearInterval(restore)
      window.removeEventListener('scroll', save)
      save()
    }
  }, [key])
}
