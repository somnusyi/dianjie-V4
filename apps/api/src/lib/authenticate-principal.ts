import { createHash } from 'node:crypto'
import { isSupplierRole } from './auth-scope'

export function permissionStamp(user:any) {
 return createHash('sha256').update(JSON.stringify({ver:user.ver,role:user.role,storeId:user.storeId||null,storeIds:[...(user.storeIds||[])].sort(),supplierId:user.supplierId||null,supplierBusinessScopes:[...(user.supplierBusinessScopes||[])].sort()})).digest('hex')
}
/** Per-request verification only: no TTL cache may keep revoked or downgraded identities alive. */
export function createAuthenticate(prisma:any) {
 const verified=new WeakSet<object>()
 return async(request:any,reply:any)=>{
  if(verified.has(request))return
  try{await request.jwtVerify()}catch{return reply.status(401).send({error:'未授权，请先登录'})}
  const claims=request.user
  if(claims?.typ!=='access'||typeof claims.userId!=='string'||typeof claims.tenantId!=='string'||typeof claims.jti!=='string'||!claims.jti||!Number.isInteger(claims.ver??0))return reply.status(401).send({error:'未授权，请先登录'})
  try{
   const principal=await prisma.user.findFirst({where:{id:claims.userId,tenantId:claims.tenantId},select:{id:true,tenantId:true,status:true,role:true,authVersion:true,storeId:true,storeIds:true,supplierId:true,tenant:{select:{status:true}},supplier:{select:{id:true,status:true,tenantId:true,businessScopes:true}}}})
   if(!principal||principal.status!=='ACTIVE'||principal.tenant.status!=='ACTIVE'||principal.role!==claims.role||principal.authVersion!==(claims.ver??0))return reply.status(401).send({error:'账号状态或会话已变更，请先登录'})
   if(isSupplierRole(principal.role)&&(!principal.supplierId||principal.supplierId!==claims.supplierId||principal.supplier?.status!=='ENABLED'||principal.supplier?.tenantId!==claims.tenantId))return reply.status(401).send({error:'供应商账号绑定已变更，请先登录'})
   const jtis=[claims.jti,...(typeof claims.sid==='string'&&claims.sid?[claims.sid]:[])]
   if(await prisma.revokedToken.findFirst({where:{jti:{in:jtis}}}))return reply.status(401).send({error:'会话已退出，请先登录'})
   // Store assignments can change independently of role/version. Never trust old scope claims.
   request.user={...claims,storeId:principal.storeId||null,storeIds:principal.storeIds?.length?principal.storeIds:principal.storeId?[principal.storeId]:[],supplierId:principal.supplierId||null,supplierBusinessScopes:principal.supplier?.businessScopes||[]}
   verified.add(request)
  }catch{return reply.status(503).send({error:'认证服务暂时不可用，请稍后重试'})}
 }
}
