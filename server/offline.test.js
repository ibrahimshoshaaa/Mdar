import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createPriceQuote, verifyPriceQuote } from './price-quote.js';
globalThis.window=globalThis;
const localValues=new Map();
globalThis.localStorage={getItem:key=>localValues.get(key)||null,setItem:(key,value)=>localValues.set(key,value),removeItem:key=>localValues.delete(key)};
await import('../ui/offline.js');

test('offline sale deducts locally, queues once, and prevents overselling', async () => {
  const userId=crypto.randomUUID(),locationId=crypto.randomUUID(),variantId=crypto.randomUUID();
  const priceQuote=createPriceQuote('a'.repeat(32),locationId,variantId,'850.00');
  await MadarOffline.snapshot(userId,locationId,[{variantId,name:'Shoe',sku:'S-42',size:'42',color:'Black',price:'850.00',priceQuote,quantity:3}]);
  const sale=await MadarOffline.sell(userId,locationId,[{variantId,quantity:2}]);
  assert.equal((await MadarOffline.inventory(userId,locationId))[0].quantity,1);
  assert.equal((await MadarOffline.pending(userId,locationId))[0].operationId,sale.operationId);
  await assert.rejects(MadarOffline.sell(userId,locationId,[{variantId,quantity:2}]),/رصيد الفرع غير كافٍ/);
  assert.equal((await MadarOffline.inventory(userId,locationId))[0].quantity,1);
  assert.equal((await MadarOffline.pending(userId,locationId)).length,1);
  await assert.rejects(MadarOffline.snapshot(userId,locationId,[{variantId,quantity:8}]),/Sync pending/);
  await MadarOffline.setStatus(sale.operationId,'synced');
  await MadarOffline.snapshot(userId,locationId,[{variantId,name:'Shoe',sku:'S-42',size:'42',color:'Black',price:'850.00',priceQuote,quantity:1}]);
  assert.equal((await MadarOffline.inventory(userId,locationId))[0].quantity,1);
});

test('signed sale price cannot be changed or used for another location', () => {
  const secret='a'.repeat(32),location=crypto.randomUUID(),variant=crypto.randomUUID();
  const quote=createPriceQuote(secret,location,variant,'850.00');
  assert.equal(verifyPriceQuote(secret,quote,location,variant),85000);
  assert.throws(()=>verifyPriceQuote(secret,quote,crypto.randomUUID(),variant));
  assert.throws(()=>verifyPriceQuote(secret,quote.slice(0,-2)+'xx',location,variant));
  assert.throws(()=>verifyPriceQuote(secret,createPriceQuote(secret,location,variant,'850.00',-1),location,variant));
});

test('offline cashier unlock expires and rejects another password', async () => {
  const user={id:crypto.randomUUID(),email:'cashier-'+crypto.randomUUID()+'@example.com',role:'cashier'};
  const locations=[{id:crypto.randomUUID(),name:'Branch',kind:'branch'}];
  localStorage.setItem('madar-cashier-device',crypto.randomUUID());
  await MadarOffline.rememberCashier(user,'safepassword123',locations);
  assert.equal((await MadarOffline.offlineCashier(user.email,'safepassword123')).user.id,user.id);
  await assert.rejects(MadarOffline.offlineCashier(user.email,'wrongpassword123'),/بيانات الدخول غير صحيحة/);
  localStorage.setItem('madar-cashier-device',crypto.randomUUID());
  await assert.rejects(MadarOffline.offlineCashier(user.email,'safepassword123'),/يلزم تسجيل الدخول/);
});
