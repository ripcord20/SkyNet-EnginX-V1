/**
 * Staff JWT audience helpers.
 *
 * Portal tokens carry type:'customer', reseller tokens type:'reseller'.
 * New staff tokens mint type:'staff'. Legacy staff tokens (valid up to
 * JWT_EXPIRY, default 30d) have no type claim — still accepted during rollout.
 */
function isStaffJwtPayload(decoded) {
  if (!decoded || typeof decoded !== 'object') return false;
  const type = decoded.type;
  if (type === 'customer' || type === 'reseller') return false;
  if (type && type !== 'staff') return false;
  return true;
}

module.exports = { isStaffJwtPayload };
