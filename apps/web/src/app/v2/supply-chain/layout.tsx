import type { ReactNode } from 'react'
import { SupplyChainShell } from '@/components/v2/supply-chain-shell'

export default function InternalSupplyChainLayout({ children }: { children: ReactNode }) {
  return <SupplyChainShell>{children}</SupplyChainShell>
}
