import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPurchaseDraftSession, purchaseDraftKey, purchaseDraftOwner } from '../src/lib/purchase-order-draft'
const owner={tenantId:'tenant-a',userId:'user-a',storeId:'store-b'}
const draft={supplierId:'supplier-a',expectedDate:'2026-10-30',note:'',items:[{productId:'p1',quantity:2,unitPrice:10}]}
let values:Map<string,string>,storage:any
beforeEach(()=>{vi.useFakeTimers();values=new Map();storage={getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}})
afterEach(()=>{vi.useRealTimers()})
it('isolates draft restore by tenant, user, and active store',()=>{
 const a=createPurchaseDraftSession(storage,owner);a.update(draft);a.flush()
 expect(createPurchaseDraftSession(storage,owner).restored?.draft.items[0].quantity).toBe(2)
 for(const other of [{...owner,tenantId:'tenant-b'},{...owner,userId:'user-b'},{...owner,storeId:'store-c'}]) expect(createPurchaseDraftSession(storage,other).restored).toBeNull()
 a.dispose()
})
it('does not restore, rewrite or delete unknown-owner v1 data',()=>{
 const legacy=JSON.stringify({...draft,savedAt:Date.now()});values.set('dj:po-new:draft:v1',legacy)
 const session=createPurchaseDraftSession(storage,owner);expect(session.restored).toBeNull();session.update({...draft,supplierId:'',items:[]});session.dispose()
 expect(values.get('dj:po-new:draft:v1')).toBe(legacy)
})
it('refuses incomplete trusted owner information',()=>{
 expect(purchaseDraftOwner({id:'u'},'s')).toBeNull();expect(purchaseDraftOwner({id:'u',tenantId:'t'},null)).toBeNull()
 expect(purchaseDraftOwner({id:'u',tenantId:'t'},'s')).toEqual({tenantId:'t',userId:'u',storeId:'s'})
})
it('keeps normal unsubmitted edits when leaving before the debounce fires',()=>{
 const a=createPurchaseDraftSession(storage,owner);a.update(draft);expect(values.has(purchaseDraftKey(owner))).toBe(false);a.dispose()
 expect(createPurchaseDraftSession(storage,owner).restored?.draft).toEqual(draft)
})
it('cancels late timers and pagehide/unmount flush after successful submission',()=>{
 const a=createPurchaseDraftSession(storage,owner);a.update(draft);const key=a.beginSubmission(draft);expect(key).toBeTruthy();a.completeSubmission()
 vi.advanceTimersByTime(1000);a.flush();a.dispose();a.update(draft);vi.advanceTimersByTime(1000)
 expect(values.has(purchaseDraftKey(owner))).toBe(false);expect(createPurchaseDraftSession(storage,owner).restored).toBeNull()
})
it('preserves the original idempotency key across request failure, unmount and reload',()=>{
 const a=createPurchaseDraftSession(storage,owner);const key=a.beginSubmission(draft);a.failSubmission();a.dispose()
 const b=createPurchaseDraftSession(storage,owner);expect(b.beginSubmission(b.restored!.draft)).toBe(key);b.failSubmission();b.dispose()
})
it('changes the key for business content changes, but not authoritative repricing or item ordering',()=>{
 const a=createPurchaseDraftSession(storage,owner),key=a.beginSubmission(draft);a.failSubmission()
 expect(a.beginSubmission({...draft,items:[{...draft.items[0],unitPrice:12}]})).toBe(key);a.failSubmission()
 const edited=a.beginSubmission({...draft,items:[{...draft.items[0],quantity:3}]});expect(edited).not.toBe(key);a.failSubmission()
 const noted=a.beginSubmission({...draft,note:'next delivery',items:[{...draft.items[0],quantity:3}]});expect(noted).not.toBe(edited);a.dispose()
})
it('rotates key when clearing the editor and prevents duplicate parallel submit',()=>{
 const a=createPurchaseDraftSession(storage,owner),key=a.beginSubmission(draft);expect(a.beginSubmission(draft)).toBeNull();a.failSubmission();a.clear();expect(a.beginSubmission(draft)).not.toBe(key);a.dispose()
})
it('late success does not remove a newer edited draft saved by another mounted editor',()=>{
 const a=createPurchaseDraftSession(storage,owner),key=a.beginSubmission(draft);a.dispose()
 const b=createPurchaseDraftSession(storage,owner);const next=b.beginSubmission({...draft,note:'different request'});expect(next).not.toBe(key);b.failSubmission();a.completeSubmission()
 const c=createPurchaseDraftSession(storage,owner);expect(c.restored?.draft.note).toBe('different request');expect(c.beginSubmission(c.restored!.draft)).toBe(next);b.dispose();c.dispose()
})
it('validates stored owner and fingerprint before recovering a key',()=>{
 const a=createPurchaseDraftSession(storage,owner);a.update(draft);a.flush();const raw=JSON.parse(values.get(purchaseDraftKey(owner))!);raw.draft.items[0].quantity=99;values.set(purchaseDraftKey(owner),JSON.stringify(raw))
 expect(createPurchaseDraftSession(storage,owner).restored).toBeNull();a.dispose()
})

it('supplier/date changes rotate key while reordering identical item lines keeps it',()=>{
 const a=createPurchaseDraftSession(storage,owner),two={...draft,items:[...draft.items,{productId:'p2',quantity:1,unitPrice:2}]}
 const first=a.beginSubmission(two);a.failSubmission();expect(a.beginSubmission({...two,items:[...two.items].reverse()})).toBe(first);a.failSubmission()
 const supplier=a.beginSubmission({...two,supplierId:'supplier-b'});expect(supplier).not.toBe(first);a.failSubmission()
 expect(a.beginSubmission({...two,supplierId:'supplier-b',expectedDate:'2026-10-31'})).not.toBe(supplier);a.dispose()
})
