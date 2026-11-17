'use client'

import { SupplierManager } from '../../supplier-manager'

export default function EditSupplierPage({ params }: { params: { id: string } }) {
  return <SupplierManager editSupplierId={params.id} />
}
