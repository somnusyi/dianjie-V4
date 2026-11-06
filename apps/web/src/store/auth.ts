import { getToken, setMemoryToken, logoutSession } from '@/lib/v2-auth'
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
      setMemoryToken(token)
    }
  },

  logout: () => {
    set({ user: null, token: null })
    if (typeof window !== 'undefined') void logoutSession().finally(()=>{window.location.href='/v2/login'})
  },

  hydrate: () => {
    if (typeof window === 'undefined') return
    const rawUser = localStorage.getItem('user') || localStorage.getItem('dj_user')
    const token = getToken()
    if (rawUser && token) {
      try {
        set({ user: JSON.parse(rawUser), token })
      } catch {}
    }
  },
}))
