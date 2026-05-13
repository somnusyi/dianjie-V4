import axios from 'axios'

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000',
  timeout: 10000,
})

// 自动带上 token
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('dj_token')
    if (token) config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 401 先尝试用 refresh token 续期，再跳登录
let isRefreshing = false
let refreshQueue: Array<(token: string) => void> = []

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config
    if (err.response?.status === 401 && typeof window !== 'undefined' && !original._retry) {
      const refresh = localStorage.getItem('dj_refresh')
      if (refresh) {
        original._retry = true
        if (isRefreshing) {
          // 等待正在进行的刷新完成
          return new Promise((resolve) => {
            refreshQueue.push((token) => {
              original.headers.Authorization = `Bearer ${token}`
              resolve(api(original))
            })
          })
        }
        isRefreshing = true
        try {
          const r = await axios.post(
            `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/auth/refresh`,
            { token: refresh }
          )
          const newToken = r.data.token
          localStorage.setItem('dj_token', newToken)
          if (r.data.refreshToken) localStorage.setItem('dj_refresh', r.data.refreshToken)
          refreshQueue.forEach(cb => cb(newToken))
          refreshQueue = []
          original.headers.Authorization = `Bearer ${newToken}`
          return api(original)
        } catch {
          refreshQueue = []
          localStorage.clear()
          window.location.href = '/login'
        } finally {
          isRefreshing = false
        }
      } else {
        localStorage.clear()
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

export default api
