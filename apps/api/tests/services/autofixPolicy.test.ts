import { describe, expect, it } from 'vitest'
import {
  inspectUnifiedDiff,
  isApprovedAutoMode,
  isAutoDeploymentEnabled,
  isAutoFixModeEnabled,
  isCoreApiEnabled,
  reviewDeploymentPatch,
} from '../../src/services/autofix/policy'

const safeDiff = `diff --git a/apps/web/src/app/v2/supply-chain/home/page.tsx b/apps/web/src/app/v2/supply-chain/home/page.tsx
index 1111111..2222222 100644
--- a/apps/web/src/app/v2/supply-chain/home/page.tsx
+++ b/apps/web/src/app/v2/supply-chain/home/page.tsx
@@ -1,2 +1,2 @@
-const label = value
+const label = value ?? '—'
 export default label
`

describe('auto-fix patch policy', () => {
  it('accepts a small Web presentation patch', () => {
    expect(inspectUnifiedDiff(safeDiff)).toMatchObject({
      ok: true,
      changedLines: 2,
      files: [{ path: 'apps/web/src/app/v2/supply-chain/home/page.tsx', added: 1, deleted: 1 }],
    })
  })

  it.each([
    'apps/api/src/routes/auth.ts',
    'packages/db/prisma/schema.prisma',
    'packages/db/prisma/migrations/20990101000000_bad/migration.sql',
    'apps/api/src/services/notify/events.ts',
    'apps/api/src/services/inventoryCosting.ts',
    'scripts/deploy-worktree.sh',
    'package.json',
    '.env.production',
    'apps/web/src/components/AppLayout.tsx',
    'apps/web/src/app/v2/layout.tsx',
    'apps/web/src/app/globals.css',
    'apps/web/src/components/v2/supply-chain-shell.tsx',
    'apps/web/src/components/v2/feedback-fab.tsx',
    'apps/web/src/components/v2/auth-gate.tsx',
  ])('rejects hard redline or protected path %s', (file) => {
    const diff = safeDiff.replaceAll(
      'apps/web/src/app/v2/supply-chain/home/page.tsx',
      file,
    )
    const result = inspectUnifiedDiff(diff)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/红线|白名单/)
  })

  const diffFor = (file: string) =>
    safeDiff.replaceAll('apps/web/src/app/v2/supply-chain/home/page.tsx', file)

  it('accepts a normal (non-core) API source patch', () => {
    const result = inspectUnifiedDiff(diffFor('apps/api/src/routes/stores.ts'))
    expect(result.ok).toBe(true)
    expect(result.files[0]).toMatchObject({ path: 'apps/api/src/routes/stores.ts', added: 1, deleted: 1 })
  })

  it('accepts apps/api/tests patches', () => {
    const result = inspectUnifiedDiff(diffFor('apps/api/tests/services/stores.test.ts'))
    expect(result.ok).toBe(true)
    expect(result.files[0].path).toBe('apps/api/tests/services/stores.test.ts')
  })

  it('accepts same-name Web pages that share a core keyword (orders/inventory/settlement)', () => {
    expect(inspectUnifiedDiff(diffFor('apps/web/src/app/v2/orders/page.tsx')).ok).toBe(true)
    expect(inspectUnifiedDiff(diffFor('apps/web/src/app/v2/inventory/page.tsx')).ok).toBe(true)
    expect(inspectUnifiedDiff(diffFor('apps/web/src/lib/settlement-format.ts')).ok).toBe(true)
  })

  it.each([
    'apps/api/src/routes/inventory.ts',
    'apps/api/src/routes/orders.ts',
    'apps/api/src/routes/receipts.ts',
    'apps/api/src/routes/purchases.ts',
    'apps/api/src/services/stock/adjust.ts',
    'apps/api/src/routes/loss.ts',
    'apps/api/src/services/settlement/run.ts',
    'apps/api/tests/inventory.test.ts',
  ])('rejects core inventory/cost API path %s', (file) => {
    const result = inspectUnifiedDiff(diffFor(file))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/红线/)
    expect(result.errors.join(' ')).toContain('库存写入/成本核心路径')
  })

  it('rejects non-whitelisted API paths that are not core either (e.g. api root config)', () => {
    const result = inspectUnifiedDiff(diffFor('apps/api/vitest.config.ts'))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/红线|白名单/)
  })

  it('rejects deletion and traversal', () => {
    const deletion = safeDiff
      .replace('+++ b/apps/web/src/app/v2/supply-chain/home/page.tsx', '+++ /dev/null')
      .replace('index 1111111..2222222 100644', 'deleted file mode 100644')
    expect(inspectUnifiedDiff(deletion).ok).toBe(false)

    const traversal = safeDiff.replaceAll(
      'apps/web/src/app/v2/supply-chain/home/page.tsx',
      '../outside.tsx',
    )
    expect(inspectUnifiedDiff(traversal).ok).toBe(false)
  })

  it('rejects a patch whose actual target is disguised by an allowed diff header', () => {
    const disguised = safeDiff
      .replace(
        '--- a/apps/web/src/app/v2/supply-chain/home/page.tsx',
        '--- a/.env.example',
      )
      .replace(
        '+++ b/apps/web/src/app/v2/supply-chain/home/page.tsx',
        '+++ b/.env.example',
      )
    const result = inspectUnifiedDiff(disguised)
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('补丁旧路径与 diff 声明不一致: a/.env.example')
    expect(result.errors).toContain('补丁新路径与 diff 声明不一致: b/.env.example')
  })

  it('requires complete standard git patch headers', () => {
    const missingTarget = safeDiff.replace(
      '+++ b/apps/web/src/app/v2/supply-chain/home/page.tsx\n',
      '',
    )
    const result = inspectUnifiedDiff(missingTarget)
    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      '补丁文件头不完整: apps/web/src/app/v2/supply-chain/home/page.tsx',
    )
  })

  it('treats --- and +++ prefixes inside a hunk as changed content', () => {
    const prefixedContent = safeDiff
      .replace('-const label = value', '--- old display marker')
      .replace("+const label = value ?? '—'", '+++ new display marker')
    expect(inspectUnifiedDiff(prefixedContent)).toMatchObject({
      ok: true,
      changedLines: 2,
    })
  })

  it.each(['old mode 100644\nnew mode 100755', 'copy from safe.tsx', 'deleted file mode 100644'])(
    'rejects file identity or mode metadata: %s',
    (metadata) => {
      const result = inspectUnifiedDiff(safeDiff.replace('index 1111111..2222222 100644', metadata))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('禁止删除、重命名、复制或修改文件模式')
    },
  )

  it('allows new files under apps/web/src', () => {
    const newFileDiff = [
      'diff --git a/apps/web/src/lib/new-util.ts b/apps/web/src/lib/new-util.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/apps/web/src/lib/new-util.ts',
      '@@ -0,0 +1,2 @@',
      '+export const hello = 1',
      '+export const world = 2',
      '',
    ].join('\n')
    const result = inspectUnifiedDiff(newFileDiff)
    expect(result.ok).toBe(true)
    expect(result.files[0]).toMatchObject({ path: 'apps/web/src/lib/new-util.ts', added: 2 })
  })

  it('rejects patches above the line cap when env cap is set', () => {
    process.env.AUTO_FIX_MAX_LINES = '200'
    try {
      const body = Array.from({ length: 201 }, (_, i) => `+line ${i}`).join('\n')
      const diff = safeDiff
        .replace("+const label = value ?? '—'", body)
        .replace('@@ -1,2 +1,2 @@', '@@ -1,2 +1,202 @@')
      expect(inspectUnifiedDiff(diff).errors).toContain('补丁变更行数超过 200')
    } finally {
      delete process.env.AUTO_FIX_MAX_LINES
    }
  })

  it('has no line cap by default', () => {
    const body = Array.from({ length: 1200 }, (_, i) => `+line ${i}`).join('\n')
    const diff = safeDiff
      .replace("+const label = value ?? '—'", body)
      .replace('@@ -1,2 +1,2 @@', '@@ -1,2 +1,1201 @@')
    expect(inspectUnifiedDiff(diff).ok).toBe(true)
  })

  it('rejects a hunk whose line counts do not match the header', () => {
    // 复现 trim 吃掉末尾空白上下文行的事故：声明 7 行实际只有 6 行
    const corrupted = [
      'diff --git a/apps/web/src/app/v2/boss/assistant/page.tsx b/apps/web/src/app/v2/boss/assistant/page.tsx',
      'index 679da1f..aef26c7 100644',
      '--- a/apps/web/src/app/v2/boss/assistant/page.tsx',
      '+++ b/apps/web/src/app/v2/boss/assistant/page.tsx',
      '@@ -86,7 +86,7 @@ export default function BossAssistantPage() {',
      '           </a>',
      '         </div>',
      '         <p className="text-caption text-gray3 mt-0.5">',
      '-          旧文案',
      '+          新文案',
      '         </p>',
      '       </header>',
      '',
    ].join('\n')
    const result = inspectUnifiedDiff(corrupted)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/hunk 行数与声明不符/)
  })

  it('accepts a hunk with a trailing blank context line', () => {
    const withBlankContext = [
      'diff --git a/apps/web/src/app/v2/boss/assistant/page.tsx b/apps/web/src/app/v2/boss/assistant/page.tsx',
      'index 679da1f..aef26c7 100644',
      '--- a/apps/web/src/app/v2/boss/assistant/page.tsx',
      '+++ b/apps/web/src/app/v2/boss/assistant/page.tsx',
      '@@ -86,7 +86,7 @@ export default function BossAssistantPage() {',
      '           </a>',
      '         </div>',
      '         <p className="text-caption text-gray3 mt-0.5">',
      '-          旧文案',
      '+          新文案',
      '         </p>',
      '       </header>',
      ' ',
      '',
    ].join('\n')
    const result = inspectUnifiedDiff(withBlankContext)
    expect(result.ok).toBe(true)
  })
})

