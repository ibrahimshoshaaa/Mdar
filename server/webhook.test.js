import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyShopifyWebhook, parseOrderEvent } from './webhook.js';

test('webhook validates HMAC over exact raw bytes', () => {
  const raw=Buffer.from('{"id":123,"line_items":[]}');
  const signature=createHmac('sha256','secret').update(raw).digest('base64');
  assert.equal(verifyShopifyWebhook(raw,signature,'secret'),true);
  assert.equal(verifyShopifyWebhook(Buffer.from(' '+raw),signature,'secret'),false);
  assert.equal(verifyShopifyWebhook(raw,'bad','secret'),false);
});

test('order event extracts only operational fields', () => {
  const order=parseOrderEvent({id:123,name:'#1001',email:'private@example.com',line_items:[{id:456,sku:'SHOE-42',quantity:2}]},'orders/create');
  assert.equal(order.orderGid,'gid://shopify/Order/123');
  assert.equal(order.items[0].sku,'SHOE-42');
  assert.equal(JSON.stringify(order).includes('private@example.com'),false);
  assert.throws(()=>parseOrderEvent({id:123,line_items:[{id:456,quantity:-1}]},'orders/create'));
  assert.equal(parseOrderEvent({id:99,order_id:123},'refunds/create').orderGid,'gid://shopify/Order/123');
});
