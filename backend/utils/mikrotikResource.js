'use strict';

/**
 * Normalisasi /system/resource dari RouterOS.
 *
 * REST v7 sering mengembalikan ARRAY berisi satu objek, sedangkan binary API
 * (dan MikrotikApiClient) sudah unwrap ke objek. Tanpa unwrap, `r['cpu-load']`
 * jadi undefined lalu fallback ke 0 — atau field lain (cpu-frequency = 1400 MHz)
 * ikut terbaca sebagai CPU % di pemanggil yang tidak teliti.
 */

function unwrapSingleton(data) {
  if (Array.isArray(data)) return data.length ? data[0] : {};
  if (data && typeof data === 'object') return data;
  return {};
}

function parseCpuPercent(v) {
  const n = parseInt(v, 10);
  // 0–100 saja. Nilai di luar itu hampir pasti bukan cpu-load
  // (contoh: cpu-frequency 1400 MHz, fan RPM).
  if (!Number.isFinite(n) || n < 0 || n > 100) return 0;
  return n;
}

function formatSnmpUptime(value) {
  if (value == null || value === '') return '';
  const s = String(value);
  if (/[dhm]/i.test(s) && !/^\d+$/.test(s)) return s;
  const ticks = parseInt(s, 10);
  if (!Number.isFinite(ticks) || ticks < 0) return s;
  const seconds = Math.floor(ticks / 100);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

function parseBytes(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseResource(raw) {
  const r = unwrapSingleton(raw);
  const totalMemory = parseBytes(r['total-memory']);
  const freeMemory = parseBytes(r['free-memory']);
  const totalHdd = parseBytes(r['total-hdd-space']);
  const freeHdd = parseBytes(r['free-hdd-space']);
  return {
    uptime: r.uptime || '0s',
    version: r.version || '',
    boardName: r['board-name'] || '',
    platform: r.platform || '',
    architecture: r['architecture-name'] || '',
    cpu: r.cpu || '',
    cpuCount: parseInt(r['cpu-count'], 10) || 0,
    cpuFrequency: parseInt(r['cpu-frequency'], 10) || 0,
    cpuLoad: parseCpuPercent(r['cpu-load']),
    freeMemory,
    totalMemory,
    freeHdd,
    totalHdd,
  };
}

const REST_SINGLETON_PATHS = new Set([
  '/system/identity',
  '/system/resource',
  '/system/clock',
  '/system/routerboard',
]);

function restPathOnly(endpoint) {
  return String(endpoint || '').split('?')[0].replace(/\/+$/, '') || '/';
}

function unwrapRestData(endpoint, data) {
  if (!Array.isArray(data)) return data;
  if (!REST_SINGLETON_PATHS.has(restPathOnly(endpoint))) return data;
  return data[0] != null ? data[0] : null;
}

module.exports = {
  unwrapSingleton,
  parseCpuPercent,
  parseResource,
  unwrapRestData,
  REST_SINGLETON_PATHS,
  formatSnmpUptime,
};
