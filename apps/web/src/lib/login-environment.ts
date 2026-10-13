const SHORT_TEST_ACCOUNTS=new Set(['boss','fin','mgr','cd','chef','eng','sup1','sup2'])
export function loginTenant(requested='',identifier='',preview=process.env.NEXT_PUBLIC_PREVIEW_TENANT_SLUG||''){
 const fixed=preview.trim();if(fixed)return fixed
 return SHORT_TEST_ACCOUNTS.has(identifier.trim().toLowerCase())?'test':requested.trim()||'dianjie'
}
export function dedicatedTestLogin(requested:string,identifier=''){
 return !process.env.NEXT_PUBLIC_PREVIEW_TENANT_SLUG?.trim()&&loginTenant(requested,identifier)==='test'?process.env.NEXT_PUBLIC_TEST_LOGIN_URL?.trim()||null:null
}
