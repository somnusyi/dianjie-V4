import { Prisma, prisma } from '@dianjie/db'
import { resolveTenantWarehouseId } from './defaultWarehouse'

type Decimalish = Prisma.Decimal | string | number | null | undefined

type BalanceRow = {
  productId: string
  inventoryUnit: string
  physicalQty: Decimalish
  reservedQty: Decimalish
  inventoryValue: Decimalish
  averageUnitCost: Decimalish
}

type MovementRow = {
  productId: string
  inventoryUnit: string
  physicalDelta: Decimalish
  reservedDelta: Decimalish
  valueDelta: Decimalish
  physicalAfter: Decimalish
  reservedAfter: Decimalish
  valueAfter: Decimalish
  recordedAt: Date
  id: string
  type: string
}

type ReservationRow = {
  productId: string
  inventoryUnit: string
  inventoryQuantity: Decimalish
  orderStatus?: string
}

type LotRow = {
  productId: string
  inventoryUnit: string
  remainingQty: Decimalish
}

export type WarehouseLedgerAuditIssue = {
  severity: 'BLOCKER' | 'WARNING'
  code: string
  productId: string
  message: string
  expected?: string
  actual?: string
}

function value(input: Decimalish) {
  return new Prisma.Decimal(input || 0)
}

function add(map: Map<string, Prisma.Decimal>, key: string, amount: Decimalish) {
  map.set(key, (map.get(key) || new Prisma.Decimal(0)).plus(value(amount)))
}

function differs(left: Decimalish, right: Decimalish, decimalPlaces: number) {
  return !value(left).toDecimalPlaces(decimalPlaces).equals(value(right).toDecimalPlaces(decimalPlaces))
}

