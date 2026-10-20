import type {Prisma} from '@dianjie/db'

/** Supplier access begins when purchasing has actually sent the order. */
export const supplierVisiblePurchaseOrder:Prisma.UpstreamPurchaseOrderWhereInput={
 OR:[
  {status:{in:['SUBMITTED_TO_SUPPLIER','CHANGE_PROPOSED','SUPPLIER_ACCEPTED','PARTIALLY_SHIPPED','SHIPPED','PARTIALLY_RECEIVED','RECEIVED','SETTLEMENT_PENDING','CLOSED']}},
  {status:'CANCELLED',submittedAt:{not:null}},
 ],
}
