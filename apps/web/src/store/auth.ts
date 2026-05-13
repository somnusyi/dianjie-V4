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
  // Hydrate from localStorage on app boot
  hydrate: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,

  setUser: (user) => {
    set({ user })
    if (typeof window !== 'undefined') {
      if (user) localStorage.setItem('dj_user', JSON.stringify(user))
      else localStorage.removeItem('dj_user')
    }
  },

  setToken: (token) => {
    set({ token })
    if (typeof window !== 'undefined') {
      if (token) localStorage.setItem('dj_token', token)
      else localStorage.removeItem('dj_token')
    }
  },

  logout: () => {
    set({ user: null, token: null })
    if (typeof window !== 'undefined') {
      localStorage.clear()
      window.location.href = '/login'
    }
  },

  hydrate: () => {
    if (typeof window === 'undefined') return
    const rawUser = localStorage.getItem('dj_user')
    const token = localStorage.getItem('dj_token')
    if (rawUser && token) {
      try {
        set({ user: JSON.parse(rawUser), token })
      } catch {}
    }
  },
}))
