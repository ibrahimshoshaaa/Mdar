import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, canonicalItems, sha256 } from './security.js';

test('password hashes verify only the correct password', async () => {
  const hash = await hashPassword('safepassword123');
  assert.equal(await verifyPassword('safepassword123', hash), true);
  assert.equal(await verifyPassword('wrongpassword123', hash), false);
  assert.equal(await verifyPassword('safepassword123', 'invalid'), false);
});

test('sale fingerprint is stable regardless of item order', () => {
  const a={variantId:'123e4567-e89b-42d3-a456-426614174000',quantity:2};
  const b={variantId:'123e4567-e89b-42d3-a456-426614174001',quantity:1};
  assert.equal(sha256(JSON.stringify(canonicalItems([a,b]))),sha256(JSON.stringify(canonicalItems([b,a]))));
  assert.throws(()=>canonicalItems([a,a]));
  assert.throws(()=>canonicalItems([{...a,quantity:0}]));
});