export function buildWarehouseLedgerAudit(input: {
  balances: BalanceRow[]
  movements: MovementRow[]
  activeReservations: ReservationRow[]
  lots: LotRow[]
  requiredProducts: Array<{ id: string; unitConversionStatus: string }>
}) {
  const issues: WarehouseLedgerAuditIssue[] = []
  const movementPhysical = new Map<string, Prisma.Decimal>()
  const movementReserved = new Map<string, Prisma.Decimal>()
  const movementValue = new Map<string, Prisma.Decimal>()
  const reservationQuantity = new Map<string, Prisma.Decimal>()
  const lotQuantity = new Map<string, Prisma.Decimal>()
  const latestMovement = new Map<string, MovementRow>()
  const unitsByProduct = new Map<string, Set<string>>()
  const rememberUnit = (productId: string, inventoryUnit: string) => {
    const units = unitsByProduct.get(productId) || new Set<string>()
    units.add(inventoryUnit)
    unitsByProduct.set(productId, units)
  }

  for (const movement of input.movements) {
    add(movementPhysical, movement.productId, movement.physicalDelta)
    add(movementReserved, movement.productId, movement.reservedDelta)
    add(movementValue, movement.productId, movement.valueDelta)
    rememberUnit(movement.productId, movement.inventoryUnit)
    const current = latestMovement.get(movement.productId)
    if (!current
      || movement.recordedAt > current.recordedAt
      || (movement.recordedAt.getTime() === current.recordedAt.getTime() && movement.id > current.id)) {
      latestMovement.set(movement.productId, movement)
    }
  }
  for (const reservation of input.activeReservations) {
    add(reservationQuantity, reservation.productId, reservation.inventoryQuantity)
    rememberUnit(reservation.productId, reservation.inventoryUnit)
  }
  for (const lot of input.lots) {
    add(lotQuantity, lot.productId, lot.remainingQty)
    rememberUnit(lot.productId, lot.inventoryUnit)
  }
  for (const balance of input.balances) rememberUnit(balance.productId, balance.inventoryUnit)

  const balanceByProduct = new Map(input.balances.map(row => [row.productId, row]))
  const baselinedProducts = new Set(input.movements
    .filter(row => row.type === 'OPENING_BALANCE')
    .map(row => row.productId))
  const productIds = new Set([
    ...balanceByProduct.keys(),
    ...movementPhysical.keys(),
    ...reservationQuantity.keys(),
    ...lotQuantity.keys(),
  ])

  const issue = (
    severity: WarehouseLedgerAuditIssue['severity'],
    code: string,
    productId: string,
    message: string,
    expected?: Decimalish,
    actual?: Decimalish,
    decimalPlaces = 6,
  ) => issues.push({
    severity,
    code,
    productId,
    message,
    ...(expected === undefined ? {} : { expected: value(expected).toFixed(decimalPlaces) }),
    ...(actual === undefined ? {} : { actual: value(actual).toFixed(decimalPlaces) }),
  })

  if (input.requiredProducts.length === 0) {
    issue('BLOCKER', 'BASELINE_SCOPE_EMPTY', '*', '没有可核对的启用商品，不能切换严格库存')
  }
  for (const product of input.requiredProducts) {
    if (!balanceByProduct.has(product.id) || !baselinedProducts.has(product.id)) {
      issue('BLOCKER', 'SKU_BASELINE_MISSING', product.id, '启用商品尚未完成显式实盘建账（零库存也必须确认）')
    }
    if (product.unitConversionStatus !== 'VERIFIED') {
      issue('BLOCKER', 'UNIT_CONVERSION_UNVERIFIED', product.id, '商品四单位换算尚未核验，不能进入严格库存')
    }
  }

  for (const productId of productIds) {
    const balance = balanceByProduct.get(productId)
    if (!balance) {
      issue('BLOCKER', 'BALANCE_MISSING', productId, '存在库存流水、预占或批次，但缺少库存余额')
      continue
    }
    const physicalFromMovements = movementPhysical.get(productId) || new Prisma.Decimal(0)
    const reservedFromMovements = movementReserved.get(productId) || new Prisma.Decimal(0)
    const valueFromMovements = movementValue.get(productId) || new Prisma.Decimal(0)
    const activeReserved = reservationQuantity.get(productId) || new Prisma.Decimal(0)
    const remainingLots = lotQuantity.get(productId) || new Prisma.Decimal(0)

    if (value(balance.physicalQty).lt(0)) {
      issue('BLOCKER', 'NEGATIVE_PHYSICAL', productId, '物理库存为负，影子期可观察但不能切严格模式', 0, balance.physicalQty)
    }
    if (value(balance.reservedQty).lt(0)) {
      issue('BLOCKER', 'NEGATIVE_RESERVED', productId, '预占库存为负', 0, balance.reservedQty)
    }
    if (value(balance.reservedQty).gt(balance.physicalQty || 0)) {
      issue('BLOCKER', 'RESERVED_EXCEEDS_PHYSICAL', productId, '预占数量超过物理库存', balance.physicalQty, balance.reservedQty)
    }
    if (value(balance.inventoryValue).lt(0)) {
      issue('BLOCKER', 'NEGATIVE_VALUE', productId, '库存金额为负', 0, balance.inventoryValue, 4)
    }
    if (value(balance.physicalQty).isZero() && !value(balance.inventoryValue).isZero()) {
      issue('BLOCKER', 'ZERO_QTY_NONZERO_VALUE', productId, '物理数量为0时库存金额必须为0', 0, balance.inventoryValue, 4)
    }
    if (value(balance.physicalQty).isZero() && !value(balance.averageUnitCost).isZero()) {
      issue('BLOCKER', 'ZERO_QTY_NONZERO_AVERAGE_COST', productId, '物理数量为0时移动平均成本必须为0', 0, balance.averageUnitCost)
    }
    if (value(balance.physicalQty).gt(0)) {
      const expectedAverage = value(balance.inventoryValue).div(value(balance.physicalQty)).toDecimalPlaces(6)
      if (differs(expectedAverage, balance.averageUnitCost, 6)) {
        issue('BLOCKER', 'AVERAGE_COST_MISMATCH', productId, '移动平均成本与库存数量、金额不一致', expectedAverage, balance.averageUnitCost)
      }
    }
    if (differs(physicalFromMovements, balance.physicalQty, 6)) {
      issue('BLOCKER', 'PHYSICAL_MOVEMENT_MISMATCH', productId, '物理余额与流水累计不一致', physicalFromMovements, balance.physicalQty)
    }
    if (differs(reservedFromMovements, balance.reservedQty, 6)) {
      issue('BLOCKER', 'RESERVED_MOVEMENT_MISMATCH', productId, '预占余额与流水累计不一致', reservedFromMovements, balance.reservedQty)
    }
    if (differs(valueFromMovements, balance.inventoryValue, 4)) {
      issue('BLOCKER', 'VALUE_MOVEMENT_MISMATCH', productId, '库存金额与流水累计不一致', valueFromMovements, balance.inventoryValue, 4)
    }
    if (differs(activeReserved, balance.reservedQty, 6)) {
      issue('BLOCKER', 'ACTIVE_RESERVATION_MISMATCH', productId, '活动预占单据与预占余额不一致', activeReserved, balance.reservedQty)
    }
    const invalidReservation = input.activeReservations.find(row => row.productId === productId && row.orderStatus && row.orderStatus !== 'CONFIRMED')
    if (invalidReservation) {
      issues.push({
        severity: 'BLOCKER',
        code: 'ACTIVE_RESERVATION_ORDER_STATUS_INVALID',
        productId,
        message: `活动预占对应订单状态为 ${invalidReservation.orderStatus}，应为 CONFIRMED`,
      })
    }
    if (differs(remainingLots, balance.physicalQty, 6)) {
      issue('BLOCKER', 'LOT_BALANCE_MISMATCH', productId, '批次剩余数量与物理余额不一致', remainingLots, balance.physicalQty)
    }

    const latest = latestMovement.get(productId)
    if (latest) {
      if (differs(latest.physicalAfter, balance.physicalQty, 6)
        || differs(latest.reservedAfter, balance.reservedQty, 6)
        || differs(latest.valueAfter, balance.inventoryValue, 4)) {
        issue('BLOCKER', 'LATEST_MOVEMENT_AFTER_MISMATCH', productId, '最后一笔流水的变更后余额与当前余额不一致')
      }
    }
    const units = unitsByProduct.get(productId) || new Set([balance.inventoryUnit])
    if (units.size > 1) {
      issues.push({
        severity: 'BLOCKER',
        code: 'INVENTORY_UNIT_MISMATCH',
        productId,
        message: `库存账存在多个库存单位：${[...units].join('、')}`,
      })
    }
  }

  const blockerCount = issues.filter(row => row.severity === 'BLOCKER').length
  return {
    ledgerConsistent: issues.every(row => ![
      'PHYSICAL_MOVEMENT_MISMATCH',
      'RESERVED_MOVEMENT_MISMATCH',
      'VALUE_MOVEMENT_MISMATCH',
      'ACTIVE_RESERVATION_MISMATCH',
      'LOT_BALANCE_MISMATCH',
      'LATEST_MOVEMENT_AFTER_MISMATCH',
      'INVENTORY_UNIT_MISMATCH',
    ].includes(row.code)),
    readyForStrict: blockerCount === 0 && productIds.size > 0,
    blockerCount,
    warningCount: issues.length - blockerCount,
    checkedSku: productIds.size,
    issues,
  }
}

