import { describe, expect, it } from 'vitest'
import { classifyDeploymentFailure } from '../../src/services/autofix/deploymentFailure'

describe('AutoFix deployment failure status', () => {
  it('uses FAILED_ROLLBACK only after rollback and production health both succeed', () => {
    expect(classifyDeploymentFailure('COMPLETED')).toEqual({
      status: 'FAILED_ROLLBACK',
      reason: 'rollback_completed',
      action: '部署失败，自动回滚并通过生产健康检查',
    })
  })

  it('escalates when the rollback itself did not complete', () => {
    expect(classifyDeploymentFailure('FAILED')).toEqual({
      status: 'ESCALATED',
      reason: 'rollback_failed',
      action: '部署失败且自动回滚未完成，已转人工',
    })
  })

  it('does not claim a rollback for a failure before production changed', () => {
    expect(classifyDeploymentFailure('NOT_REQUIRED')).toEqual({
      status: 'ESCALATED',
      reason: 'pre_deploy_failure',
      action: '部署前检查失败，未修改生产，已转人工',
    })
  })
})
