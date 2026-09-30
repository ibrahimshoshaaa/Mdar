import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw Object.assign(new Error('Password must be 12–256 characters'), { status: 400 });
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [algorithm, salt, hex] = String(stored || '').split(':');
  if (algorithm !== 'scrypt' || !/^[0-9a-f]{32}$/.test(salt || '') || !/^[0-9a-f]{128}$/.test(hex || '')) return false;
  const actual = await scrypt(String(password), Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}
export function token() { return randomBytes(32).toString('base64url'); }
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function canonicalItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw Object.assign(new Error('Invalid items'), { status: 400 });
  const seen = new Set();
  return items.map(item => {
    if (!uuid(item.variantId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000 || seen.has(item.variantId)) throw Object.assign(new Error('Invalid sale item'), { status: 400 });
    seen.add(item.variantId);
    if(item.priceQuote!==undefined && (typeof item.priceQuote!=='string'||item.priceQuote.length>1024))throw Object.assign(new Error('Invalid price quote'),{status:400});
    return { variantId: item.variantId, quantity: item.quantity, ...(item.priceQuote?{priceQuote:item.priceQuote}:{}) };
  }).sort((a,b) => a.variantId.localeCompare(b.variantId));
}
export function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
