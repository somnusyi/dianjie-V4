import type {Prisma} from '@dianjie/db'

/** A supplier's statement becomes shared only when purchasing sends it. */
export const supplierVisibleSettlement:Prisma.UpstreamSettlementStatementWhereInput={
 OR:[
  {status:{in:['SENT_TO_SUPPLIER','DISPUTED','CONFIRMED','LOCKED','INVOICED','PAID']}},
  {status:'CANCELLED',buyerConfirmedAt:{not:null}},
 ],
}
