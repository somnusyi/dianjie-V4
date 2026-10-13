import { prisma } from '@dianjie/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { editWarehouseDoc, ensureWarehouseDoc, confirmWarehouseDoc, unconfirmWarehouseDoc } from '../../src/services/warehouseDocs'
import { recordBatchManualWarehouseInbound, recordBatchManualWarehouseOutbound, reverseManualWarehouseInbound } from '../../src/services/warehouseLedger'
import { currentInboundValues } from '../../src/services/warehouseMovementDisplay'

let tenantId: string, warehouseId: string, userId: string, supplierId: string
let seq = 0
const date = new Date('2026-10-10T02:00:00Z')
// Retain this uniquely named synthetic tenant as an audit fixture; never use the mouse tenant.
beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: 'DJ022隔离原子性测试', slug: `dj022-atomic-${Date.now()}` } })
  tenantId = tenant.id
  warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'ATOMIC', name: '事务测试仓', isDefault: true, inventoryMode: 'SHADOW' } })).id
  userId = (await prisma.user.create({ data: { tenantId, name: '事务测试夹具', email: 'atomic@local.invalid', role: 'SUPPLY_CHAIN', password: 'unusable-fixture' } })).id
  supplierId = (await prisma.supplier.create({ data: { tenantId, name: '事务夹具供应商', no: 'ATOMIC', status: 'ENABLED', businessScopes: ['WAREHOUSE_UPSTREAM'] } })).id
})
afterAll(() => prisma.$disconnect())
async function fixture(batches: Array<string | null>) {
  const products = []
  for (const _ of batches) products.push(await prisma.product.create({ data: { tenantId, code: `AT-${++seq}`, name: `事务商品${seq}`, price: 2, unit: 'kg', purchaseUnit: 'kg', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED' } }))
  const result = await recordBatchManualWarehouseInbound({ tenantId, userId, supplierId, effectiveAt: date, idempotencyKey: `fixture-${seq}`, items: products.map((p, i) => ({ productId: p.id, purchaseQuantity: 1, totalAmount: 2, batchNo: batches[i] })) })
  const { doc } = await ensureWarehouseDoc({ tenantId, userId, supplierId, type: 'MANUAL_INBOUND', warehouseId, effectiveAt: date, idempotencyKey: `fixture-doc-${seq}`, lines: products.map((p, i) => ({ productId: p.id, productName: p.name, quantity: 1, unit: 'kg', unitPrice: 2, amount: 2, inventoryQuantity: 1, inventoryUnit: 'kg', movementId: result.movements[i].id, batchNo: batches[i] })) })
  const lines = await prisma.warehouseDocLine.findMany({ where: { docId: doc.id }, orderBy: { lineNo: 'asc' } })
  return { doc, lines, products }
}
async function snapshot(productIds: string[], docId: string) {
  return JSON.stringify({
    balances: await prisma.warehouseLedgerBalance.findMany({ where: { tenantId, productId: { in: productIds } }, orderBy: { productId: 'asc' } }),
    movements: await prisma.warehouseLedgerMovement.findMany({ where: { tenantId, productId: { in: productIds } }, orderBy: { id: 'asc' } }),
    lots: await prisma.warehouseLedgerLot.findMany({ where: { tenantId, productId: { in: productIds } }, orderBy: { id: 'asc' } }),
    allocations: await prisma.warehouseLedgerLotAllocation.findMany({ where: { tenantId, productId: { in: productIds } }, orderBy: { id: 'asc' } }),
    doc: await prisma.warehouseDoc.findUnique({ where: { id: docId }, include: { lines: { orderBy: { lineNo: 'asc' } }, logs: { orderBy: { id: 'asc' } } } }),
    opLogs: await prisma.opLog.count({ where: { tenantId } }),
  })
}
describe('DJ022 document edits are one transaction', () => {
  it('rejects duplicate outbound line IDs before any header, document or ledger change', async () => {
    const { products } = await fixture([null])
    const posted = await recordBatchManualWarehouseOutbound({tenantId,userId,warehouseId,effectiveAt:date,idempotencyKey:`duplicate-out-${seq}`,reason:'合成重复行接口验收',items:[{productId:products[0].id,inventoryQuantity:.5}]})
    const {doc} = await ensureWarehouseDoc({tenantId,userId,type:'MANUAL_OUTBOUND',warehouseId,effectiveAt:date,idempotencyKey:`duplicate-out-doc-${seq}`,reason:'合成重复行接口验收',lines:[{productId:products[0].id,productName:products[0].name,quantity:.5,unit:'kg',unitPrice:2,amount:1,inventoryQuantity:.5,inventoryUnit:'kg',movementId:posted.movements[0].id}]})
    const line=await prisma.warehouseDocLine.findFirstOrThrow({where:{docId:doc.id}})
    const before=await snapshot(products.map(p=>p.id),doc.id)
    await expect(editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'重复行整笔拒绝',note:'不能保存的备注',lines:[{lineId:line.id,amount:1.2},{lineId:line.id,amount:1.4}]})).rejects.toThrow('同一单据行不能重复提交')
    expect(await snapshot(products.map(p=>p.id),doc.id)).toBe(before)
  })
  it('serializes concurrent edits with confirmation without changing a locked document', async () => {
    const { doc, lines, products } = await fixture([null])
    const [edited] = await Promise.allSettled([
      editWarehouseDoc({ tenantId, userId, docId: doc.id, editReason: '审核改单竞态测试', lines: [{ lineId: lines[0].id, amount: 3 }] }),
      confirmWarehouseDoc({ tenantId, userId, docId: doc.id }),
    ])
    const current = await prisma.warehouseDoc.findUniqueOrThrow({ where: { id: doc.id } })
    const balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, productId: products[0].id } })
    expect(current.status).toBe('CONFIRMED')
    expect(Number(balance.inventoryValue)).toBe(Number(current.totalAmount))
    expect(Number(current.totalAmount)).toBe(edited.status === 'fulfilled' ? 3 : 2)
    if (edited.status === 'rejected') expect(edited.reason.message).toContain('只有未审核')
    expect(await prisma.warehouseDocLog.count({ where: { docId: doc.id, action: 'EDIT' } })).toBe(edited.status === 'fulfilled' ? 1 : 0)
    expect(await prisma.warehouseDocLog.count({ where: { docId: doc.id, action: 'CONFIRM' } })).toBe(1)
  })
  it('applies two simultaneous identical edit requests only once', async () => {
    const { doc, lines, products } = await fixture([null])
    const input = { tenantId, userId, docId: doc.id, editReason: '重复提交并发复验', lines: [{ lineId: lines[0].id, amount: 3 }] }
    const results = await Promise.all([editWarehouseDoc(input), editWarehouseDoc(input)])
    expect(results.filter(r => r.changed)).toHaveLength(1)
    expect(await prisma.warehouseDocLog.count({ where: { docId: doc.id, action: 'EDIT' } })).toBe(1)
    expect(Number((await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, productId: products[0].id } })).inventoryValue)).toBe(3)
  })
  it('concurrent confirmation and unconfirmation each write only one state transition log', async () => {
    const { doc } = await fixture([null])
    const results = await Promise.all([1, 2].map(() => confirmWarehouseDoc({ tenantId, userId, docId: doc.id })))
    expect(results.filter(r => r.changed)).toHaveLength(1)
    expect(await prisma.warehouseDocLog.count({ where: { docId: doc.id, action: 'CONFIRM' } })).toBe(1)
    const returned = await Promise.allSettled([1, 2].map(() => unconfirmWarehouseDoc({ tenantId, userId, docId: doc.id, reason: '并发反审核验收' })))
    expect(returned.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await prisma.warehouseDocLog.count({ where: { docId: doc.id, action: 'UNCONFIRM' } })).toBe(1)
  })

  it('projects current inbound cost after repricing and agrees with full reversal', async () => {
    const { doc, lines, products } = await fixture([null])
    for (const amount of [4, 5]) await editWarehouseDoc({ tenantId, userId, docId: doc.id, editReason: '冲销提示成本复验', lines: [{ lineId: lines[0].id, amount }] })
    const original = await prisma.warehouseLedgerMovement.findUniqueOrThrow({ where: { id: lines[0].movementId! } })
    const values = await currentInboundValues(prisma, tenantId, warehouseId, [original])
    expect(Number(original.valueDelta)).toBe(2)
    expect(Number(values.get(original.id))).toBe(5)
    const reverse = await reverseManualWarehouseInbound({ tenantId, userId, movementId: original.id, reason: '提示成本对应实际冲销', idempotencyKey: `display-reverse-${doc.id}` })
    expect(Number(reverse.movement.valueDelta)).toBe(-5)
    const balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, productId: products[0].id } })
    expect(Number(balance.inventoryValue)).toBe(0)
  })
  it('rolls back amount and reversal when re-post encounters an existing batch', async () => {
    const { doc, lines, products } = await fixture([null])
    await recordBatchManualWarehouseInbound({tenantId,userId,supplierId,effectiveAt:date,idempotencyKey:`outside-${doc.id}`,items:[{productId:products[0].id,purchaseQuantity:1,totalAmount:2,batchNo:'COLLISION-ONE'}]})
    const before = await snapshot(products.map(p => p.id), doc.id)
    await expect(editWarehouseDoc({ tenantId, userId, docId: doc.id, editReason: '批次冲突回滚', lines: [{ lineId: lines[0].id, quantity: 2, amount: 3, batchNo:'COLLISION-ONE' }] })).rejects.toThrow('批次号已存在')
    expect(await snapshot(products.map(p => p.id), doc.id)).toBe(before)
  })
  it('rolls back a valid first line when a later line fails', async () => {
    const { doc, lines, products } = await fixture(['FIRST-REVISION', null])
    await recordBatchManualWarehouseInbound({tenantId,userId,supplierId,effectiveAt:date,idempotencyKey:`outside-${doc.id}`,items:[{productId:products[1].id,purchaseQuantity:1,totalAmount:2,batchNo:'COLLISION-TWO'}]})
    const before = await snapshot(products.map(p => p.id), doc.id)
    await expect(editWarehouseDoc({ tenantId, userId, docId: doc.id, editReason: '第二行冲突回滚', lines: [{ lineId: lines[0].id, quantity:2, amount: 3 }, { lineId: lines[1].id, quantity: 2, amount: 3, batchNo:'COLLISION-TWO' }] })).rejects.toThrow('批次号已存在')
    expect(await snapshot(products.map(p => p.id), doc.id)).toBe(before)
  })
  it('keeps the same business batch number in new immutable lot revisions for quantity and amount changes',async()=>{
    const {doc,lines,products}=await fixture(['KEEP-REVISION'])
    const original=await prisma.warehouseLedgerLot.findUniqueOrThrow({where:{sourceMovementId:lines[0].movementId!}})
    const first={tenantId,userId,docId:doc.id,editReason:'保留原批次改数量金额',lines:[{lineId:lines[0].id,quantity:2,amount:3}]}
    expect((await editWarehouseDoc(first)).changed).toBe(true)
    expect((await editWarehouseDoc(first)).changed).toBe(false)
    await editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'保留原批次只改金额',lines:[{lineId:lines[0].id,amount:5}]})
    const lots=await prisma.warehouseLedgerLot.findMany({where:{tenantId,productId:products[0].id},orderBy:{batchRevision:'asc'}})
    expect(lots.map(l=>l.batchNo)).toEqual(['KEEP-REVISION','KEEP-REVISION','KEEP-REVISION'])
    expect(lots.map(l=>l.batchRevision)).toEqual([1,2,3])
    expect(lots.map(l=>Number(l.remainingQty))).toEqual([0,0,2])
    expect(lots[0]).toMatchObject({id:original.id,sourceMovementId:original.sourceMovementId,initialQty:original.initialQty,inventoryUnitCost:original.inventoryUnitCost})
    expect(lots[1].replacesLotId).toBe(lots[0].id);expect(lots[2].replacesLotId).toBe(lots[1].id)
    expect(await prisma.warehouseLedgerLotAllocation.count({where:{tenantId,lotId:{in:lots.slice(0,2).map(l=>l.id)}}})).toBe(2)
    const balance=await prisma.warehouseLedgerBalance.findFirstOrThrow({where:{tenantId,productId:products[0].id}})
    expect(Number(balance.physicalQty)).toBe(2);expect(Number(balance.inventoryValue)).toBe(5)
    expect(await prisma.warehouseDocLog.count({where:{docId:doc.id,action:'EDIT'}})).toBe(2)
    await expect(recordBatchManualWarehouseInbound({tenantId,userId,supplierId,effectiveAt:date,idempotencyKey:`ordinary-duplicate-${doc.id}`,items:[{productId:products[0].id,purchaseQuantity:1,totalAmount:2,batchNo:'KEEP-REVISION'}]})).rejects.toThrow('批次号已存在')
  })
  it('rejects revising a batch with actual later consumption and leaves all records unchanged',async()=>{
    const {doc,lines,products}=await fixture(['USED-REVISION'])
    await recordBatchManualWarehouseOutbound({tenantId,userId,warehouseId,effectiveAt:new Date(),idempotencyKey:`used-${doc.id}`,reason:'隔离后续出库',items:[{productId:products[0].id,inventoryQuantity:.5}]})
    const before=await snapshot(products.map(p=>p.id),doc.id)
    await expect(editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'已消耗批次修订拒绝',lines:[{lineId:lines[0].id,quantity:2,amount:3}]})).rejects.toThrow('已有出库消耗')
    expect(await snapshot(products.map(p=>p.id),doc.id)).toBe(before)
    for(const batchNo of ['OTHER-NUMBER',null]){
      await expect(editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'改号不能绕过已用批次',lines:[{lineId:lines[0].id,amount:3,batchNo}]})).rejects.toThrow('已有指定批次号必须保留')
      expect(await snapshot(products.map(p=>p.id),doc.id)).toBe(before)
    }
  })
  it('binds revision replay to authoritative amount even when rounded unit prices are equal',async()=>{
    const {doc,lines,products}=await fixture(['EXACT-AMOUNT-REVISION'])
    await editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'批次权威金额请求',lines:[{lineId:lines[0].id,quantity:100,amount:100.001}]})
    const current=await prisma.warehouseDocLine.findUniqueOrThrow({where:{id:lines[0].id}})
    const movement=await prisma.warehouseLedgerMovement.findUniqueOrThrow({where:{id:current.movementId!}})
    const input={tenantId,userId,warehouseId,supplierId,effectiveAt:date,sourceName:movement.sourceName,note:movement.note,idempotencyKey:movement.sourceId!,items:[{productId:products[0].id,purchaseQuantity:100,unitPrice:100.001/100,totalAmount:100.001,batchNo:'EXACT-AMOUNT-REVISION'}]}
    const before=await snapshot(products.map(p=>p.id),doc.id)
    expect((await prisma.$transaction(tx=>recordBatchManualWarehouseInbound(input,tx,{movementId:lines[0].movementId!}))).replayed).toBe(true)
    await expect(prisma.$transaction(tx=>recordBatchManualWarehouseInbound({...input,items:[{...input.items[0],unitPrice:100.002/100,totalAmount:100.002}]},tx,{movementId:lines[0].movementId!}))).rejects.toThrow('同一幂等键不能')
    expect(await snapshot(products.map(p=>p.id),doc.id)).toBe(before)
  })
  it('keeps the original warehouse when the default warehouse changes before a batch revision',async()=>{
    const {doc,lines,products}=await fixture(['WAREHOUSE-REVISION'])
    await prisma.warehouse.update({where:{id:warehouseId},data:{isDefault:false}})
    const other=await prisma.warehouse.create({data:{tenantId,code:'CHANGED-DEFAULT',name:'另一个默认仓',isDefault:true,inventoryMode:'SHADOW'}})
    try{
      await editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'默认仓变化保持原仓',lines:[{lineId:lines[0].id,quantity:2,amount:3}]})
      const lots=await prisma.warehouseLedgerLot.findMany({where:{tenantId,productId:products[0].id}})
      expect(lots).toHaveLength(2);expect(lots.every(l=>l.warehouseId===warehouseId)).toBe(true)
      expect(await prisma.warehouseLedgerBalance.count({where:{tenantId,warehouseId:other.id,productId:products[0].id}})).toBe(0)
      expect(Number((await prisma.warehouseLedgerBalance.findFirstOrThrow({where:{tenantId,warehouseId,productId:products[0].id}})).physicalQty)).toBe(2)
    }finally{await prisma.warehouse.update({where:{id:other.id},data:{isDefault:false}});await prisma.warehouse.update({where:{id:warehouseId},data:{isDefault:true}})}
  })
  it('does not create another edit version when full date fields are unchanged',async()=>{
    const {doc,lines}=await fixture(['DATES-NOOP'])
    const before=await snapshot(lines.map(l=>l.productId),doc.id)
    const result=await editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'完整表单无变更重复保存',lines:[{lineId:lines[0].id,quantity:1,amount:2,batchNo:'DATES-NOOP',manufactureDate:null,expiryDate:null}]})
    expect(result.changed).toBe(false);expect(await snapshot(lines.map(l=>l.productId),doc.id)).toBe(before)
  })
  it('counts amount once when both quantity and amount change and replays as no-op', async () => {
    const { doc, lines, products } = await fixture([null])
    const input = { tenantId, userId, docId: doc.id, editReason: '数量金额同时修改', lines: [{ lineId: lines[0].id, quantity: 2, amount: 3 }] }
    const result = await editWarehouseDoc(input)
    expect(Number(result.doc.totalAmount)).toBe(3)
    const balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, productId: products[0].id } })
    expect([Number(balance.physicalQty), Number(balance.inventoryValue)]).toEqual([2, 3])
    const before = await snapshot(products.map(p => p.id), doc.id)
    expect((await editWarehouseDoc(input)).changed).toBe(false)
    expect(await snapshot(products.map(p => p.id), doc.id)).toBe(before)
  })
  it('repeated repricing and then reversal remove the current amount exactly', async () => {
    const { doc, lines, products } = await fixture([null])
    for (const amount of [3, 4]) await editWarehouseDoc({ tenantId, userId, docId: doc.id, editReason: '连续改价测试', lines: [{ lineId: lines[0].id, amount }] })
    const balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, productId: products[0].id } })
    expect(Number(balance.inventoryValue)).toBe(4)
    await reverseManualWarehouseInbound({ tenantId, userId, movementId: lines[0].movementId!, reason: '改价后整笔冲销', idempotencyKey: `reverse-${doc.id}` })
    const after = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, productId: products[0].id } })
    expect([Number(after.physicalQty), Number(after.inventoryValue)]).toEqual([0, 0])
  })
  it('advances edit keys for consecutive quantity changes and multiple repriced lines', async () => {
    const { doc, lines, products } = await fixture([null, null])
    for (const quantity of [2, 3]) await editWarehouseDoc({ tenantId, userId, docId: doc.id, editReason: '连续修改数量', lines: [{ lineId: lines[0].id, quantity, amount: 3 }] })
    for (const amount of [4, 5]) await editWarehouseDoc({ tenantId, userId, docId: doc.id, editReason: '多行连续改价', lines: lines.map(l => ({ lineId: l.id, amount })) })
    const balances = await prisma.warehouseLedgerBalance.findMany({ where: { tenantId, productId: { in: products.map(p => p.id) } } })
    expect(balances.map(b => Number(b.inventoryValue))).toEqual([5, 5])
    expect(Number((await prisma.warehouseDoc.findUniqueOrThrow({ where: { id: doc.id } })).totalAmount)).toBe(10)
    expect(Number(balances.find(b => b.productId === products[0].id)!.physicalQty)).toBe(3)
  })
})


