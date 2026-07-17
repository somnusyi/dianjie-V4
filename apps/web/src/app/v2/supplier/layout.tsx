import type { ReactNode } from 'react'
import { SupplierShell } from '@/components/v2/supplier-shell'

export default function SupplierLayout({ children }: { children: ReactNode }) {
  return <SupplierShell>{children}</SupplierShell>
}
