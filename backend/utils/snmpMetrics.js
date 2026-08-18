'use strict';

/**
 * Metrik SNMP yang selaras dengan WinBox / aplikasi MikroTik:
 *   - CPU  : rata-rata HOST-RESOURCES-MIB::hrProcessorLoad (0–100)
 *   - RAM  : hrStorage "main memory" / index 65536
 *   - Uptime: sysUpTime TimeTicks → "Xd Xh Xm"
 *
 * Jangan pakai mtxrHealth.14 (1.3.6.1.4.1.14988.1.1.3.14.0) — itu fan speed,
 * bukan CPU. Di RB4011 nilai 1400 (MHz/RPM) tampil sebagai "1400%".
 */

const { SNMP_OIDS } = require('../config/constants');
const { parseCpuPercent, formatSnmpUptime } = require('./mikrotikResource');

function oidStr(oid) {
  if (oid == null) return '';
  return Array.isArray(oid) ? oid.join('.') : String(oid);
}

function snmpText(v) {
  if (v == null) return '';
  if (Buffer.isBuffer(v)) return v.toString('utf8').replace(/\0/g, '').trim();
  return String(v).trim();
}

function tableColumns(session, oid, columns, maxRep = 40) {
  return new Promise((resolve) => {
    if (!session || typeof session.tableColumns !== 'function') return resolve({});
    try {
      session.tableColumns(oid, columns, maxRep, (err, table) => {
        if (err || !table) return resolve({});
        resolve(table);
      });
    } catch (_) {
      resolve({});
    }
  });
}

/**
 * Rata-rata load semua core (sama seperti /system/resource cpu-load di WinBox).
 */
async function readCpuLoad(session) {
  const table = await tableColumns(session, SNMP_OIDS.HR_PROCESSOR_TABLE, [2], 40);
  const vals = Object.values(table).map((row) => {
    const n = parseInt(row && row[2], 10);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }).filter((n) => n != null);
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/**
 * Persentase RAM dari hrStorage. Hindari disk/NAND.
 */
async function readMemory(session) {
  const empty = { memPercent: 0, memUsed: 0, memTotal: 0 };
  const table = await tableColumns(session, SNMP_OIDS.HR_STORAGE_TABLE, [2, 4, 5, 6], 40);
  const rows = Object.entries(table).map(([index, row]) => {
    const descr = snmpText(row && row[2]);
    const units = parseInt(row && row[4], 10) || 1;
    const size = parseInt(row && row[5], 10) || 0;
    const used = parseInt(row && row[6], 10) || 0;
    return { index: String(index), descr, units, size, used };
  }).filter((r) => r.size > 0);

  const ram = rows.find((r) => /main memory|physical memory|system memory|^ram$/i.test(r.descr))
    || rows.find((r) => r.index === '65536' && !/disk|nand|flash/i.test(r.descr))
    || rows.find((r) => /memory|ram/i.test(r.descr) && !/disk|nand|flash|virtual/i.test(r.descr));

  if (!ram) return empty;
  const memPercent = Math.max(0, Math.min(100, Math.round((ram.used / ram.size) * 100)));
  const bytesUsed = ram.used * ram.units;
  const bytesTotal = ram.size * ram.units;
  return {
    memPercent,
    memUsed: Math.round(bytesUsed / 1024 / 1024),
    memTotal: Math.round(bytesTotal / 1024 / 1024),
  };
}

function pickVarbind(varbinds, oid) {
  if (!Array.isArray(varbinds)) return null;
  const want = oidStr(oid);
  return varbinds.find((vb) => oidStr(vb && vb.oid) === want) || null;
}

function varbindValue(vb) {
  if (!vb) return null;
  return vb.value;
}

module.exports = {
  oidStr,
  parseCpuPercent,
  formatSnmpUptime,
  readCpuLoad,
  readMemory,
  pickVarbind,
  varbindValue,
  snmpText,
};
