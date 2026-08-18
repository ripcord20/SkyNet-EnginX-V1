'use strict';

/**
 * Normalisasi /system/resource dari RouterOS.
 *
 * REST v7 sering mengembalikan ARRAY berisi satu objek, sedangkan binary API
 * (dan MikrotikApiClient) sudah unwrap ke objek. Tanpa unwrap, `r['cpu-load']`
 * jadi undefined lalu fallback ke 0 — atau field lain (cpu-frequency = 1400 MHz)
 * ikut terbaca sebagai CPU % di pemanggil yang tidak teliti.
 *
 * OID SNMP 1.3.6.1.4.1.14988.1.1.3.14.0 = mtxrHlProcessorFrequency (MHz),
 * BUKAN cpu-load. Di RB4011 nilainya 1400. Jangan pernah dipakai sebagai %.
 */

function unwrapSingleton(data) {
  if (Array.isArray(data)) return data.length ? data[0] : {};
  if (data && typeof data === 'object') return data;
  return {};
}

function parseCpuPercent(v) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/%/g, '').trim();
  const n = parseFloat(s);
  // 0–100 saja. Nilai di luar itu hampir pasti bukan cpu-load
  // (contoh: cpu-frequency 1400 MHz, fan RPM).
  if (!Number.isFinite(n) || n < 0 || n > 100) return 0;
  return Math.round(n);
}

/**
 * Ambil cpu-load dari objek resource. Jangan baca cpu / cpu-frequency / cpu-count.
 */
function pickCpuLoad(raw) {
  if (raw == null) return 0;
  if (Array.isArray(raw) && raw.length && (raw[0].load != null || raw[0]['cpu-load'] != null)) {
    const vals = raw.map((row) => parseCpuPercent(row.load != null ? row.load : row['cpu-load']));
    if (!vals.length) return 0;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  const r = unwrapSingleton(raw);
  const named = r['cpu-load'] != null ? r['cpu-load']
    : (r.cpu_load != null ? r.cpu_load
      : (r.cpuLoad != null ? r.cpuLoad : undefined));
  return parseCpuPercent(named);
}

function memoryPercent(totalMemory, freeMemory) {
  const total = parseBytes(totalMemory);
  const free = parseBytes(freeMemory);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((total - free) / total) * 100)));
}

function isBogusCpuRam(cpu, mem) {
  return parseCpuPercent(cpu) === 100 && parseCpuPercent(mem) === 0;
}

function sanitizeCpuRam(cpu, mem) {
  const c = parseCpuPercent(cpu);
  const m = parseCpuPercent(mem);
  if (c === 100 && m === 0) return { cpu: 0, mem: 0, bogus: true };
  return { cpu: c, mem: m, bogus: false };
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
  const totalMemory = parseBytes(r['total-memory'] != null ? r['total-memory'] : r.totalMemory);
  const freeMemory = parseBytes(r['free-memory'] != null ? r['free-memory'] : r.freeMemory);
  const totalHdd = parseBytes(r['total-hdd-space'] != null ? r['total-hdd-space'] : r.totalHdd);
  const freeHdd = parseBytes(r['free-hdd-space'] != null ? r['free-hdd-space'] : r.freeHdd);
  return {
    uptime: r.uptime || '0s',
    version: r.version || '',
    boardName: r['board-name'] || r.boardName || '',
    platform: r.platform || '',
    architecture: r['architecture-name'] || '',
    cpu: r.cpu || '',
    cpuCount: parseInt(r['cpu-count'], 10) || 0,
    cpuFrequency: parseInt(r['cpu-frequency'] != null ? r['cpu-frequency'] : r.cpuFrequency, 10) || 0,
    cpuLoad: pickCpuLoad(raw),
    freeMemory,
    totalMemory,
    freeHdd,
    totalHdd,
    memoryPercent: memoryPercent(totalMemory, freeMemory),
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
  pickCpuLoad,
  memoryPercent,
  sanitizeCpuRam,
  isBogusCpuRam,
  parseResource,
  unwrapRestData,
  REST_SINGLETON_PATHS,
  formatSnmpUptime,
};
