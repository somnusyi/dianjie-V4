import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./supply-chain/procurement/page.tsx', import.meta.url), 'utf8')
const schema = readFileSync(resolve(process.cwd(), '../../packages/db/prisma/schema.prisma'), 'utf8')

describe('U-1 合同复用与下单直通', () => {
  it('沿用现有一份合同对多张采购单关系，不重造数据模型', () => {
    expect(schema).toContain('purchaseOrders UpstreamPurchaseOrder[]')
    expect(schema).toContain('contract  UpstreamSupplierContract?')
  })

  it('唯一生效合同自动带出，只有多份时显示选择器', () => {
    expect(page).toContain('supplierActiveContracts.length === 1')
    expect(page).toContain('supplierActiveContracts.length > 1')
    expect(page).toContain('已自动带出合同')
    expect(page).toContain('已生效合同（多份请选）')
  })

  it('无合同时在采购单内快速创建并带出供货价', () => {
    expect(page).toContain('快速建合同')
    expect(page).toContain('await loadSources(orderSupplierId)')
    expect(page).toContain('source.quotedUnitPrice == null')
    expect(page).toContain('供应商与现行供货价已带出')
  })

  it('合同启用使用 ConfirmSheet，无货源可直达商品供货关系', () => {
    expect(page).toContain('onClick={() => confirmContractActivation(contract)}')
    expect(page).not.toContain('window.confirm(\n                              "确认合同价格及换算无误并正式启用？"')
    expect(page).toContain('去商品管理维护供货关系与价格')
  })

  it('切换供应商时只接受最后一次货源响应', () => {
    expect(page).toContain('const requestId = ++sourceRequestRef.current')
    expect(page.match(/requestId !== sourceRequestRef\.current/g)).toHaveLength(2)
  })

  it('合同创建发送稳定幂等键，仅成功后换键', () => {
    expect(page).toContain('idempotencyKey: contractRequestKeyRef.current')
    expect(page).toContain('contractRequestKeyRef.current = clientRequestId()')
    expect(schema).toContain('requestFingerprint String?')
    expect(schema).toContain('@@unique([tenantId, idempotencyKey])')
  })
})
