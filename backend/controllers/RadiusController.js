/**
 * RadiusController.js — AAA FreeRADIUS (tabel nas/radcheck/radreply/…)
 */
const Radius = require('../services/RadiusService');
const logger = require('../utils/logger');

function wrap(fn) {
  return async (req, res) => {
    try {
      await Radius.ensureSchema();
      await fn(req, res);
    } catch (e) {
      logger.error('[RADIUS] ' + e.message);
      const code = /tidak ditemukan|wajib diisi|tidak valid|hanya huruf/i.test(e.message) ? 400 : 500;
      res.status(code).json({ success: false, message: e.message });
    }
  };
}

exports.stats = wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const [stats, settings] = await Promise.all([Radius.stats(), Radius.getSettings()]);
  res.json({ success: true, data: { ...stats, settings } });
});

exports.getSettings = wrap(async (req, res) => {
  res.json({ success: true, data: await Radius.getSettings() });
});

exports.saveSettings = wrap(async (req, res) => {
  const data = await Radius.saveSettings(req.body || {});
  res.json({ success: true, data, message: 'Pengaturan RADIUS disimpan' });
});

exports.listNas = wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await Radius.listNas() });
});

exports.showNas = wrap(async (req, res) => {
  const row = await Radius.getNas(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'NAS tidak ditemukan' });
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: row });
});

exports.getNasScript = wrap(async (req, res) => {
  const row = await Radius.getNas(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'NAS tidak ditemukan' });
  const version = String(req.query.version || 'v6').toLowerCase() === 'v7' ? 'v7' : 'v6';
  const script = row.scripts?.[version];
  if (!script) {
    return res.status(400).json({
      success: false,
      message: row.scripts?.error || 'Lengkapi data VPN, profile PPP, dan RADIUS untuk membuat script',
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    data: { version, script, title: version === 'v7' ? 'RouterOS v7 Script (Format redirect-to, tanpa PPTP)' : 'RouterOS v6 Script (Format redirect-to)' },
  });
});

exports.createNas = wrap(async (req, res) => {
  const row = await Radius.createNas(req.body || {});
  res.status(201).json({ success: true, data: row, message: 'NAS ditambahkan' });
});

exports.updateNas = wrap(async (req, res) => {
  const row = await Radius.updateNas(req.params.id, req.body || {});
  res.json({ success: true, data: row, message: 'NAS diupdate' });
});

exports.deleteNas = wrap(async (req, res) => {
  await Radius.deleteNas(req.params.id);
  res.json({ success: true, message: 'NAS dihapus' });
});

exports.syncNas = wrap(async (req, res) => {
  const result = await Radius.syncNasFromDevices();
  res.json({
    success: true,
    data: result,
    message: `Sinkron NAS: ${result.created} baru, ${result.skipped} sudah ada`
  });
});

exports.listUsers = wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const data = await Radius.listUsers({
    search: req.query.search,
    status: req.query.status,
    limit:  req.query.limit,
    offset: req.query.offset
  });
  res.json({ success: true, data });
});

exports.showUser = wrap(async (req, res) => {
  const user = await Radius.getUser(req.params.username);
  if (!user) return res.status(404).json({ success: false, message: 'User RADIUS tidak ditemukan' });
  res.json({ success: true, data: user });
});

exports.createUser = wrap(async (req, res) => {
  const user = await Radius.upsertUser(req.body || {});
  res.status(201).json({ success: true, data: user, message: 'User RADIUS disimpan' });
});

exports.updateUser = wrap(async (req, res) => {
  const body = { ...(req.body || {}), username: req.params.username };
  const user = await Radius.upsertUser(body);
  res.json({ success: true, data: user, message: 'User RADIUS diupdate' });
});

exports.deleteUser = wrap(async (req, res) => {
  await Radius.deleteUser(req.params.username);
  res.json({ success: true, message: 'User RADIUS dihapus' });
});

exports.enableUser = wrap(async (req, res) => {
  await Radius.enableUser(req.params.username);
  res.json({ success: true, message: 'User diaktifkan' });
});

exports.disableUser = wrap(async (req, res) => {
  await Radius.disableUser(req.params.username);
  res.json({ success: true, message: 'User dinonaktifkan (isolir RADIUS)' });
});

exports.syncCustomers = wrap(async (req, res) => {
  const result = await Radius.syncCustomers();
  res.json({
    success: true,
    data: result,
    message: `Sinkron pelanggan: ${result.created} baru, ${result.updated} diupdate`
  });
});

exports.listProfiles = wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await Radius.listProfiles() });
});

exports.saveProfile = wrap(async (req, res) => {
  const row = await Radius.saveProfile(req.body || {});
  res.json({ success: true, data: row, message: 'Profile disimpan' });
});

exports.deleteProfile = wrap(async (req, res) => {
  await Radius.deleteProfile(req.params.groupname);
  res.json({ success: true, message: 'Profile dihapus' });
});

exports.listSessions = wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const data = await Radius.listSessions({
    activeOnly: req.query.all !== '1',
    search: req.query.search,
    limit: req.query.limit
  });
  res.json({ success: true, data });
});
