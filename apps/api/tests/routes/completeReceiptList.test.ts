import {expect,it,vi} from 'vitest'
import {readCompleteReceiptList} from '../../src/lib/complete-receipt-list'
it.each([0,100,101,200,201])('reads complete %i-row sets including the exact final empty page',async count=>{
 const all=Array.from({length:count},(_,i)=>({id:String(i),amount:'1.11'}));const read=vi.fn(async(cursor?:string)=>all.slice(cursor===undefined?0:Number(cursor)+1,(cursor===undefined?0:Number(cursor)+1)+100));expect(await readCompleteReceiptList(read,100)).toEqual(all);expect(read).toHaveBeenCalledTimes(Math.floor(count/100)+1)
})
it('does not return a partial set when a later page fails',async()=>{const read=vi.fn().mockResolvedValueOnce([{id:'a'},{id:'b'}]).mockRejectedValueOnce(new Error('later page failed'));await expect(readCompleteReceiptList(read,2)).rejects.toThrow('later page failed')})
it.each([{page:[{id:'a'},{id:'a'}]},{page:[{id:''}]},{page:[{id:'a'},{id:'b'},{id:'c'}]}])('rejects invalid or duplicate pages',async ({page})=>{await expect(readCompleteReceiptList(async()=>page,2)).rejects.toMatchObject({statusCode:503})})
it('rejects a repeating server and the explicit page cap without returning half a balance',async()=>{await expect(readCompleteReceiptList(async()=>[{id:'a'},{id:'b'}],2)).rejects.toMatchObject({statusCode:503});await expect(readCompleteReceiptList(async()=>[{id:'a'}],1,1)).rejects.toMatchObject({statusCode:503})})
