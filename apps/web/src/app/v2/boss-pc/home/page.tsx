/**
 * 本页此前是纯手写假数据(零取数)，渲染的是别的城市、别的业态的门店和编造的经营数字，
 * 而且没有任何 demo 标记——在生产上比报错危险，因为那些数字看着都像真的。
 * 2026-08-13 按老板决定先下线；接真数据另行排期(后端集团聚合已具备)。
 * 设计稿保留在 git 历史里，需要时按本文件的最后一个非 stub 版本恢复。
 */
import { notFound } from 'next/navigation'

export default function Page() {
  notFound()
}