describe('auto-fix mode', () => {
  it('is fail-closed and only enables explicit supported modes', () => {
    expect(isAutoFixModeEnabled({})).toBe(false)
    expect(isAutoFixModeEnabled({ AUTO_FIX_MODE: 'off' })).toBe(false)
    expect(isAutoFixModeEnabled({ AUTO_FIX_MODE: 'auto' })).toBe(false)
    expect(isAutoFixModeEnabled({ AUTO_FIX_MODE: 'suggest' })).toBe(true)
    expect(isAutoFixModeEnabled({ AUTO_FIX_MODE: 'approved_auto' })).toBe(true)
  })

  it('requires both approved_auto and the deployment lock for unattended deployment', () => {
    expect(isApprovedAutoMode({ AUTO_FIX_MODE: 'approved_auto' })).toBe(true)
    expect(isApprovedAutoMode({ AUTO_FIX_MODE: 'suggest' })).toBe(false)
    expect(isAutoDeploymentEnabled({
      AUTO_FIX_MODE: 'approved_auto',
      AUTO_FIX_DEPLOY_ENABLED: 'false',
    })).toBe(false)
    expect(isAutoDeploymentEnabled({
      AUTO_FIX_MODE: 'approved_auto',
      AUTO_FIX_DEPLOY_ENABLED: 'true',
    })).toBe(true)
  })

  it('isCoreApiEnabled is fail-closed and only enables explicit true', () => {
    expect(isCoreApiEnabled({})).toBe(false)
    expect(isCoreApiEnabled({ AUTO_FIX_CORE_API_ENABLED: 'false' })).toBe(false)
    expect(isCoreApiEnabled({ AUTO_FIX_CORE_API_ENABLED: '1' })).toBe(false)
    expect(isCoreApiEnabled({ AUTO_FIX_CORE_API_ENABLED: 'true' })).toBe(true)
  })
})

