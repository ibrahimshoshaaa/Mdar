import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyShopifyWebhook(rawBody,signature,secret){
  if(!Buffer.isBuffer(rawBody)||typeof signature!=='string'||!secret)return false;
  const expected=createHmac('sha256',secret).update(rawBody).digest();
  const given=Buffer.from(signature,'base64');
  return given.length===expected.length&&timingSafeEqual(given,expected);
}

export function parseOrderEvent(payload,topic){
  if(!['orders/create','orders/cancelled','refunds/create'].includes(topic))throw new Error('Unsupported order topic');
  const orderId=topic==='refunds/create'?payload?.order_id:payload?.id;
  if(!/^\d+$/.test(String(orderId||'')))throw new Error('Missing order ID');
  const orderGid='gid://shopify/Order/'+orderId;
  const items=Array.isArray(payload.line_items)?payload.line_items.map(x=>({
    lineItemId:String(x.id||''),sku:typeof x.sku==='string'?x.sku:null,quantity:Number(x.quantity)
  })):[];
  if(items.some(x=>!/^\d+$/.test(x.lineItemId)||!Number.isSafeInteger(x.quantity)||x.quantity<0))throw new Error('Invalid line items');
  return {orderGid,orderName:String(payload.name||'#'+orderId).slice(0,100),topic,
    financialStatus:String(payload.financial_status||''),fulfillmentStatus:String(payload.fulfillment_status||''),
    cancelledAt:payload.cancelled_at||(topic==='orders/cancelled'?(payload.updated_at||new Date().toISOString()):null),updatedAt:payload.updated_at||null,items};
}
