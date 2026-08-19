'use strict';

const assert = require('assert');
const {
  getCachedAuthUser,
  setCachedAuthUser,
  invalidateAuthUserCache,
  TTL_MS,
} = require('../utils/authUserCache');

invalidateAuthUserCache();

const user = { id: 7, is_active: true, role: { name: 'admin' } };
assert.strictEqual(getCachedAuthUser(7), null, 'kosong di awal');

setCachedAuthUser(7, user);
assert.strictEqual(getCachedAuthUser(7), user, 'hit cache');
assert.strictEqual(getCachedAuthUser('7'), user, 'userId string');

invalidateAuthUserCache(7);
assert.strictEqual(getCachedAuthUser(7), null, 'invalidate satu user');

setCachedAuthUser(7, user);
setCachedAuthUser(8, { id: 8 });
invalidateAuthUserCache();
assert.strictEqual(getCachedAuthUser(7), null);
assert.strictEqual(getCachedAuthUser(8), null, 'invalidate semua');

setCachedAuthUser(9, { id: 9 }, -1);
assert.strictEqual(getCachedAuthUser(9), null, 'TTL kedaluwarsa tidak dipakai');

assert.ok(TTL_MS >= 5000 && TTL_MS <= 60000);

console.log('authUserCache.test.js ok');