describe('core API gate (allowCoreBusinessApi option)', () => {
  const diffFor = (file: string) =>
    safeDiff.replaceAll('apps/web/src/app/v2/supply-chain/home/page.tsx', file)

  it('default: rejects core business API paths', () => {
    const result = inspectUnifiedDiff(diffFor('apps/api/src/routes/orders.ts'))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('库存写入/成本核心路径')
  })

  it('allowCoreBusinessApi=true: accepts core business API src paths', () => {
    const result = inspectUnifiedDiff(diffFor('apps/api/src/routes/orders.ts'), { allowCoreBusinessApi: true })
    expect(result.ok).toBe(true)
    expect(result.files[0].path).toBe('apps/api/src/routes/orders.ts')
  })

  it.each([
    'apps/api/src/services/storeInventory.ts',
    'apps/api/src/services/receiptSettlement.ts',
    'apps/api/src/services/receiptDerivatives.ts',
    'apps/api/src/services/inventoryCosting.ts',
  ])('allowCoreBusinessApi=true: accepts core business API file %s', (file) => {
    const result = inspectUnifiedDiff(diffFor(file), { allowCoreBusinessApi: true })
    expect(result.ok).toBe(true)
    expect(result.files[0].path).toBe(file)
  })

  it('allowCoreBusinessApi=true: accepts core business API test paths', () => {
    const result = inspectUnifiedDiff(diffFor('apps/api/tests/inventory.test.ts'), { allowCoreBusinessApi: true })
    expect(result.ok).toBe(true)
  })

  it.each([
    'apps/api/src/routes/auth.ts',
    'apps/api/src/routes/payments.ts',
    'apps/api/src/routes/paymentRequests.ts',
    'apps/api/src/routes/paymentRules.ts',
    'apps/api/src/routes/pettyCash.ts',
    'apps/api/src/routes/invoices.ts',
    'apps/api/src/routes/capital.ts',
    'apps/api/src/routes/payroll.ts',
    'apps/api/src/routes/cmb.ts',
    'apps/api/src/services/finance/report.ts',
    'apps/api/src/services/capital/sync.ts',
    'apps/api/src/services/cmb/sync.ts',
    'apps/api/tests/services/payments.test.ts',
    'packages/db/prisma/schema.prisma',
    'packages/db/prisma/migrations/20990101000000_x/migration.sql',
    '.env.production',
    'package.json',
  ])('allowCoreBusinessApi=true: still rejects permanent redline %s', (file) => {
    const result = inspectUnifiedDiff(diffFor(file), { allowCoreBusinessApi: true })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/红线|白名单/)
  })

  it('non-core API and Web behavior is unchanged with allowCoreBusinessApi=true', () => {
    expect(inspectUnifiedDiff(diffFor('apps/api/src/routes/stores.ts'), { allowCoreBusinessApi: true }).ok).toBe(true)
    expect(inspectUnifiedDiff(safeDiff, { allowCoreBusinessApi: true }).ok).toBe(true)
  })
})

