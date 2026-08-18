/**
 * RADIUS AAA is network-auth config (NAS secret, radcheck).
 * Only admin / superadmin / NOC may open the page or call the API.
 * Finance, sales, kasir/cashier, technician, and demo are blocked.
 */

const RADIUS_ROLES = new Set(['superadmin', 'admin', 'noc']);

const HOME_BY_ROLE = {
  finance: '/finance',
  kasir: '/finance',
  cashier: '/finance',
  sales: '/sales',
  technician: '/technician',
  demo: '/dashboard',
};

function roleName(req) {
  return (req.user?.role?.name || '').toLowerCase();
}

function allowRadiusPage(req, res, next) {
  if (!req.user) return res.redirect('/login');
  const r = roleName(req);
  if (RADIUS_ROLES.has(r)) return next();
  return res.redirect(HOME_BY_ROLE[r] || '/dashboard');
}

function allowRadiusApi(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  if (RADIUS_ROLES.has(roleName(req))) return next();
  return res.status(403).json({
    success: false,
    message: 'Modul RADIUS hanya untuk admin dan NOC',
  });
}

module.exports = { allowRadiusPage, allowRadiusApi };
