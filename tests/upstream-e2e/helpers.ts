import type { Page, TestInfo } from 'playwright/test'

const apiBaseUrl = (process.env.UPSTREAM_E2E_API_URL || 'http://127.0.0.1:4444').replace(/\/+$/, '')

export type UpstreamFixture = {
  stamp: string
  tenantId: string
  tenantSlug: string
  warehouseId: string
  storeId: string
  supplierId: string
  supplierName: string
  otherSupplierId: string
  fulfillmentSupplierId: string
  fulfillmentSupplierName: string
  productId: string
  productName: string
  sourceId: string
  password: string
  accounts: Record<string, { id: string; phone: string }>
}

export function fixture(): UpstreamFixture {
  const raw = process.env.UPSTREAM_E2E_FIXTURE_JSON
  if (!raw) throw new Error('浏览器验收数据尚未初始化')
  return JSON.parse(raw) as UpstreamFixture
}

export async function login(
  page: Page,
  account: { phone: string },
  options: { finance?: boolean } = {},
) {
  const data = fixture()
  const path = options.finance
    ? `/v2/finance-pc/login?tenant=${encodeURIComponent(data.tenantSlug)}`
    : `/v2/login?tenant=${encodeURIComponent(data.tenantSlug)}`
  await page.goto(path)
  await page.getByLabel('手机号 / 邮箱').fill(account.phone)
  await page.getByLabel('密码').fill(data.password)
  await page.getByRole('button', { name: options.finance ? '登录财务工作台' : '登录', exact: true }).click()
  await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 20_000 })
}

export async function api<T = any>(page: Page, path: string, init: RequestInit = {}) {
  const token = await page.evaluate(() => localStorage.getItem('token') || localStorage.getItem('dj_token'))
  if (!token) throw new Error('当前页面没有登录令牌')
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  return { status: response.status, body }
}

export async function apiOk<T = any>(page: Page, path: string, init: RequestInit = {}) {
  const result = await api<T>(page, path, init)
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${init.method || 'GET'} ${path} → ${result.status}: ${result.body.error || result.body.message || '请求失败'}`)
  }
  return result.body
}

export async function capture(page: Page, testInfo: TestInfo, name: string) {
  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '-')
  const path = testInfo.outputPath(`${safeName}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}
