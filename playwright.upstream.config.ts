import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { defineConfig, devices } from 'playwright/test'

loadEnv({ path: resolve(process.cwd(), 'apps/api/.env') })

const webBaseUrl = (process.env.UPSTREAM_E2E_WEB_URL || 'http://127.0.0.1:3200').replace(/\/+$/, '')
const apiBaseUrl = (process.env.UPSTREAM_E2E_API_URL || 'http://127.0.0.1:4444').replace(/\/+$/, '')

function portFromUrl(value: string) {
  const url = new URL(value)
  return url.port || (url.protocol === 'https:' ? '443' : '80')
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const webPort = portFromUrl(webBaseUrl)
const apiPort = portFromUrl(apiBaseUrl)

function findInstalledChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  }

  // Codex hosts may already carry a newer Playwright browser while the exact
  // project revision cannot be downloaded (for example behind a slow CDN).
  // Chromium's DevTools protocol remains backwards compatible for these tests,
  // so prefer an existing local headless shell instead of blocking acceptance.
  const cacheRoot = resolve(homedir(), 'Library/Caches/ms-playwright')
  if (!existsSync(cacheRoot)) return undefined
  const candidates = readdirSync(cacheRoot)
    .filter(name => name.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse()
    .map(name => resolve(cacheRoot, name, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'))
  return candidates.find(existsSync)
}

const chromiumExecutable = findInstalledChromium()

export default defineConfig({
  testDir: './tests/upstream-e2e',
  globalSetup: './tests/upstream-e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  outputDir: 'test-results/upstream',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/upstream', open: 'never' }],
  ],
  use: {
    baseURL: webBaseUrl,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : undefined,
  },
  webServer: [
    {
      command: `API_PORT=${apiPort} FRONTEND_URL=${shellQuote(webBaseUrl)} NODE_ENV=test UPSTREAM_PROCUREMENT_ENABLED=true UPSTREAM_RECEIPT_POSTING_ENABLED=true pnpm --filter @dianjie/api dev`,
      cwd: process.cwd(),
      url: `${apiBaseUrl}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `WEB_PORT=${webPort} NEXT_PUBLIC_API_BASE=${shellQuote(apiBaseUrl)} pnpm --filter @dianjie/web dev`,
      cwd: process.cwd(),
      url: `${webBaseUrl}/v2/login`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
