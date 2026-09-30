import test from 'node:test';
import assert from 'node:assert/strict';
import { shopStatus, remoteInventory, adjustInventory } from './shopify.js';

test('Shopify client uses fixed store endpoint and reads linked location stock', async () => {
  process.env.SHOPIFY_SHOP_DOMAIN='example.myshopify.com';
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN='test-token';
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    const {query}=JSON.parse(options.body);
    return {ok:true,json:async()=>({data:query.includes('inventoryItem')?{
      inventoryItem:{id:'gid://shopify/InventoryItem/123',sku:'SHOE-42',inventoryLevels:{nodes:[{location:{id:'gid://shopify/Location/456',name:'Warehouse'},quantities:[{name:'available',quantity:7}]}]}}
    }:{shop:{name:'Test shop'}}})};
  };
  assert.equal((await shopStatus(fetcher)).shop.name,'Test shop');
  assert.equal((await remoteInventory('gid://shopify/InventoryItem/123','gid://shopify/Location/456',fetcher)).quantity,7);
  assert.equal(calls[0].url,'https://example.myshopify.com/admin/api/2026-07/graphql.json');
  assert.equal(calls[0].options.headers['X-Shopify-Access-Token'],'test-token');
});

test('inventory adjustment keeps the supplied idempotency key and CAS quantity', async () => {
  process.env.SHOPIFY_SHOP_DOMAIN='example.myshopify.com';
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN='test-token';
  let submitted;
  const fetcher=async(_url,options)=>{submitted=JSON.parse(options.body);return {ok:true,json:async()=>({data:{inventoryAdjustQuantities:{userErrors:[],inventoryAdjustmentGroup:{changes:[]}}}})}};
  await adjustInventory({inventoryItemId:'gid://shopify/InventoryItem/123',locationId:'gid://shopify/Location/456',delta:-2,previousQuantity:7,idempotencyKey:'a-fixed-key'},fetcher);
  assert.match(submitted.query,/@idempotent/);
  assert.equal(submitted.variables.idempotencyKey,'a-fixed-key');
  assert.equal(submitted.variables.input.changes[0].changeFromQuantity,7);
  assert.equal(submitted.variables.input.changes[0].delta,-2);
});
