/**
 * Constant-time string compare + HTML-safe JSON for EJS <script> embeds.
 */
const crypto = require('crypto');

/**
 * Compare two secrets without leaking length/content via timing.
 * Empty expected or mismatched lengths always fail (after a dummy compare).
 */
function timingSafeEqualString(incoming, expected) {
  const a = Buffer.from(String(incoming == null ? '' : incoming), 'utf8');
  const b = Buffer.from(String(expected == null ? '' : expected), 'utf8');
  if (a.length === 0 || b.length === 0) {
    // Dummy compare so empty-token paths are not a fast-reject oracle.
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.alloc(a.length), Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * True iff any candidate expected secret matches `incoming` in constant time.
 */
function timingSafeEqualAny(incoming, expectedList) {
  const list = (expectedList || []).filter((v) => v != null && String(v).length > 0);
  let matched = false;
  for (const expected of list) {
    if (timingSafeEqualString(incoming, expected)) matched = true;
  }
  if (list.length === 0) {
    timingSafeEqualString(incoming || 'x', 'y');
    return false;
  }
  return matched;
}

/**
 * JSON.stringify that is safe to embed in HTML <script> via <%- ... %>.
 * JSON.stringify does not escape < / U+2028 / U+2029, so a path like
 * </script><img onerror=...> would break out of the script block.
 */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Public voucher order codes are VC-XXXXXX (A-Z / 2-9). Also accept a
 * slightly wider alphanumeric set so older codes still load.
 */
const VOUCHER_ORDER_CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

function isValidVoucherOrderCode(code) {
  return typeof code === 'string' && VOUCHER_ORDER_CODE_RE.test(code);
}

module.exports = {
  timingSafeEqualString,
  timingSafeEqualAny,
  safeJson,
  isValidVoucherOrderCode,
  VOUCHER_ORDER_CODE_RE,
};
