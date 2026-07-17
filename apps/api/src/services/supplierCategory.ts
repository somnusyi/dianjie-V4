import { prisma } from '@dianjie/db'

export type MergeSupplierCategoryInput = {
  tenantId: string
  supplierId: string
  userId: string
  role: string
  sourceId: string
  targetId: string
}

export async function mergeSupplierCategory(input: MergeSupplierCategoryInput) {
  const { tenantId, supplierId, userId, role, sourceId, targetId } = input
  if (sourceId === targetId) {
    throw Object.assign(new Error('来源分类和目标分类不能相同'), { statusCode: 400 })
  }

  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-categories:${tenantId}:${supplierId}`}))`
    const categories = await tx.supplierProductCategory.findMany({
      where: { tenantId, supplierId, id: { in: [sourceId, targetId] } },
    })
    const source = categories.find(category => category.id === sourceId)
    const target = categories.find(category => category.id === targetId)
    if (!source || !target) throw Object.assign(new Error('来源分类或目标分类不存在'), { statusCode: 404 })
    if (source.isSystem) throw Object.assign(new Error('系统兜底分类不能合并'), { statusCode: 400 })
    if (!source.isActive) throw Object.assign(new Error('来源分类已停用，请刷新后重试'), { statusCode: 409 })
    if (!target.isActive) throw Object.assign(new Error('目标分类已停用，不能接收商品'), { statusCode: 400 })

    const moved = await tx.product.updateMany({
      where: { tenantId, supplierId, category: source.name },
      data: { category: target.name },
    })
    await tx.supplierProductCategory.update({
      where: { id: source.id },
      data: { isActive: false },
    })
    await tx.opLog.create({
      data: {
        tenantId, userId, role,
        action: `合并商品分类「${source.name}」→「${target.name}」，移动 ${moved.count} 个 SKU`,
        entityType: 'ProductCategory', target: target.name, targetId: source.id,
        metadata: {
          supplierId,
          source: { id: source.id, name: source.name },
          target: { id: target.id, name: target.name },
          productCount: moved.count,
        },
      },
    })
    return { source, target, productCount: moved.count }
  })
}