export async function auditWarehouseLedger(tenantId: string) {
  const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
  const [warehouse, balances, movements, activeReservations, lots, requiredProducts] = await Promise.all([
    prisma.warehouse.findFirstOrThrow({
      where: { id: warehouseId, tenantId },
      select: { id: true, code: true, name: true, inventoryMode: true, inventoryActivatedAt: true },
    }),
    prisma.warehouseLedgerBalance.findMany({ where: { tenantId, warehouseId } }),
    prisma.warehouseLedgerMovement.findMany({
      where: { tenantId, warehouseId },
      select: {
        id: true, type: true, productId: true, inventoryUnit: true, physicalDelta: true, reservedDelta: true,
        valueDelta: true, physicalAfter: true, reservedAfter: true, valueAfter: true, recordedAt: true,
      },
    }),
    prisma.warehouseLedgerReservation.findMany({
      where: { tenantId, warehouseId, status: 'ACTIVE' },
      select: {
        productId: true,
        inventoryUnit: true,
        inventoryQuantity: true,
        purchaseOrder: { select: { status: true } },
      },
    }),
    prisma.warehouseLedgerLot.findMany({
      where: { tenantId, warehouseId, remainingQty: { gt: 0 } },
      select: { productId: true, inventoryUnit: true, remainingQty: true },
    }),
    prisma.product.findMany({
      where: {
        tenantId,
        status: 'ENABLED',
        OR: [
          { supplier: { sourceType: 'HEADQ_WAREHOUSE' } },
          { warehouseLedgerBalances: { some: { warehouseId } } },
        ],
      },
      select: { id: true, unitConversionStatus: true },
    }),
  ])
  return {
    warehouse,
    ...buildWarehouseLedgerAudit({
      balances,
      movements,
      activeReservations: activeReservations.map(row => ({
        productId: row.productId,
        inventoryUnit: row.inventoryUnit,
        inventoryQuantity: row.inventoryQuantity,
        orderStatus: row.purchaseOrder.status,
      })),
      lots,
      requiredProducts,
    }),
  }
}
