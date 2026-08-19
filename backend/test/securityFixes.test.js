'use strict';
const assert = require('assert');
const {
  timingSafeEqualString,
  timingSafeEqualAny,
  safeJson,
  isValidVoucherOrderCode,
} = require('../utils/cryptoSafe');
const { isStaffJwtPayload } = require('../utils/staffAuth');

assert.strictEqual(timingSafeEqualString('abc', 'abc'), true);
assert.strictEqual(timingSafeEqualString('abc', 'abd'), false);
assert.strictEqual(timingSafeEqualString('', 'secret'), false);
assert.strictEqual(timingSafeEqualString('secret', ''), false);
assert.strictEqual(timingSafeEqualString('ab', 'abc'), false);

assert.strictEqual(timingSafeEqualAny('tok', ['nope', 'tok']), true);
assert.strictEqual(timingSafeEqualAny('tok', ['nope', 'other']), false);
assert.strictEqual(timingSafeEqualAny('tok', []), false);

assert.ok(isStaffJwtPayload({ id: 1 }), 'legacy staff token without type');
assert.ok(isStaffJwtPayload({ id: 1, type: 'staff' }));
assert.strictEqual(isStaffJwtPayload({ id: 1, type: 'customer' }), false);
assert.strictEqual(isStaffJwtPayload({ id: 1, type: 'reseller' }), false);
assert.strictEqual(isStaffJwtPayload({ id: 1, type: 'other' }), false);
assert.strictEqual(isStaffJwtPayload(null), false);

const xss = safeJson('</script><img src=x onerror=alert(1)>');
assert.ok(!xss.includes('</script>'), 'must not emit raw </script>');
assert.ok(xss.includes('\\u003c'), 'must unicode-escape <');
assert.strictEqual(safeJson({ a: 1 }), '{"a":1}');

assert.ok(isValidVoucherOrderCode('VC-AB12CD'));
assert.ok(isValidVoucherOrderCode('VC-ABCDEF'));
assert.strictEqual(isValidVoucherOrderCode('</script>'), false);
assert.strictEqual(isValidVoucherOrderCode('a'), false);
assert.strictEqual(isValidVoucherOrderCode('x'.repeat(65)), false);
assert.strictEqual(isValidVoucherOrderCode('VC ABC'), false);

console.log('securityFixes.test.js ok');
