export type DeploymentRecoveryState = 'NOT_REQUIRED' | 'COMPLETED' | 'FAILED'

export interface DeploymentFailureOutcome {
  status: 'FAILED_ROLLBACK' | 'ESCALATED'
  reason: 'pre_deploy_failure' | 'rollback_completed' | 'rollback_failed'
  action: string
}

export function classifyDeploymentFailure(
  recovery: DeploymentRecoveryState,
): DeploymentFailureOutcome {
  if (recovery === 'COMPLETED') {
    return {
      status: 'FAILED_ROLLBACK',
      reason: 'rollback_completed',
      action: '部署失败，自动回滚并通过生产健康检查',
    }
  }
  if (recovery === 'FAILED') {
    return {
      status: 'ESCALATED',
      reason: 'rollback_failed',
      action: '部署失败且自动回滚未完成，已转人工',
    }
  }
  return {
    status: 'ESCALATED',
    reason: 'pre_deploy_failure',
    action: '部署前检查失败，未修改生产，已转人工',
  }
}