describe('reviewDeploymentPatch（部署策略回归）', () => {
  const coreDiff = safeDiff.replaceAll(
    'apps/web/src/app/v2/supply-chain/home/page.tsx',
    'apps/api/src/routes/orders.ts',
  )
  const financialDiff = safeDiff.replaceAll(
    'apps/web/src/app/v2/supply-chain/home/page.tsx',
    'apps/api/src/routes/payments.ts',
  )

  it('AUTO_FIX_CORE_API_ENABLED 未设置时拒绝核心经营补丁', () => {
    const result = reviewDeploymentPatch(coreDiff, {})
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('库存写入/成本核心路径')
  })

  it('AUTO_FIX_CORE_API_ENABLED=false 时拒绝核心经营补丁', () => {
    const result = reviewDeploymentPatch(coreDiff, { AUTO_FIX_CORE_API_ENABLED: 'false' })
    expect(result.ok).toBe(false)
  })

  it('AUTO_FIX_CORE_API_ENABLED=1（非精确 true）时拒绝核心经营补丁', () => {
    const result = reviewDeploymentPatch(coreDiff, { AUTO_FIX_CORE_API_ENABLED: '1' })
    expect(result.ok).toBe(false)
  })

  it('AUTO_FIX_CORE_API_ENABLED=true（精确值）时放行核心经营补丁', () => {
    const result = reviewDeploymentPatch(coreDiff, { AUTO_FIX_CORE_API_ENABLED: 'true' })
    expect(result.ok).toBe(true)
    expect(result.files[0].path).toBe('apps/api/src/routes/orders.ts')
  })

  it('永久资金红线：即使 AUTO_FIX_CORE_API_ENABLED=true 也始终拒绝', () => {
    const result = reviewDeploymentPatch(financialDiff, { AUTO_FIX_CORE_API_ENABLED: 'true' })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/红线/)
  })

  it('非核心 API 补丁不受开关影响，始终放行', () => {
    const normalDiff = safeDiff.replaceAll(
      'apps/web/src/app/v2/supply-chain/home/page.tsx',
      'apps/api/src/routes/stores.ts',
    )
    expect(reviewDeploymentPatch(normalDiff, {}).ok).toBe(true)
    expect(reviewDeploymentPatch(normalDiff, { AUTO_FIX_CORE_API_ENABLED: 'true' }).ok).toBe(true)
  })
})
