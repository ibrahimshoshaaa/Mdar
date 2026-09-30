import { createHmac, timingSafeEqual } from 'node:crypto';

export function createPriceQuote(secret, locationId, variantId, price, ttlMs=24*60*60*1000) {
  const cents=Math.round(Number(price)*100);
  if(!Number.isSafeInteger(cents)||cents<0)throw new Error('Invalid price');
  const payload=Buffer.from(JSON.stringify({locationId,variantId,cents,expiresAt:Date.now()+ttlMs})).toString('base64url');
  const signature=createHmac('sha256',secret).update(payload).digest('base64url');
  return payload+'.'+signature;
}
export function verifyPriceQuote(secret,quote,locationId,variantId){
  if(typeof quote!=='string'||quote.length>1024)throw new Error('Invalid price quote');
  const [payload,signature,extra]=quote.split('.');
  if(!payload||!signature||extra)throw new Error('Invalid price quote');
  const actual=Buffer.from(signature,'base64url');
  const expected=createHmac('sha256',secret).update(payload).digest();
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error('Invalid price quote');
  let data;
  try{data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'))}catch{throw new Error('Invalid price quote')}
  if(data.locationId!==locationId||data.variantId!==variantId||!Number.isSafeInteger(data.cents)||data.cents<0||!Number.isSafeInteger(data.expiresAt)||data.expiresAt<Date.now())throw new Error('Expired or invalid price quote');
  return data.cents;
}
