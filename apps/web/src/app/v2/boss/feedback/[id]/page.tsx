import { redirect } from 'next/navigation'

export default function FormerFeedbackApprovalDetailPage({ params }: { params: { id: string } }) {
  redirect(`/v2/feedback/${encodeURIComponent(params.id)}`)
}
