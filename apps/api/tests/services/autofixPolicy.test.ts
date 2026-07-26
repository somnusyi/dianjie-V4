import { describe, expect, it } from 'vitest'
import {
  inspectUnifiedDiff,
  isApprovedAutoMode,
  isAutoDeploymentEnabled,
  isAutoFixModeEnabled,
} from '../../src/services/autofix/policy'

const safeDiff = `diff --git a/apps/web/src/app/v2/supply-chain/home/page.tsx b/apps/web/src/app/v2/supply-chain/home/page.tsx
index 1111111..2222222 100644
--- a/apps/web/src/app/v2/supply-chain/home/page.tsx
+++ b/apps/web/src/app/v2/supply-chain/home/page.tsx
@@ -1,3 +1,3 @@
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
  ])('rejects hard redline or protected path %s', (file) => {
    const diff = safeDiff.replaceAll(
      'apps/web/src/app/v2/supply-chain/home/page.tsx',
      file,
    )
    const result = inspectUnifiedDiff(diff)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/红线|白名单/)
  })

  it('rejects API changes in P1a even when the route might be read-only', () => {
    const result = inspectUnifiedDiff(
      safeDiff.replaceAll(
        'apps/web/src/app/v2/supply-chain/home/page.tsx',
        'apps/api/src/routes/stores.ts',
      ),
    )
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('P1a 白名单外路径: apps/api/src/routes/stores.ts')
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

  it('rejects patches above the line cap', () => {
    const body = Array.from({ length: 201 }, (_, i) => `+line ${i}`).join('\n')
    const diff = safeDiff.replace("+const label = value ?? '—'", body)
    expect(inspectUnifiedDiff(diff).errors).toContain('补丁变更行数超过 200')
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
})
