import { create } from 'zustand'

export interface AuthUser {
  id: string
  name: string
  email: string
  role: string
  storeId?: string
  supplierId?: string
  tenantId: string
  store?: { id: string; name: string }
}

interface AuthState {
  user: AuthUser | null
  token: string | null
  setUser: (user: AuthUser | null) => void
  setToken: (token: string | null) => void
  logout: () => void
  // Hydrate from sessionStorage on app boot
  hydrate: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,

  setUser: (user) => {
    set({ user })
    if (typeof window !== 'undefined') {
      if (user) sessionStorage.setItem('dj_user', JSON.stringify(user))
      else sessionStorage.removeItem('dj_user')
    }
  },

  setToken: (token) => {
    set({ token })
    if (typeof window !== 'undefined') {
      if (token) sessionStorage.setItem('dj_token', token)
      else sessionStorage.removeItem('dj_token')
    }
  },

  logout: () => {
    set({ user: null, token: null })
    if (typeof window !== 'undefined') {
      for (const key of ['dj_token', 'dj_refresh', 'dj_user', 'token', 'refreshToken', 'user', 'tenant']) {
        sessionStorage.removeItem(key)
      }
      window.location.href = '/v2/login'
    }
  },

  hydrate: () => {
    if (typeof window === 'undefined') return
    const rawUser = sessionStorage.getItem('user') || sessionStorage.getItem('dj_user')
    const token = sessionStorage.getItem('token') || sessionStorage.getItem('dj_token')
    if (rawUser && token) {
      try {
        set({ user: JSON.parse(rawUser), token })
      } catch {}
    }
  },
}))
