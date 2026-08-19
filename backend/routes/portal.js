/**
 * portal.js — Routes Customer Portal
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router  = express.Router();
const { portalAuth } = require('../middleware/portalAuth');
const PortalCtrl     = require('../controllers/CustomerPortalController');
const { timingSafeEqualString, timingSafeEqualAny } = require('../utils/cryptoSafe');
const logger = require('../utils/logger');

const waWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many webhook requests' }
});

function incomingFonnteToken(req) {
  return req.headers['x-webhook-token']
    || req.headers['token']
    || (req.body && req.body.token)
    || (req.query && req.query.token)
    || '';
}

async function verifyFonnteWebhook(req, res, next) {
  try {
    const expected = String(process.env.FONNTE_WEBHOOK_TOKEN || '').trim();
    if (!expected) {
      logger.error('[Fonnte] Webhook: FONNTE_WEBHOOK_TOKEN not configured — rejecting');
      return res.status(503).json({ success: false, message: 'Webhook not configured' });
    }
    if (!timingSafeEqualString(incomingFonnteToken(req), expected)) {
      logger.warn('[Fonnte] Webhook: invalid token');
      return res.status(403).json({ success: false, message: 'Invalid webhook token' });
    }
    next();
  } catch (e) {
    logger.error('[Fonnte] Webhook auth error: ' + (e.message || e));
    return res.status(500).json({ success: false });
  }
}

async function verifyWahaWebhook(req, res, next) {
  try {
    const incoming = req.headers['x-api-key'] || req.headers['x-webhook-api-key'] || '';
    const { WaSession } = require('../models');
    const sessions = await WaSession.findAll({
      where: { provider: 'waha' },
      attributes: ['waha_api_key']
    });
    const keys = sessions.map(s => String(s.waha_api_key || '').trim()).filter(Boolean);
    if (!keys.length) {
      logger.error('[WAHA] Webhook: no session API key configured — rejecting');
      return res.status(503).json({ success: false, message: 'Webhook not configured' });
    }
    if (!timingSafeEqualAny(incoming, keys)) {
      logger.warn('[WAHA] Webhook: invalid X-Api-Key');
      return res.status(403).json({ success: false, message: 'Invalid webhook token' });
    }
    next();
  } catch (e) {
    logger.error('[WAHA] Webhook auth error: ' + (e.message || e));
    return res.status(500).json({ success: false });
  }
}

// ── Public pages ──────────────────────────────────────────────
// /portal/login — auto-redirect kalau customer sudah punya session valid.
// Pattern sama dengan /login admin: cek cookie portal_token, kalau JWT
// valid + customer masih portal_enabled + tidak suspended → redirect ke
// /portal/dashboard.
router.get('/login', async (req, res) => {
  try {
    const token = req.cookies && req.cookies.portal_token;
    if (token) {
      const jwt = require('jsonwebtoken');
      const { Customer } = require('../models');
      try {
        const portalSecret = process.env.JWT_PORTAL_SECRET || process.env.JWT_SECRET;
        const decoded = jwt.verify(token, portalSecret);
        if (decoded.type === 'customer') {
          const customer = await Customer.findByPk(decoded.id);
          if (customer && customer.portal_enabled && customer.status !== 'suspended') {
            return res.redirect('/portal/dashboard');
          }
        }
        // Token tidak valid kontekstual — clear cookie
        res.clearCookie('portal_token', { path: '/portal' });
      } catch (_) {
        res.clearCookie('portal_token', { path: '/portal' });
      }
    }
  } catch (_) { /* defensive — tetap render kalau check error */ }
  res.render('portal/login', { title: 'Customer Portal', layout: false });
});

// ── Auth ──────────────────────────────────────────────────────
router.post('/api/auth/login', PortalCtrl.login);
// Restore HttpOnly cookie dari Bearer token — dipakai /portal/login
// untuk auto-login (lihat AuthController.restoreCookie untuk pattern admin).
router.post('/api/auth/restore-cookie', PortalCtrl.restoreCookie);
// Logout — clear HttpOnly cookie portal_token. Tidak butuh portalAuth karena
// kita ingin logout tetap jalan walau token sudah expired/invalid (idempotent).
router.post('/api/auth/logout', PortalCtrl.logout);

// ── Public (no auth) ──────────────────────────────────────────
router.get('/api/public/meta', PortalCtrl.publicMeta);

// ── Protected pages ───────────────────────────────────────────
router.get('/',         portalAuth, (req, res) => res.render('portal/dashboard', { title: 'Dashboard', layout: false, customer: req.portalUser }));
router.get('/dashboard',portalAuth, (req, res) => res.render('portal/dashboard', { title: 'Dashboard', layout: false, customer: req.portalUser }));

// Payment result pages (render halaman dedicated, bukan dashboard)
router.get('/payment/finish',  (req, res) => res.render('portal/payment-result', {
  title: 'Status Pembayaran', layout: false, status: 'finish', invoiceId: req.query.invoice || ''
}));
router.get('/payment/pending', (req, res) => res.render('portal/payment-result', {
  title: 'Pembayaran Pending', layout: false, status: 'pending', invoiceId: req.query.invoice || ''
}));

