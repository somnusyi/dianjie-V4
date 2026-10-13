function fixed(value:string,places:number):bigint|null{
 const match=value.trim().match(/^\+?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i)
 if(!match||!(match[1]||match[2]))return null
 const exponent=Number(match[3]||0)
 if(!Number.isInteger(exponent)||Math.abs(exponent)>30||(match[1]+(match[2]||'')).length>64)return null
 const digits=BigInt((match[1]||'0')+(match[2]||'')),scale=(match[2]||'').length-exponent
 if(scale<=places)return digits*BigInt(10)**BigInt(places-scale)
 const divisor=BigInt(10)**BigInt(scale-places)
 return (digits+divisor/BigInt(2))/divisor
}
/** Match the server's six-place quantity/unit-price normalization and half-up
 * decimal multiplication, without binary floating-point currency arithmetic. */
export function procurementDecimalProduct(left:string,right:string,places=4):string{
 const a=fixed(left,6),b=fixed(right,6)
 if(a===null||b===null||places<0||places>6)return '—'
 const divisor=BigInt(10)**BigInt(12-places),result=(a*b+divisor/BigInt(2))/divisor
 const text=result.toString().padStart(places+1,'0')
 return places?`${text.slice(0,-places)}.${text.slice(-places)}`:text
}
