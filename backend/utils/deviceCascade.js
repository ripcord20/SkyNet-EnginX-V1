'use strict';

/**
 * Device boleh dihapus kapan saja. Modul lain (Network Health, log,
 * NMS, isolir, reseller, …) tidak boleh menahan baris di `devices`.
 *
 * Strategi:
 *   1. Lepas / hapus semua baris yang mereferensi devices.id
 *   2. (startup) ubah FK yang sudah ada jadi ON DELETE CASCADE / SET NULL
 *      supaya hapus berikutnya tidak bergantung pada daftar tabel hardcode.
 */

const KEEP_TABLES = new Set([
  'customers',
  'resellers',
  'reseller_voucher_packages',
  'reseller_voucher_logs',
]);

const EXTRA_SET_NULL = [
  { table: 'customers', column: 'mikrotik_id' },
  { table: 'resellers', column: 'device_id' },
  { table: 'reseller_voucher_packages', column: 'device_id' },
  { table: 'reseller_voucher_logs', column: 'device_id' },
];

const EXTRA_DELETE = [
  { table: 'network_health_samples', column: 'device_id' },
  { table: 'network_health_snapshots', column: 'device_id' },
  { table: 'device_logs', column: 'device_id' },
  { table: 'traffic_data', column: 'device_id' },
  { table: 'noc_monitor_presets', column: 'router_id' },
  { table: 'nms_interface_presets', column: 'router_id' },
  { table: 'nms_interfaces', column: 'device_id' },
  { table: 'pppoe_provision_jobs', column: 'device_id' },
  { table: 'mikrotik_devices', column: 'device_id' },
  { table: 'device_metrics', column: 'device_id' },
  { table: 'device_alerts', column: 'device_id' },
  { table: 'interface_stats', column: 'device_id' },
  { table: 'hotspot_traffic_log', column: 'device_id' },
];

function ident(name) {
  const s = String(name || '');
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error('Invalid SQL identifier');
  return '`' + s + '`';
}

function isIgnorable(err) {
  return /doesn'?t exist|Unknown table|no such table|ER_NO_SUCH_TABLE|Unknown column|ER_BAD_FIELD_ERROR/i
    .test(String(err && err.message || err || ''));
}

