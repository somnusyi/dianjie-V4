/**
 * 文档审批路由 + 阈值规则
 *
 * 给每种 DocumentType 决定：
 *  - 审批步骤序列（哪些角色 + 顺序）
 *  - 阈值（金额低于此则跳过部分步骤 / 自动批准）
 *
 * 一处改全站生效。新增类型只需在 ROUTES 里加一行。
 */
export type Role =
  | 'FINANCE' | 'ADMIN' | 'SUPER_ADMIN'
  | 'CHEF_DIRECTOR' | 'CHEF'
  | 'MANAGER' | 'KITCHEN_LEAD'

export type DocumentType =
  | 'PETTY_CASH' | 'REIMBURSEMENT' | 'PURCHASE_FOOD_REGULAR' | 'PURCHASE_FOOD_OVER'
  | 'PURCHASE_NON_FOOD' | 'CONTRACT' | 'PRICE_ADJUSTMENT' | 'NEW_SUPPLIER'
  | 'NEW_DISH' | 'STORE_TRANSFER' | 'MARKETING_BUDGET' | 'PERSONNEL_PAY'

export interface RoutePlan {
  steps: Role[]                 // 待审批角色顺序
  autoApprove: boolean          // 阈值内 → 自动通过, 不走 steps
  thresholdRule?: string        // 文字描述（用于 UI 显示）
  isOverThreshold: boolean      // 是否超阈值
}

/**
 * 主决策：根据类型 + 金额 → 步骤
 *  - 备用金 ≤ ¥3K：财务自动批
 *  - 报销 ≤ ¥5K：财务自动批
 *  - 大额采购 > ¥3K：财务初审 → 老板
 *  - 调价 / 新供应商 / 新菜品：直送总厨
 *  - 营销预算 / 调薪 / 调拨：财务 → 老板
 *  - 默认：财务 → 老板
 */
export function routeFor(type: DocumentType, amount: number): RoutePlan {
  const a = Number(amount || 0)

  switch (type) {
    case 'PETTY_CASH':
      return a <= 3000
        ? { steps: [], autoApprove: true, thresholdRule: '备用金 ≤ ¥3K 财务自动批准', isOverThreshold: false }
        : { steps: ['FINANCE', 'ADMIN'], autoApprove: false, thresholdRule: '备用金 > ¥3K 走财务+老板', isOverThreshold: true }

    case 'REIMBURSEMENT':
      return a <= 5000
        ? { steps: [], autoApprove: true, thresholdRule: '报销 ≤ ¥5K 财务自动批准', isOverThreshold: false }
        : { steps: ['FINANCE', 'ADMIN'], autoApprove: false, thresholdRule: '报销 > ¥5K 走财务+老板', isOverThreshold: true }

    case 'PURCHASE_FOOD_REGULAR':
      return { steps: [], autoApprove: true, thresholdRule: '集团价 + 签约 ≤ ¥3K 免审', isOverThreshold: false }

    case 'PURCHASE_FOOD_OVER':
    case 'PURCHASE_NON_FOOD':
      return { steps: ['FINANCE', 'ADMIN'], autoApprove: false, thresholdRule: `${type === 'PURCHASE_FOOD_OVER' ? '食材' : '非食材'}采购 > ¥3K`, isOverThreshold: true }

    case 'PRICE_ADJUSTMENT':
    case 'NEW_SUPPLIER':
    case 'NEW_DISH':
      return { steps: ['CHEF_DIRECTOR'], autoApprove: false, thresholdRule: '调价/新供应商/新菜品 直送总厨', isOverThreshold: false }

    case 'CONTRACT':
    case 'STORE_TRANSFER':
    case 'MARKETING_BUDGET':
    case 'PERSONNEL_PAY':
      return { steps: ['FINANCE', 'ADMIN'], autoApprove: false, thresholdRule: '走财务+老板审批', isOverThreshold: a > 10000 }

    default:
      return { steps: ['FINANCE', 'ADMIN'], autoApprove: false, thresholdRule: '默认走财务+老板', isOverThreshold: false }
  }
}
