/**
 * 总部代付项目 (店长发起 → 老板/财务审批 → 财务付款)
 *
 * 角色权限:
 *   MANAGER  店长: 创建项目 / 录合同 / 申请支出 (PENDING_APPROVAL); 仅自己门店
 *   BOSS/FINANCE: 全部门店; 审批支出; 付款; 录还款
 *
 * 状态机:
 *   CapitalExpense:
 *     PENDING_APPROVAL → APPROVED  (老板/财务批)
 *                     → REJECTED   (驳回)
 *                     → CANCELED   (店长撤回, 仅 PENDING_APPROVAL 可)
 *     APPROVED → PAID    (财务确认到账)
 *              → FAILED  (银行返回失败)
 *
 * project.spent 只在 PAID 时累加(防止申请阶段就计入)
 * contract.paidAmount 同上
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'

const FINANCE_OR_BOSS = new Set(['ADMIN', 'SUPER_ADMIN', 'FINANCE'])
const STORE_LEVEL = new Set(['MANAGER', 'KITCHEN_LEAD'])
// 与 capital 完全无关的角色（应直接 403）
const NON_CAPITAL_ROLES = new Set(['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB', 'CHEF_DIRECTOR', 'CHEF'])

export const capitalRoutes: FastifyPluginAsync = async (app) => {
  const auth = { preHandler: [(app as any).authenticate] }

  // ─── 项目列表 (店长只看本店, 老板/财务全部) ────
  app.get('/projects', auth, async (req: any, reply: any) => {
    const { tenantId, role, storeId } = req.user
    if (NON_CAPITAL_ROLES.has(role)) return reply.status(403).send({ error: '无权访问代付' })
    const { status, storeId: qStore } = req.query as any
    const where: any = { tenantId }
    if (status) where.status = status
    // 店长只看自己店, 集团角色可查全部 / 按 store 过滤
    if (STORE_LEVEL.has(role)) {
      if (!storeId) return []
      where.storeId = storeId
    } else if (qStore) {
      where.storeId = qStore
    }
    const list = await prisma.capitalProject.findMany({
      where,
      include: {
        store: { select: { id: true, name: true, no: true } },
        _count: { select: { contracts: true, expenses: true, repayments: true } },
      },
      orderBy: { startedAt: 'desc' },
    })
    return list.map(p => ({
      ...p,
      remainingDebt: Number(p.spent) - Number(p.repaidAmount),
      progressPct: Number(p.budget) > 0 ? Math.round(Number(p.spent) / Number(p.budget) * 100) : null,
    }))
  })

  // ─── 项目详情 ─────────────────────────────────
  app.get('/projects/:id', auth, async (req: any, reply: any) => {
    const { tenantId, role, storeId } = req.user
    if (NON_CAPITAL_ROLES.has(role)) return reply.status(403).send({ error: '无权访问代付' })
    const p = await prisma.capitalProject.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        store: { select: { id: true, name: true, no: true } },
        contracts: {
          include: { _count: { select: { expenses: true } } },
          orderBy: { createdAt: 'asc' },
        },
        expenses: {
          include: {
            contract: { select: { id: true, vendor: true, category: true } },
          },
          orderBy: { requestedAt: 'desc' },
        },
        repayments: { orderBy: { paidAt: 'desc' } },
      },
    })
    if (!p) return reply.status(404).send({ error: '项目不存在' })
    // 店长只能看自己店
    if (STORE_LEVEL.has(role) && p.storeId !== storeId) {
      return reply.status(403).send({ error: '无权查看其他门店项目' })
    }
    return {
      ...p,
      remainingDebt: Number(p.spent) - Number(p.repaidAmount),
      progressPct: Number(p.budget) > 0 ? Math.round(Number(p.spent) / Number(p.budget) * 100) : null,
    }
  })

  // ─── 立项 (店长 / 老板都可) ────────────────────
  app.post('/projects', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId: userStoreId } = req.user
    if (!FINANCE_OR_BOSS.has(role) && !STORE_LEVEL.has(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const { name, type = 'NEW_STORE', storeId, budget, repaymentTerms, note } = req.body as any
    if (!name?.trim()) return reply.status(400).send({ error: '请填项目名称' })
    // 店长立项必须绑自己门店
    const finalStoreId = STORE_LEVEL.has(role) ? userStoreId : (storeId || null)
    if (STORE_LEVEL.has(role) && !finalStoreId) {
      return reply.status(400).send({ error: '当前账号未绑定门店, 不能立项' })
    }
    const p = await prisma.capitalProject.create({
      data: {
        tenantId, name, type,
        storeId: finalStoreId,
        budget: budget ? Number(budget) : null,
        repaymentTerms: repaymentTerms || null,
        note: note || null,
        status: 'PREPARING',
      },
    })
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: `立项代付项目 ${name}` + (budget ? ` 预算 ¥${Number(budget).toLocaleString()}` : ''),
        entityType: 'CapitalProject', targetId: p.id },
    })
    return reply.status(201).send(p)
  })

  app.patch('/projects/:id', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId } = req.user
    const target = await prisma.capitalProject.findFirst({ where: { id: req.params.id, tenantId } })
    if (!target) return reply.status(404).send({ error: '项目不存在' })
    if (STORE_LEVEL.has(role) && target.storeId !== storeId) {
      return reply.status(403).send({ error: '只能修改本店项目' })
    }
    const { name, status: nextStatus, budget, repaymentTerms, openedAt, closedAt, note } = req.body as any
    const data: any = {}
    if (name !== undefined) data.name = name
    if (nextStatus !== undefined) data.status = nextStatus
    if (budget !== undefined) data.budget = budget ? Number(budget) : null
    if (repaymentTerms !== undefined) data.repaymentTerms = repaymentTerms || null
    if (openedAt !== undefined) data.openedAt = openedAt ? new Date(openedAt) : null
    if (closedAt !== undefined) data.closedAt = closedAt ? new Date(closedAt) : null
    if (note !== undefined) data.note = note || null
    await prisma.capitalProject.update({ where: { id: target.id }, data })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `更新代付项目 ${target.name}`, entityType: 'CapitalProject', targetId: target.id },
    })
    return { success: true }
  })

  // ─── 合同录入 (店长 / 老板都可) ────────────────
  app.post('/contracts', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId } = req.user
    if (!FINANCE_OR_BOSS.has(role) && !STORE_LEVEL.has(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const { projectId, category, vendor, contractNo, totalAmount, startDate, endDate, fileUrl, note } = req.body as any
    if (!projectId || !category || !vendor) return reply.status(400).send({ error: '缺必填项' })
    if (!totalAmount || Number(totalAmount) <= 0) return reply.status(400).send({ error: '合同金额必填' })
    const p = await prisma.capitalProject.findFirst({ where: { id: projectId, tenantId } })
    if (!p) return reply.status(404).send({ error: '项目不存在' })
    if (STORE_LEVEL.has(role) && p.storeId !== storeId) {
      return reply.status(403).send({ error: '只能为本店项目录合同' })
    }
    const c = await prisma.capitalContract.create({
      data: {
        tenantId, projectId, category, vendor,
        contractNo: contractNo || null,
        totalAmount: Number(totalAmount),
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        fileUrl: fileUrl || null,
        note: note || null,
      },
    })
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: `录合同 ${vendor} ${category} ¥${Number(totalAmount).toLocaleString()}`,
        entityType: 'CapitalContract', targetId: c.id },
    })
    return reply.status(201).send(c)
  })

  app.patch('/contracts/:id', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId } = req.user
    const target = await prisma.capitalContract.findFirst({
      where: { id: req.params.id, tenantId },
      include: { project: true },
    })
    if (!target) return reply.status(404).send({ error: '合同不存在' })
    if (STORE_LEVEL.has(role) && target.project.storeId !== storeId) {
      return reply.status(403).send({ error: '只能修改本店合同' })
    }
    const { vendor, contractNo, totalAmount, status: ns, startDate, endDate, fileUrl, note } = req.body as any
    const data: any = {}
    if (vendor !== undefined) data.vendor = vendor
    if (contractNo !== undefined) data.contractNo = contractNo || null
    if (totalAmount !== undefined) data.totalAmount = Number(totalAmount)
    if (ns !== undefined) data.status = ns
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null
    if (fileUrl !== undefined) data.fileUrl = fileUrl || null
    if (note !== undefined) data.note = note || null
    await prisma.capitalContract.update({ where: { id: target.id }, data })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `更新合同 ${target.vendor}`, entityType: 'CapitalContract', targetId: target.id },
    })
    return { success: true }
  })

  // ─── 申请支出 (店长发起, 创建即 PENDING_APPROVAL) ──
  app.post('/expenses', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId } = req.user
    if (!FINANCE_OR_BOSS.has(role) && !STORE_LEVEL.has(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const { projectId, contractId, category, vendor, amount, fileUrl, note } = req.body as any
    if (!projectId || !category || !vendor) return reply.status(400).send({ error: '缺必填项' })
    if (!amount || Number(amount) <= 0) return reply.status(400).send({ error: '金额必填' })
    const p = await prisma.capitalProject.findFirst({ where: { id: projectId, tenantId } })
    if (!p) return reply.status(404).send({ error: '项目不存在' })
    if (STORE_LEVEL.has(role) && p.storeId !== storeId) {
      return reply.status(403).send({ error: '只能为本店项目申请支出' })
    }
    if (contractId) {
      const c = await prisma.capitalContract.findFirst({ where: { id: contractId, tenantId, projectId } })
      if (!c) return reply.status(400).send({ error: '合同不属于该项目' })
      // 计算合同已挂账(包括 PENDING_APPROVAL/APPROVED/PAID, 防超付)
      const reserved = await prisma.capitalExpense.aggregate({
        where: { contractId, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PAID'] } },
        _sum: { amount: true },
      })
      const reservedSum = Number(reserved._sum.amount || 0)
      if (reservedSum + Number(amount) > Number(c.totalAmount) + 0.01) {
        return reply.status(400).send({
          error: `本笔 ¥${amount} 超合同剩余可申请 ¥${(Number(c.totalAmount) - reservedSum).toFixed(2)}`,
        })
      }
    }
    const exp = await prisma.capitalExpense.create({
      data: {
        tenantId, projectId, contractId: contractId || null,
        category, vendor,
        amount: Number(amount),
        fileUrl: fileUrl || null,
        note: note || null,
        status: 'PENDING_APPROVAL',
        requestedById: userId,
      },
    })
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: `申请支出 ${vendor} ${category} ¥${Number(amount).toLocaleString()} (待审批)`,
        entityType: 'CapitalExpense', targetId: exp.id },
    })
    return reply.status(201).send(exp)
  })

  // ─── 审批支出 (老板/财务) ──────────────────────
  app.patch('/expenses/:id/approve', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_OR_BOSS.has(role)) return reply.status(403).send({ error: '仅老板/财务可审批' })
    const { decision, note } = req.body as any
    if (!['APPROVE', 'REJECT'].includes(decision)) {
      return reply.status(400).send({ error: 'decision 必须是 APPROVE/REJECT' })
    }
    if (decision === 'REJECT' && !note?.trim()) {
      return reply.status(400).send({ error: '驳回必须填原因' })
    }
    const exp = await prisma.capitalExpense.findFirst({
      where: { id: req.params.id, tenantId, status: 'PENDING_APPROVAL' },
    })
    if (!exp) return reply.status(404).send({ error: '支出不存在或已审批' })
    await prisma.capitalExpense.update({
      where: { id: exp.id },
      data: {
        status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        approvedById: userId,
        approvedAt: new Date(),
        approvalNote: decision === 'APPROVE' ? (note || null) : null,
        rejectReason: decision === 'REJECT' ? note : null,
      },
    })
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: decision === 'APPROVE'
          ? `批准支出 ${exp.vendor} ¥${exp.amount}`
          : `驳回支出 ${exp.vendor} ¥${exp.amount}: ${note}`,
        entityType: 'CapitalExpense', targetId: exp.id },
    })
    return { success: true, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' }
  })

  // ─── 撤回 (店长 only, 仅 PENDING_APPROVAL) ──────
  app.patch('/expenses/:id/cancel', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!STORE_LEVEL.has(role) && !FINANCE_OR_BOSS.has(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const exp = await prisma.capitalExpense.findFirst({
      where: { id: req.params.id, tenantId, status: 'PENDING_APPROVAL' },
    })
    if (!exp) return reply.status(404).send({ error: '不存在或已审批不可撤回' })
    if (STORE_LEVEL.has(role) && exp.requestedById !== userId) {
      return reply.status(403).send({ error: '只能撤回自己发起的申请' })
    }
    await prisma.capitalExpense.update({ where: { id: exp.id }, data: { status: 'CANCELED' } })
    return { success: true }
  })

  // ─── 财务付款 (APPROVED → PAID, 累加 spent) ─────
  app.patch('/expenses/:id/pay', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_OR_BOSS.has(role)) return reply.status(403).send({ error: '仅财务可付款' })
    const { paymentMethod = 'cmb', bankTxNo, paidAt } = req.body as any
    const exp = await prisma.capitalExpense.findFirst({
      where: { id: req.params.id, tenantId, status: 'APPROVED' },
    })
    if (!exp) return reply.status(404).send({ error: '支出不存在或非已批状态' })
    await prisma.$transaction(async (tx) => {
      await tx.capitalExpense.update({
        where: { id: exp.id },
        data: {
          status: 'PAID',
          paidAt: paidAt ? new Date(paidAt) : new Date(),
          paidById: userId,
          paymentMethod,
          bankTxNo: bankTxNo || null,
        },
      })
      // 累加 contract.paidAmount + project.spent (PAID 时才计入)
      if (exp.contractId) {
        const c = await tx.capitalContract.update({
          where: { id: exp.contractId },
          data: { paidAmount: { increment: Number(exp.amount) } },
        })
        if (Math.abs(Number(c.paidAmount) - Number(c.totalAmount)) < 0.01) {
          await tx.capitalContract.update({ where: { id: c.id }, data: { status: 'COMPLETED' } })
        }
      }
      await tx.capitalProject.update({
        where: { id: exp.projectId },
        data: { spent: { increment: Number(exp.amount) } },
      })
    })
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: `付款 ${exp.vendor} ¥${exp.amount}` + (bankTxNo ? ` 流水 ${bankTxNo}` : ''),
        entityType: 'CapitalExpense', targetId: exp.id },
    })
    return { success: true }
  })

  // ─── 录还款 (财务) ────────────────────────────
  app.post('/repayments', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_OR_BOSS.has(role)) return reply.status(403).send({ error: '仅财务可录还款' })
    const { projectId, storeId, amount, paidAt, source, bankTxNo, note } = req.body as any
    if (!projectId || !storeId) return reply.status(400).send({ error: '缺 projectId/storeId' })
    if (!amount || Number(amount) <= 0) return reply.status(400).send({ error: '金额必填' })
    const p = await prisma.capitalProject.findFirst({ where: { id: projectId, tenantId } })
    if (!p) return reply.status(404).send({ error: '项目不存在' })
    const remaining = Number(p.spent) - Number(p.repaidAmount)
    if (Number(amount) > remaining + 0.01) {
      return reply.status(400).send({
        error: `本次还款 ¥${amount} 超剩余应还 ¥${remaining.toFixed(2)}`,
      })
    }
    const result = await prisma.$transaction(async (tx) => {
      const rp = await tx.storeRepayment.create({
        data: {
          tenantId, projectId, storeId,
          amount: Number(amount),
          paidAt: paidAt ? new Date(paidAt) : new Date(),
          source: source || 'MANUAL',
          bankTxNo: bankTxNo || null,
          note: note || null,
          initiatedById: userId,
        },
      })
      const newRepaid = Number(p.repaidAmount) + Number(amount)
      const newRemaining = Number(p.spent) - newRepaid
      await tx.capitalProject.update({
        where: { id: projectId },
        data: {
          repaidAmount: newRepaid,
          status: newRemaining < 0.01 ? 'REPAID' : p.status,
          closedAt: newRemaining < 0.01 ? new Date() : p.closedAt,
        },
      })
      return rp
    })
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: `还款 ¥${Number(amount).toLocaleString()} → 代付项目 ${p.name}`,
        entityType: 'StoreRepayment', targetId: result.id },
    })
    return reply.status(201).send(result)
  })
}