// ── Protected API ─────────────────────────────────────────────
router.get ('/api/dashboard',     portalAuth, PortalCtrl.dashboard);
router.get ('/api/announcements', portalAuth, PortalCtrl.announcements);
router.get ('/api/packages',        portalAuth, PortalCtrl.packageList);
router.get ('/api/upgrade/status',  portalAuth, PortalCtrl.checkUpgradeStatus);
router.post('/api/upgrade',         portalAuth, PortalCtrl.requestUpgrade);
router.get ('/api/traffic',       portalAuth, PortalCtrl.traffic);
router.get ('/api/signal',        portalAuth, PortalCtrl.signal);
router.post('/api/reboot',        portalAuth, PortalCtrl.reboot);
router.get ('/api/billing',       portalAuth, PortalCtrl.billing);
router.put ('/api/password',      portalAuth, PortalCtrl.changePassword);
router.put ('/api/profile',       portalAuth, PortalCtrl.updateProfile);

// WiFi (ONT via GenieACS)
router.get ('/api/wifi',          portalAuth, PortalCtrl.wifiStatus);
router.post('/api/wifi',          portalAuth, PortalCtrl.wifiSet);

// Tiket (tetap ada tapi tidak di nav utama)
router.get ('/api/tickets',       portalAuth, PortalCtrl.ticketList);
router.post('/api/tickets',       portalAuth, PortalCtrl.ticketCreate);

// Payment gateway
router.post('/api/pay',                   portalAuth, PortalCtrl.createPayment);
router.get ('/api/tripay/channels',       portalAuth, PortalCtrl.tripayChannels);
router.get ('/api/invoice/:id/status',    portalAuth, PortalCtrl.invoiceStatus);

// Push Notification (hybrid: Web Push / VAPID + FCM for Android APK)
router.get ('/api/push/vapid-key',       portalAuth, PortalCtrl.pushVapidKey);
router.get ('/api/push/status',          portalAuth, PortalCtrl.pushStatus);
router.post('/api/push/subscribe',                   PortalCtrl.pushSubscribe);       // web, no auth (called from SW)
router.post('/api/push/subscribe-auth',  portalAuth, PortalCtrl.pushSubscribe);       // web, with auth
router.post('/api/push/unsubscribe',     portalAuth, PortalCtrl.pushUnsubscribe);
router.post('/api/push/register-fcm',    portalAuth, PortalCtrl.pushRegisterFcm);     // Android APK
router.post('/api/push/unregister-fcm',  portalAuth, PortalCtrl.pushUnregisterFcm);   // Android APK

// Webhooks (public — tidak pakai portalAuth, validasi internal)
router.post('/webhook/midtrans',  PortalCtrl.midtransNotif);
router.post('/webhook/xendit',    PortalCtrl.xenditNotif);
// Fonnte: pesan WA MASUK dari customer. Fonnte POST ke sini (set di
// dashboard Fonnte → device → webhook URL). Body JSON: {device,sender,message,...}.
// Auth: FONNTE_WEBHOOK_TOKEN (env) must match the webhook token set in the Fonnte dashboard.
router.post('/webhook/fonnte', waWebhookLimiter, verifyFonnteWebhook, async (req, res) => {
  try {
    const FonnteService = require('../services/FonnteService');
    const io = req.app.get('io');
    // Balas cepat supaya Fonnte tidak timeout; proses tetap jalan.
    res.json({ status: true });
    await FonnteService.handleWebhook(req.body || {}, io);
  } catch (e) {
    // Sudah balas 200 di atas; cukup log.
    try { require('../utils/logger').error('[Fonnte] Webhook error: ' + e.message); } catch (_) {}
  }
});
// WAHA: event pesan/status dari instance WAHA self-hosted. Set otomatis saat
// session dibuat via API (kalau APP_URL terisi), atau manual di dashboard WAHA
// → session → webhooks: {APP_URL}/portal/webhook/waha
// Events: message, message.any, session.status. Auth: X-Api-Key harus cocok
// dengan wa_sessions.waha_api_key (dikirim sebagai customHeaders saat session dibuat).
router.post('/webhook/waha', waWebhookLimiter, verifyWahaWebhook, async (req, res) => {
  try {
    const WahaService = require('../services/WahaService');
    const io = req.app.get('io');
    // Balas cepat supaya WAHA tidak retry karena timeout; proses tetap jalan.
    res.json({ status: true });
    await WahaService.handleWebhook(req.body || {}, io);
  } catch (e) {
    // Sudah balas 200 di atas; cukup log.
    try { require('../utils/logger').error('[WAHA] Webhook error: ' + e.message); } catch (_) {}
  }
});
// Duitku kirim callback sebagai application/x-www-form-urlencoded.
// Express sudah pasang urlencoded() global di server.js, jadi cukup register handler.
router.post('/webhook/duitku',    PortalCtrl.duitkuNotif);
// Tripay: signature = HMAC-SHA256(rawBody, privateKey) → perlu raw body ASLI.
// req.rawBody sudah ditangkap global via express.json({verify}) di server.js, dan req.body
// sudah di-parse jadi objek JSON. Tidak perlu express.raw lagi (justru merusak: stream body
// sudah dikonsumsi json global, sehingga express.raw hanya menghasilkan buffer kosong).
router.post('/webhook/tripay', PortalCtrl.tripayNotif);

module.exports = router;