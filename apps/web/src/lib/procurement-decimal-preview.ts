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

/** Decimal long division rounded half-up; strings avoid binary floating point. */
export function procurementDecimalProportion(amount:string,part:string,whole:string,places=4):string{
 const a=fixed(amount,6),b=fixed(part,6),c=fixed(whole,6)
 if(a===null||b===null||c===null||c===BigInt(0)||places<0||places>6)return '—'
 const numerator=a*b*BigInt(10)**BigInt(places),denominator=c*BigInt(1000000)
 const result=(numerator+denominator/BigInt(2))/denominator
 const text=result.toString().padStart(places+1,'0')
 return places?`${text.slice(0,-places)}.${text.slice(-places)}`:text
}
export const procurementDecimalQuotient=(amount:string,quantity:string)=>procurementDecimalProportion(amount,'1',quantity,6)

export function procurementDecimalSum(values:string[],places=4):string{
 let total=BigInt(0)
 for(const value of values){const amount=fixed(value,places);if(amount===null)return '—';total+=amount}
 const text=total.toString().padStart(places+1,'0')
 return places?`${text.slice(0,-places)}.${text.slice(-places)}`:text
}

export function procurementDecimalMin(left:string,right:string):string{const a=fixed(left,4),b=fixed(right,4);if(a===null||b===null)return '—';const text=(a<b?a:b).toString().padStart(5,'0');return `${text.slice(0,-4)}.${text.slice(-4)}`}
