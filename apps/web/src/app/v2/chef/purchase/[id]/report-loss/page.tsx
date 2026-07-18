'use client'

import { useRouter } from 'next/navigation'

/**
 * 历史“验收后补报”链接的兼容落地页。
 *
 * 供应商责任以收货确认为截止点：到货短缺、破损和品质异常必须在
 * 收货确认前登记；确认后发生或发现的差异只进入门店内部盘损。
 */
export default function ClosedArrivalClaimPage({ params }: { params: { id: string } }) {
  const router = useRouter()

  return (
    <div className="min-h-screen bg-bg pb-10">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">到货差异</h1>
      </header>

      <main className="mx-4 mt-4 space-y-3">
        <section className="bg-amber/10 border border-amber/40 rounded-card p-4">
          <h2 className="text-h2 text-amber-fg">收货确认后不可补报</h2>
          <p className="text-caption text-gray2 mt-2 leading-6">
            到货短缺、破损、变质或规格不符，必须在收货确认时核对并登记。
            收货一经确认即结束供应商责任判断，之后发现的差异不再调整供应商应付或供应商库存。
          </p>
        </section>

        <section className="bg-white border border-border rounded-card p-4">
          <h2 className="text-h2">确认后发现损耗怎么办？</h2>
          <p className="text-caption text-gray2 mt-2 leading-6">
            请登记为门店内部盘损；月度盘点产生的账实差异也只调整门店库存，不关联供应商。
          </p>
        </section>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            onClick={() => router.push(`/v2/chef/purchase/po-success/${params.id}`)}
            className="py-3 bg-white border border-border text-ink rounded-cta text-button"
          >
            返回订货单
          </button>
          <button
            onClick={() => router.push('/v2/chef/check/new')}
            className="py-3 bg-ink text-white rounded-cta text-button"
          >
            登记店内盘损
          </button>
        </div>
      </main>
    </div>
  )
}
