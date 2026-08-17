/**
 * RadiusService.js
 * ─────────────────────────────────────────────────────────────────
 * Backend AAA kompatibel skema MySQL FreeRADIUS (nas, radcheck,
 * radreply, radusergroup, radgroupreply, radacct).
 *
 * Dipakai sebagai sumber otorisasi PPPoE/Hotspot: MikroTik NAS
 * menunjuk ke FreeRADIUS yang membaca tabel yang sama di database CRM.
 * Isolir = Auth-Type := Reject di radcheck.
 */
const { sequelize, AppSetting, Customer, Package, Device } = require('../models');
const { QueryTypes } = require('sequelize');
const crypto = require('crypto');
const logger = require('../utils/logger');

const SETTING_KEYS = {
  enabled:     'radius_enabled',
  secret:      'radius_secret',
  auth_port:   'radius_auth_port',
  acct_port:   'radius_acct_port',
  coa_port:    'radius_coa_port',
  nas_type:    'radius_nas_type',
};

const DEFAULTS = {
  enabled:   '0',
  secret:    'testing123',
  auth_port: '1812',
  acct_port: '1813',
  coa_port:  '3799',
  nas_type:  'mikrotik',
};

let _schemaReady = false;

async function ensureSchema() {
  if (_schemaReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS nas (
      id int(10) NOT NULL AUTO_INCREMENT,
      nasname varchar(128) NOT NULL,
      shortname varchar(32) DEFAULT NULL,
      type varchar(30) DEFAULT 'other',
      ports int(5) DEFAULT NULL,
      secret varchar(60) NOT NULL DEFAULT 'secret',
      server varchar(64) DEFAULT NULL,
      community varchar(50) DEFAULT NULL,
      description varchar(200) DEFAULT 'RADIUS Client',
      PRIMARY KEY (id),
      KEY nasname (nasname)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS radcheck (
      id int(11) UNSIGNED NOT NULL AUTO_INCREMENT,
      username varchar(64) NOT NULL DEFAULT '',
      attribute varchar(64) NOT NULL DEFAULT '',
      op char(2) NOT NULL DEFAULT '==',
      value varchar(253) NOT NULL DEFAULT '',
      PRIMARY KEY (id),
      KEY username (username(32))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS radreply (
      id int(11) UNSIGNED NOT NULL AUTO_INCREMENT,
      username varchar(64) NOT NULL DEFAULT '',
      attribute varchar(64) NOT NULL DEFAULT '',
      op char(2) NOT NULL DEFAULT '=',
      value varchar(253) NOT NULL DEFAULT '',
      PRIMARY KEY (id),
      KEY username (username(32))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS radusergroup (
      id int(11) UNSIGNED NOT NULL AUTO_INCREMENT,
      username varchar(64) NOT NULL DEFAULT '',
      groupname varchar(64) NOT NULL DEFAULT '',
      priority int(11) NOT NULL DEFAULT 1,
      PRIMARY KEY (id),
      KEY username (username(32))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS radgroupcheck (
      id int(11) UNSIGNED NOT NULL AUTO_INCREMENT,
      groupname varchar(64) NOT NULL DEFAULT '',
      attribute varchar(64) NOT NULL DEFAULT '',
      op char(2) NOT NULL DEFAULT '==',
      value varchar(253) NOT NULL DEFAULT '',
      PRIMARY KEY (id),
      KEY groupname (groupname(32))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS radgroupreply (
      id int(11) UNSIGNED NOT NULL AUTO_INCREMENT,
      groupname varchar(64) NOT NULL DEFAULT '',
      attribute varchar(64) NOT NULL DEFAULT '',
      op char(2) NOT NULL DEFAULT '=',
      value varchar(253) NOT NULL DEFAULT '',
      PRIMARY KEY (id),
      KEY groupname (groupname(32))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS radacct (
      radacctid bigint(21) NOT NULL AUTO_INCREMENT,
      acctsessionid varchar(64) NOT NULL DEFAULT '',
      acctuniqueid varchar(32) NOT NULL DEFAULT '',
      username varchar(64) NOT NULL DEFAULT '',
      realm varchar(64) DEFAULT '',
      nasipaddress varchar(15) NOT NULL DEFAULT '',
      nasportid varchar(32) DEFAULT NULL,
      nasporttype varchar(32) DEFAULT NULL,
      acctstarttime datetime DEFAULT NULL,
      acctupdatetime datetime DEFAULT NULL,
      acctstoptime datetime DEFAULT NULL,
      acctsessiontime int(12) UNSIGNED DEFAULT NULL,
      acctauthentic varchar(32) DEFAULT NULL,
      connectinfo_start varchar(50) DEFAULT NULL,
      connectinfo_stop varchar(50) DEFAULT NULL,
      acctinputoctets bigint(20) DEFAULT NULL,
      acctoutputoctets bigint(20) DEFAULT NULL,
      calledstationid varchar(50) NOT NULL DEFAULT '',
      callingstationid varchar(50) NOT NULL DEFAULT '',
      acctterminatecause varchar(32) NOT NULL DEFAULT '',
      servicetype varchar(32) DEFAULT NULL,
      framedprotocol varchar(32) DEFAULT NULL,
      framedipaddress varchar(15) NOT NULL DEFAULT '',
      PRIMARY KEY (radacctid),
      UNIQUE KEY acctuniqueid (acctuniqueid),
      KEY username (username),
      KEY framedipaddress (framedipaddress),
      KEY acctsessionid (acctsessionid),
      KEY acctstarttime (acctstarttime),
      KEY acctstoptime (acctstoptime),
      KEY nasipaddress (nasipaddress)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  for (const sql of stmts) {
    await sequelize.query(sql);
  }
  _schemaReady = true;
  logger.info('[RADIUS] schema ready (FreeRADIUS MySQL tables)');
}

async function getSetting(key, fallback) {
  try {
    const row = await AppSetting.findOne({ where: { key } });
    if (row && row.value != null && row.value !== '') return row.value;
  } catch (_) {}
  return fallback;
}

async function setSetting(key, value, type = 'string') {
  const [row] = await AppSetting.findOrCreate({
    where: { key },
    defaults: { key, value: String(value), type, description: 'RADIUS' }
  });
  await row.update({ value: String(value) });
  return row.value;
}

async function getSettings() {
  const out = {};
  for (const [k, key] of Object.entries(SETTING_KEYS)) {
    out[k] = await getSetting(key, DEFAULTS[k]);
  }
  out.enabled = out.enabled === '1' || out.enabled === 'true';
  out.auth_port = parseInt(out.auth_port) || 1812;
  out.acct_port = parseInt(out.acct_port) || 1813;
  out.coa_port  = parseInt(out.coa_port) || 3799;
  return out;
}

async function saveSettings(body = {}) {
  if (body.enabled != null) {
    await setSetting(SETTING_KEYS.enabled, body.enabled ? '1' : '0', 'boolean');
  }
  if (body.secret != null && String(body.secret).trim()) {
    await setSetting(SETTING_KEYS.secret, String(body.secret).trim());
  }
  if (body.auth_port != null) await setSetting(SETTING_KEYS.auth_port, parseInt(body.auth_port) || 1812, 'number');
  if (body.acct_port != null) await setSetting(SETTING_KEYS.acct_port, parseInt(body.acct_port) || 1813, 'number');
  if (body.coa_port  != null) await setSetting(SETTING_KEYS.coa_port,  parseInt(body.coa_port)  || 3799, 'number');
  if (body.nas_type  != null) await setSetting(SETTING_KEYS.nas_type,  String(body.nas_type).trim() || 'mikrotik');
  return getSettings();
}

function rateLimitFromPackage(pkg) {
  if (!pkg) return null;
  const down = parseInt(pkg.speed_down) || 0;
  const up   = parseInt(pkg.speed_up) || 0;
  if (!down && !up) return null;
  // MikroTik-Rate-Limit: rx/tx (k/M). Paket CRM dalam Mbps.
  const rx = down ? `${down}M` : '0';
  const tx = up   ? `${up}M`   : rx;
  return `${rx}/${tx}`;
}

async function stats() {
  await ensureSchema();
  const [[users]] = await sequelize.query(
    `SELECT COUNT(DISTINCT username) AS c FROM radcheck WHERE attribute IN ('Cleartext-Password','User-Password','NT-Password')`
  );
  const [[disabled]] = await sequelize.query(
    `SELECT COUNT(DISTINCT username) AS c FROM radcheck WHERE attribute='Auth-Type' AND value='Reject'`
  );
  const [[nas]] = await sequelize.query(`SELECT COUNT(*) AS c FROM nas`);
  const [[online]] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM radacct WHERE acctstoptime IS NULL`
  );
  const [[profiles]] = await sequelize.query(
    `SELECT COUNT(DISTINCT groupname) AS c FROM radgroupreply`
  );
  return {
    users:    parseInt(users?.c) || 0,
    disabled: parseInt(disabled?.c) || 0,
    nas:      parseInt(nas?.c) || 0,
    online:   parseInt(online?.c) || 0,
    profiles: parseInt(profiles?.c) || 0,
  };
}

// ── NAS ──────────────────────────────────────────────────────
async function listNas() {
  await ensureSchema();
  return sequelize.query(`SELECT * FROM nas ORDER BY shortname ASC, nasname ASC`, { type: QueryTypes.SELECT });
}

async function createNas({ nasname, shortname, type, secret, ports, description }) {
  await ensureSchema();
  if (!nasname) throw new Error('IP/hostname NAS wajib diisi');
  const settings = await getSettings();
  await sequelize.query(
    `INSERT INTO nas (nasname, shortname, type, secret, ports, description)
     VALUES (?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        String(nasname).trim(),
        (shortname || nasname).toString().slice(0, 32),
        type || settings.nas_type || 'mikrotik',
        (secret || settings.secret || 'testing123').toString().slice(0, 60),
        ports ? parseInt(ports) : null,
        description || 'MikroTik NAS'
      ]
    }
  );
  const rows = await sequelize.query(
    `SELECT * FROM nas WHERE nasname=? ORDER BY id DESC LIMIT 1`,
    { replacements: [String(nasname).trim()], type: QueryTypes.SELECT }
  );
  return rows[0];
}

async function updateNas(id, body = {}) {
  await ensureSchema();
  const rows = await sequelize.query(`SELECT * FROM nas WHERE id=?`, {
    replacements: [id], type: QueryTypes.SELECT
  });
  if (!rows[0]) throw new Error('NAS tidak ditemukan');
  const cur = rows[0];
  await sequelize.query(
    `UPDATE nas SET nasname=?, shortname=?, type=?, secret=?, ports=?, description=? WHERE id=?`,
    {
      replacements: [
        body.nasname != null ? String(body.nasname).trim() : cur.nasname,
        body.shortname != null ? String(body.shortname).slice(0, 32) : cur.shortname,
        body.type != null ? body.type : cur.type,
        body.secret != null && String(body.secret).trim() ? String(body.secret).trim() : cur.secret,
        body.ports != null ? parseInt(body.ports) || null : cur.ports,
        body.description != null ? body.description : cur.description,
        id
      ]
    }
  );
  const updated = await sequelize.query(`SELECT * FROM nas WHERE id=?`, {
    replacements: [id], type: QueryTypes.SELECT
  });
  return updated[0];
}

async function deleteNas(id) {
  await ensureSchema();
  await sequelize.query(`DELETE FROM nas WHERE id=?`, { replacements: [id] });
  return true;
}

async function syncNasFromDevices() {
  await ensureSchema();
  const settings = await getSettings();
  const routers = await Device.findAll({
    where: { type: 'router', is_active: true },
    attributes: ['id', 'name', 'ip_address']
  });
  let created = 0, skipped = 0;
  for (const r of routers) {
    const existing = await sequelize.query(
      `SELECT id FROM nas WHERE nasname=?`,
      { replacements: [r.ip_address], type: QueryTypes.SELECT }
    );
    if (existing[0]) { skipped++; continue; }
    await createNas({
      nasname: r.ip_address,
      shortname: (r.name || r.ip_address).slice(0, 32),
      type: settings.nas_type || 'mikrotik',
      secret: settings.secret,
      description: `Device #${r.id} ${r.name}`
    });
    created++;
  }
  return { created, skipped, total: routers.length };
}

// ── Users ────────────────────────────────────────────────────
async function getUserAttrs(username) {
  const checks = await sequelize.query(
    `SELECT id, attribute, op, value FROM radcheck WHERE username=?`,
    { replacements: [username], type: QueryTypes.SELECT }
  );
  const replies = await sequelize.query(
    `SELECT id, attribute, op, value FROM radreply WHERE username=?`,
    { replacements: [username], type: QueryTypes.SELECT }
  );
  const groups = await sequelize.query(
    `SELECT id, groupname, priority FROM radusergroup WHERE username=? ORDER BY priority ASC`,
    { replacements: [username], type: QueryTypes.SELECT }
  );
  return { checks, replies, groups };
}

function pickAttr(rows, name) {
  const r = (rows || []).find(x => String(x.attribute).toLowerCase() === name.toLowerCase());
  return r ? r.value : null;
}

async function listUsers({ search, status, limit = 200, offset = 0 } = {}) {
  await ensureSchema();
  const lim = Math.min(parseInt(limit) || 200, 500);
  const off = parseInt(offset) || 0;
  let where = `WHERE c.attribute IN ('Cleartext-Password','User-Password','NT-Password')`;
  const repl = [];
  if (search) {
    where += ` AND c.username LIKE ?`;
    repl.push(`%${search}%`);
  }
  const rows = await sequelize.query(
    `SELECT c.username, c.value AS password,
            (SELECT value FROM radcheck r WHERE r.username=c.username AND r.attribute='Auth-Type' AND r.value='Reject' LIMIT 1) AS rejected,
            (SELECT groupname FROM radusergroup g WHERE g.username=c.username ORDER BY g.priority ASC LIMIT 1) AS groupname,
            (SELECT value FROM radreply ip WHERE ip.username=c.username AND ip.attribute='Framed-IP-Address' LIMIT 1) AS framed_ip,
            (SELECT COUNT(*) FROM radacct a WHERE a.username=c.username AND a.acctstoptime IS NULL) AS online
       FROM radcheck c
       ${where}
       GROUP BY c.username
       ORDER BY c.username ASC
       LIMIT ${lim} OFFSET ${off}`,
    { replacements: repl, type: QueryTypes.SELECT }
  );
  let list = rows.map(r => ({
    username:  r.username,
    password:  r.password || '',
    disabled:  !!r.rejected,
    groupname: r.groupname || null,
    framed_ip: r.framed_ip || null,
    online:    parseInt(r.online) > 0
  }));
  if (status === 'disabled') list = list.filter(u => u.disabled);
  if (status === 'active')   list = list.filter(u => !u.disabled);
  if (status === 'online')   list = list.filter(u => u.online);
  return list;
}

async function upsertAttr(table, username, attribute, op, value) {
  const rows = await sequelize.query(
    `SELECT id FROM ${table} WHERE username=? AND attribute=?`,
    { replacements: [username, attribute], type: QueryTypes.SELECT }
  );
  if (value == null || value === '') {
    if (rows[0]) {
      await sequelize.query(`DELETE FROM ${table} WHERE id=?`, { replacements: [rows[0].id] });
    }
    return;
  }
  if (rows[0]) {
    await sequelize.query(
      `UPDATE ${table} SET op=?, value=? WHERE id=?`,
      { replacements: [op, String(value), rows[0].id] }
    );
  } else {
    await sequelize.query(
      `INSERT INTO ${table} (username, attribute, op, value) VALUES (?, ?, ?, ?)`,
      { replacements: [username, attribute, op, String(value)] }
    );
  }
}

async function setUserGroup(username, groupname) {
  await sequelize.query(`DELETE FROM radusergroup WHERE username=?`, { replacements: [username] });
  if (groupname) {
    await sequelize.query(
      `INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)`,
      { replacements: [username, groupname] }
    );
  }
}

async function upsertUser({ username, password, groupname, framed_ip, disabled }) {
  await ensureSchema();
  const user = String(username || '').trim();
  if (!user) throw new Error('Username wajib diisi');
  if (password != null && password !== '') {
    await upsertAttr('radcheck', user, 'Cleartext-Password', ':=', password);
  } else {
    const existing = await sequelize.query(
      `SELECT id FROM radcheck WHERE username=? AND attribute='Cleartext-Password'`,
      { replacements: [user], type: QueryTypes.SELECT }
    );
    if (!existing[0]) {
      const gen = crypto.randomBytes(4).toString('hex');
      await upsertAttr('radcheck', user, 'Cleartext-Password', ':=', gen);
    }
  }
  if (framed_ip !== undefined) {
    await upsertAttr('radreply', user, 'Framed-IP-Address', '=', framed_ip || null);
  }
  if (groupname !== undefined) await setUserGroup(user, groupname || null);
  if (disabled === true) await disableUser(user);
  if (disabled === false) await enableUser(user);
  return getUser(user);
}

async function getUser(username) {
  await ensureSchema();
  const { checks, replies, groups } = await getUserAttrs(username);
  if (!checks.length && !replies.length && !groups.length) return null;
  return {
    username,
    password:  pickAttr(checks, 'Cleartext-Password') || pickAttr(checks, 'User-Password') || '',
    disabled:  pickAttr(checks, 'Auth-Type') === 'Reject',
    groupname: groups[0]?.groupname || null,
    framed_ip: pickAttr(replies, 'Framed-IP-Address'),
    checks, replies, groups
  };
}

async function deleteUser(username) {
  await ensureSchema();
  await sequelize.query(`DELETE FROM radcheck WHERE username=?`, { replacements: [username] });
  await sequelize.query(`DELETE FROM radreply WHERE username=?`, { replacements: [username] });
  await sequelize.query(`DELETE FROM radusergroup WHERE username=?`, { replacements: [username] });
  return true;
}

async function disableUser(username) {
  if (!username) return false;
  await ensureSchema();
  await upsertAttr('radcheck', username, 'Auth-Type', ':=', 'Reject');
  return true;
}

async function enableUser(username) {
  if (!username) return false;
  await ensureSchema();
  await sequelize.query(
    `DELETE FROM radcheck WHERE username=? AND attribute='Auth-Type'`,
    { replacements: [username] }
  );
  return true;
}

async function syncCustomers() {
  await ensureSchema();
  const customers = await Customer.findAll({
    where: { pppoe_username: { [require('sequelize').Op.ne]: null } },
    include: [{ model: Package, as: 'package', required: false }],
    attributes: ['id', 'name', 'pppoe_username', 'static_ip', 'status', 'isolir_status', 'package_id']
  });
  let created = 0, updated = 0, skipped = 0;
  for (const c of customers) {
    const username = String(c.pppoe_username || '').trim();
    if (!username) { skipped++; continue; }
    const existing = await getUser(username);
    const pkg = c.package || null;
    const groupname = (pkg && (pkg.mikrotik_profile || pkg.name))
      ? String(pkg.mikrotik_profile || pkg.name).slice(0, 64)
      : null;
    if (groupname) await ensureProfile(groupname, pkg);
    const disabled = c.status === 'isolated' || c.isolir_status === 'isolated' || c.status === 'suspended';
    await upsertUser({
      username,
      password: existing?.password || null,
      groupname,
      framed_ip: c.static_ip || null,
      disabled
    });
    if (existing) updated++; else created++;
  }
  return { created, updated, skipped, total: customers.length };
}

// ── Profiles / groups ────────────────────────────────────────
async function listProfiles() {
  await ensureSchema();
  const rows = await sequelize.query(
    `SELECT groupname, attribute, op, value FROM radgroupreply ORDER BY groupname, id`,
    { type: QueryTypes.SELECT }
  );
  const map = {};
  for (const r of rows) {
    if (!map[r.groupname]) map[r.groupname] = { groupname: r.groupname, attributes: [] };
    map[r.groupname].attributes.push({ attribute: r.attribute, op: r.op, value: r.value });
  }
  const counts = await sequelize.query(
    `SELECT groupname, COUNT(*) AS c FROM radusergroup GROUP BY groupname`,
    { type: QueryTypes.SELECT }
  );
  const countMap = {};
  counts.forEach(c => { countMap[c.groupname] = parseInt(c.c) || 0; });
  return Object.values(map).map(p => ({
    ...p,
    rate_limit: (p.attributes.find(a => a.attribute === 'Mikrotik-Rate-Limit') || {}).value || null,
    users: countMap[p.groupname] || 0
  }));
}

async function ensureProfile(groupname, pkg) {
  if (!groupname) return;
  const existing = await sequelize.query(
    `SELECT id FROM radgroupreply WHERE groupname=? AND attribute='Mikrotik-Rate-Limit'`,
    { replacements: [groupname], type: QueryTypes.SELECT }
  );
  const rate = rateLimitFromPackage(pkg);
  if (rate) {
    if (existing[0]) {
      await sequelize.query(
        `UPDATE radgroupreply SET value=? WHERE id=?`,
        { replacements: [rate, existing[0].id] }
      );
    } else {
      await sequelize.query(
        `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Rate-Limit', '=', ?)`,
        { replacements: [groupname, rate] }
      );
    }
  } else if (!existing[0]) {
    // Pastikan group ada meski tanpa rate-limit
    const any = await sequelize.query(
      `SELECT id FROM radgroupreply WHERE groupname=? LIMIT 1`,
      { replacements: [groupname], type: QueryTypes.SELECT }
    );
    if (!any[0]) {
      await sequelize.query(
        `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Service-Type', '=', 'Framed-User')`,
        { replacements: [groupname] }
      );
    }
  }
}

async function saveProfile({ groupname, rate_limit, pool }) {
  await ensureSchema();
  const name = String(groupname || '').trim();
  if (!name) throw new Error('Nama profile wajib diisi');
  if (rate_limit != null) {
    const rows = await sequelize.query(
      `SELECT id FROM radgroupreply WHERE groupname=? AND attribute='Mikrotik-Rate-Limit'`,
      { replacements: [name], type: QueryTypes.SELECT }
    );
    if (rate_limit === '') {
      if (rows[0]) await sequelize.query(`DELETE FROM radgroupreply WHERE id=?`, { replacements: [rows[0].id] });
    } else if (rows[0]) {
      await sequelize.query(`UPDATE radgroupreply SET value=? WHERE id=?`, { replacements: [rate_limit, rows[0].id] });
    } else {
      await sequelize.query(
        `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Mikrotik-Rate-Limit', '=', ?)`,
        { replacements: [name, rate_limit] }
      );
    }
  }
  if (pool != null) {
    const rows = await sequelize.query(
      `SELECT id FROM radgroupreply WHERE groupname=? AND attribute='Framed-Pool'`,
      { replacements: [name], type: QueryTypes.SELECT }
    );
    if (pool === '') {
      if (rows[0]) await sequelize.query(`DELETE FROM radgroupreply WHERE id=?`, { replacements: [rows[0].id] });
    } else if (rows[0]) {
      await sequelize.query(`UPDATE radgroupreply SET value=? WHERE id=?`, { replacements: [pool, rows[0].id] });
    } else {
      await sequelize.query(
        `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'Framed-Pool', '=', ?)`,
        { replacements: [name, pool] }
      );
    }
  }
  await ensureProfile(name, null);
  const all = await listProfiles();
  return all.find(p => p.groupname === name) || { groupname: name, attributes: [], users: 0 };
}

async function deleteProfile(groupname) {
  await ensureSchema();
  await sequelize.query(`DELETE FROM radgroupreply WHERE groupname=?`, { replacements: [groupname] });
  await sequelize.query(`DELETE FROM radgroupcheck WHERE groupname=?`, { replacements: [groupname] });
  await sequelize.query(`DELETE FROM radusergroup WHERE groupname=?`, { replacements: [groupname] });
  return true;
}

async function listSessions({ activeOnly = true, search, limit = 200 } = {}) {
  await ensureSchema();
  const lim = Math.min(parseInt(limit) || 200, 500);
  let sql = `SELECT radacctid, username, nasipaddress, framedipaddress, callingstationid,
                    acctstarttime, acctstoptime, acctsessiontime, acctinputoctets, acctoutputoctets,
                    acctterminatecause
               FROM radacct`;
  const repl = [];
  const cond = [];
  if (activeOnly) cond.push('acctstoptime IS NULL');
  if (search) {
    cond.push('(username LIKE ? OR framedipaddress LIKE ? OR callingstationid LIKE ?)');
    repl.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ` ORDER BY acctstarttime DESC LIMIT ${lim}`;
  return sequelize.query(sql, { replacements: repl, type: QueryTypes.SELECT });
}

module.exports = {
  ensureSchema,
  getSettings,
  saveSettings,
  stats,
  listNas,
  createNas,
  updateNas,
  deleteNas,
  syncNasFromDevices,
  listUsers,
  getUser,
  upsertUser,
  deleteUser,
  disableUser,
  enableUser,
  syncCustomers,
  listProfiles,
  saveProfile,
  deleteProfile,
  listSessions,
};
