const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode})
/** Atomic single-session logout. Does not increment a user's authVersion or log out other devices. */
export async function revokeSession(prisma:any,jwt:any,{refreshToken,accessClaims,ip}: {refreshToken?:string|null;accessClaims?:any;ip?:string}={}) {
 let refresh:any=null
 if(refreshToken){try{refresh=jwt.verify(refreshToken)}catch{};if(refresh?.typ!=='refresh'||!refresh.jti||!refresh.userId)refresh=null}
 if(accessClaims&&refresh&&(accessClaims.userId!==refresh.userId||accessClaims.tenantId!==refresh.tenantId))throw fail(403,'会话不匹配')
 const refreshSid=refresh?.sid||refresh?.jti
 if(accessClaims?.sid&&refreshSid&&accessClaims.sid!==refreshSid)throw fail(400,'会话不匹配')
 const userId=accessClaims?.userId||refresh?.userId,tenantId=accessClaims?.tenantId||refresh?.tenantId
 if(!userId)return {revoked:false}
 return prisma.$transaction(async(tx:any)=>{
  const targets=new Map<string,{type:string;expiresAt:Date}>()
  if(accessClaims?.jti)targets.set(accessClaims.jti,{type:'access',expiresAt:new Date((accessClaims.exp||Math.floor(Date.now()/1000)+7200)*1000)})
  if(refresh?.jti)targets.set(refresh.jti,{type:'refresh',expiresAt:new Date(refresh.exp*1000)})
  const sid=accessClaims?.sid||refreshSid
  if(sid)targets.set(sid,{type:'refresh',expiresAt:new Date((refresh?.exp||Math.floor(Date.now()/1000)+30*86400)*1000)})
  for(const[jti,target]of targets)await tx.revokedToken.upsert({where:{jti},create:{jti,userId,tokenType:target.type,expiresAt:target.expiresAt,reason:'logout'},update:{}})
  if(tenantId)await tx.opLog.create({data:{tenantId,userId,action:'用户登出',ip}})
  return {revoked:true}
 })
}
