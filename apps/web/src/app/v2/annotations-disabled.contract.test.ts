import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../../..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

describe('页面批注功能已对所有账号下线', () => {
  it('不再渲染批注层，且批注前端组件已移除', () => {
    const layout = read('apps/web/src/app/v2/layout.tsx')

    expect(layout).not.toContain('AnnotationLayer')
    expect(fs.existsSync(path.join(REPO_ROOT, 'apps/web/src/components/annotations/annotation-layer.tsx'))).toBe(false)
  })

  it('不再注册批注 API，且批注路由已移除', () => {
    const apiEntry = read('apps/api/src/index.ts')

    expect(apiEntry).not.toContain('pageAnnotationRoutes')
    expect(apiEntry).not.toContain('/api/page-annotations')
    expect(fs.existsSync(path.join(REPO_ROOT, 'apps/api/src/routes/pageAnnotations.ts'))).toBe(false)
  })

  it('UAT 部署不再开启批注或写入账号白名单', () => {
    const deployScript = read('scripts/deploy-uat.sh')

    expect(deployScript).not.toContain('ANNOTATIONS_ENABLED')
    expect(deployScript).not.toContain('ANNOTATION_ALLOWED_PHONES')
  })
})