function parseFkTableFromError(msg) {
  const s = String(msg || '');
  const m = s.match(/fails\s*\(`[^`]+`\.`([^`]+)`/i)
    || s.match(/constraint fails[^(]*\(`[^`]+`\.`([^`]+)`/i)
    || s.match(/`\w+`\.`(\w+)`/);
  return m ? m[1] : null;
}

async function q(sequelize, sql, replacements, transaction) {
  try {
    await sequelize.query(sql, { replacements: replacements || [], transaction });
  } catch (e) {
    if (!isIgnorable(e)) throw e;
  }
}

async function listDeviceForeignKeys(sequelize) {
  const { QueryTypes } = require('sequelize');
  const rows = await sequelize.query(`
    SELECT
      rc.CONSTRAINT_NAME AS constraintName,
      kcu.TABLE_NAME     AS tableName,
      kcu.COLUMN_NAME    AS columnName,
      rc.DELETE_RULE     AS deleteRule,
      c.IS_NULLABLE      AS isNullable
    FROM information_schema.REFERENTIAL_CONSTRAINTS rc
    JOIN information_schema.KEY_COLUMN_USAGE kcu
      ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
     AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
     AND rc.TABLE_NAME        = kcu.TABLE_NAME
    JOIN information_schema.COLUMNS c
      ON c.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
     AND c.TABLE_NAME   = kcu.TABLE_NAME
     AND c.COLUMN_NAME  = kcu.COLUMN_NAME
    WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
      AND kcu.REFERENCED_TABLE_NAME = 'devices'
      AND kcu.REFERENCED_COLUMN_NAME = 'id'
  `, { type: QueryTypes.SELECT });
  return (rows || []).map(r => ({
    constraintName: r.constraintName || r.CONSTRAINT_NAME,
    tableName:      r.tableName || r.TABLE_NAME,
    columnName:     r.columnName || r.COLUMN_NAME,
    deleteRule:     r.deleteRule || r.DELETE_RULE,
    isNullable:     r.isNullable || r.IS_NULLABLE,
  }));
}

function desiredDeleteRule(row) {
  if (KEEP_TABLES.has(row.tableName) || row.isNullable === 'YES') return 'SET NULL';
  return 'CASCADE';
}

/**
 * Ubah FK yang mereferensi devices.id menjadi CASCADE / SET NULL.
 * Dipanggil sekali saat startup (idempotent).
 */
async function ensureDeviceFkRules(sequelize, logger) {
  let fks = [];
  try {
    fks = await listDeviceForeignKeys(sequelize);
  } catch (e) {
    if (logger) logger.warn('[deviceCascade] list FK skipped: ' + e.message);
    return;
  }
  for (const fk of fks) {
    const want = desiredDeleteRule(fk);
    const have = String(fk.deleteRule || '').toUpperCase().replace('_', ' ');
    if (have === want) continue;
    if (want === 'SET NULL' && fk.isNullable === 'NO') continue;
    try {
      await sequelize.query(
        `ALTER TABLE ${ident(fk.tableName)} DROP FOREIGN KEY ${ident(fk.constraintName)}`
      );
      await sequelize.query(
        `ALTER TABLE ${ident(fk.tableName)} ADD CONSTRAINT ${ident(fk.constraintName)} ` +
        `FOREIGN KEY (${ident(fk.columnName)}) REFERENCES \`devices\` (\`id\`) ` +
        `ON DELETE ${want} ON UPDATE CASCADE`
      );
      if (logger) logger.info(`[deviceCascade] ${fk.tableName}.${fk.columnName} → ON DELETE ${want}`);
    } catch (e) {
      if (logger) logger.warn(`[deviceCascade] alter ${fk.tableName} skipped: ${e.message}`);
    }
  }
}

async function unlinkDevice(sequelize, deviceId, transaction) {
  const id = parseInt(deviceId, 10);
  if (!id) return;

  // Anak dari mikrotik_devices / pppoe jobs harus lebih dulu.
  await q(sequelize,
    `DELETE FROM isolir_bypass_router
      WHERE device_id IN (SELECT id FROM mikrotik_devices WHERE device_id = ?)`,
    [id], transaction);
  await q(sequelize,
    `UPDATE customers SET mikrotik_id = NULL
      WHERE mikrotik_id IN (SELECT id FROM mikrotik_devices WHERE device_id = ?)`,
    [id], transaction);
  await q(sequelize,
    `DELETE FROM pppoe_provision_items
      WHERE job_id IN (SELECT id FROM pppoe_provision_jobs WHERE device_id = ?)`,
    [id], transaction);
  await q(sequelize,
    `DELETE FROM monitor_states WHERE kind = 'device' AND ref_id = ?`,
    [String(id)], transaction);

  for (const row of EXTRA_SET_NULL) {
    await q(sequelize,
      `UPDATE ${ident(row.table)} SET ${ident(row.column)} = NULL WHERE ${ident(row.column)} = ?`,
      [id], transaction);
  }
  for (const row of EXTRA_DELETE) {
    await q(sequelize,
      `DELETE FROM ${ident(row.table)} WHERE ${ident(row.column)} = ?`,
      [id], transaction);
  }

  let fks = [];
  try { fks = await listDeviceForeignKeys(sequelize); } catch (_) { fks = []; }
  const seen = new Set(EXTRA_SET_NULL.concat(EXTRA_DELETE).map(r => r.table + '.' + r.column));
  for (const fk of fks) {
    const key = fk.tableName + '.' + fk.columnName;
    if (seen.has(key)) continue;
    seen.add(key);
    if (KEEP_TABLES.has(fk.tableName) || fk.isNullable === 'YES') {
      await q(sequelize,
        `UPDATE ${ident(fk.tableName)} SET ${ident(fk.columnName)} = NULL WHERE ${ident(fk.columnName)} = ?`,
        [id], transaction);
    } else {
      await q(sequelize,
        `DELETE FROM ${ident(fk.tableName)} WHERE ${ident(fk.columnName)} = ?`,
        [id], transaction);
    }
  }
}

/**
 * Hapus device meski masih ada FK yang tidak kita kenal.
 * SET FOREIGN_KEY_CHECKS bersifat session — selalu dikembalikan ke 1
 * di `finally` supaya koneksi pool tidak "bocor" FK checks mati.
 */
async function forceDeleteDevice(sequelize, deviceId, transaction) {
  const id = parseInt(deviceId, 10);
  if (!id) return;

  try {
    await unlinkDevice(sequelize, id, transaction);
  } catch (_) { /* lanjut pakai FK_CHECKS=0 */ }

  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0', { transaction });
  try {
    for (const row of EXTRA_SET_NULL) {
      await sequelize.query(
        `UPDATE ${ident(row.table)} SET ${ident(row.column)} = NULL WHERE ${ident(row.column)} = ?`,
        { replacements: [id], transaction }
      ).catch(() => {});
    }
    for (const row of EXTRA_DELETE) {
      await sequelize.query(
        `DELETE FROM ${ident(row.table)} WHERE ${ident(row.column)} = ?`,
        { replacements: [id], transaction }
      ).catch(() => {});
    }
    await sequelize.query(
      'DELETE FROM `devices` WHERE id = ?',
      { replacements: [id], transaction }
    );
  } finally {
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1', { transaction });
  }
}

function statusRank(device) {
  const st = String(device && device.status || '').toLowerCase();
  if (st === 'online') return 3;
  if (st === 'warning') return 2;
  if (st === 'offline') return 1;
  return 0;
}

/** Pilih 1 device yang dipertahankan saat IP duplikat. */
function pickDeviceToKeep(devices) {
  const list = Array.isArray(devices) ? devices.slice() : [];
  if (!list.length) return null;
  list.sort((a, b) => {
    const ra = statusRank(a);
    const rb = statusRank(b);
    if (rb !== ra) return rb - ra;
    const ta = new Date(a.last_polled || 0).getTime();
    const tb = new Date(b.last_polled || 0).getTime();
    if (tb !== ta) return tb - ta;
    return (b.id || 0) - (a.id || 0);
  });
  return list[0];
}

function groupDuplicatesByIp(devices) {
  const map = new Map();
  for (const d of devices || []) {
    const ip = String(d && d.ip_address || '').trim();
    if (!ip) continue;
    if (!map.has(ip)) map.set(ip, []);
    map.get(ip).push(d);
  }
  const groups = [];
  for (const [ip, list] of map) {
    if (list.length < 2) continue;
    const keep = pickDeviceToKeep(list);
    groups.push({
      ip,
      keep,
      remove: list.filter((d) => d.id !== keep.id),
    });
  }
  return groups;
}

module.exports = {
  ident,
  KEEP_TABLES,
  EXTRA_DELETE,
  parseFkTableFromError,
  listDeviceForeignKeys,
  desiredDeleteRule,
  ensureDeviceFkRules,
  unlinkDevice,
  forceDeleteDevice,
  pickDeviceToKeep,
  groupDuplicatesByIp,
};