describe('DJ031 decimal edit precision', () => {
  it('persists the minimum amount and quantity changes, and equivalent retries do not add events', async () => {
    const {doc, lines, products} = await fixture([null])
    for (const amount of [2.0001, 2, 2.00005]) {
      const result = await editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'最小金额精度验收',lines:[{lineId:lines[0].id,amount}]})
      expect(result.changed).toBe(true)
      const expected = amount === 2.00005 ? 2.0001 : amount
      const row=await prisma.warehouseDocLine.findUniqueOrThrow({where:{id:lines[0].id}})
      const balance=await prisma.warehouseLedgerBalance.findFirstOrThrow({where:{tenantId,productId:products[0].id}})
      expect(Number(row.amount)).toBe(expected)
      expect(Number(balance.inventoryValue)).toBe(expected)
    }
    for (const quantity of [1.000001,1]) {
      const result=await editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'最小数量精度验收',lines:[{lineId:lines[0].id,quantity}]})
      expect(result.changed).toBe(true)
      const row=await prisma.warehouseDocLine.findUniqueOrThrow({where:{id:lines[0].id}})
      const balance=await prisma.warehouseLedgerBalance.findFirstOrThrow({where:{tenantId,productId:products[0].id}})
      expect(Number(row.quantity)).toBe(quantity)
      expect(Number(balance.physicalQty)).toBe(quantity)
      expect(Number(row.amount)).toBe(Number(balance.inventoryValue))
    }
    const before=await snapshot(products.map(p=>p.id),doc.id)
    const noop=await editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'同值重复不写',lines:[{lineId:lines[0].id,quantity:1.0000004,amount:2.00014}]})
    expect(noop.changed).toBe(false)
    expect(await snapshot(products.map(p=>p.id),doc.id)).toBe(before)
  })
})


it('DJ031 invalid, out-of-range and rounded-zero edits leave complete records unchanged', async () => {
  const {doc,lines,products}=await fixture(['DECIMAL-REJECT'])
  const before=await snapshot(products.map(p=>p.id),doc.id)
  for(const change of [{quantity:0.0000001},{amount:0.00001},{quantity:100000000},{amount:1000000000},{quantity:NaN},{amount:Infinity}]) {
    await expect(editWarehouseDoc({tenantId,userId,docId:doc.id,editReason:'非法精度完整回滚',lines:[{lineId:lines[0].id,...change}]})).rejects.toThrow('无效')
    expect(await snapshot(products.map(p=>p.id),doc.id)).toBe(before)
  }
})
