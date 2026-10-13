import {getUser} from './v2-auth'
/** Session identity only; never credentials or a permission change. */
export function inventoryRuleOwner(){try{return `${JSON.parse(localStorage.getItem('tenant')||'null')?.id||''}:${getUser()?.id||''}`}catch{return `:${getUser()?.id||''}`}}
