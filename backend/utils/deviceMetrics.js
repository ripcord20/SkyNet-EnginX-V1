'use strict';

/**
 * Satu jalur untuk CPU/RAM device.
 *
 * Sumber kebenaran MikroTik = /system/resource (sama dengan WinBox),
 * BUKAN SNMP mtxrHealth.14 (itu mtxrHlProcessorFrequency dalam MHz).
 */

const logger = require('./logger');
const {
  parseCpuPercent,
  sanitizeCpuRam,
} = require('./mikrotikResource');

const WRITE_STRIP = [
  'cpu_load', 'memory_usage', 'uptime', 'firmware',
  'status', 'last_polled', 'id',
];

function sanitizeDeviceWrite(body) {
  const out = { ...(body || {}) };
  for (const k of WRITE_STRIP) delete out[k];
  return out;
}

function canUseMikrotikApi(device) {
  return !!(device && device.api_username && ['router', 'olt'].includes(device.type));
}

function mikrotikFromDevice(device) {
  const { MikrotikService } = require('../services/MikrotikService');
  return new MikrotikService({
    host: device.ip_address,
    port: device.api_port || 80,
    username: device.api_username,
    password: device.api_password || '',
    api_protocol: device.api_protocol || null,
    timeout: 8000,
  });
}

async function fetchMikrotikResource(device) {
  const mt = mikrotikFromDevice(device);
  const res = await mt.getSystemResource();
  if (!res) throw new Error('empty /system/resource');
  const mem = res.totalMemory > 0
    ? Math.round(((res.totalMemory - res.freeMemory) / res.totalMemory) * 100)
    : 0;
  return {
    cpu: parseCpuPercent(res.cpuLoad),
    mem,
    uptime: res.uptime || '',
    firmware: res.version || '',
    boardName: res.boardName || '',
    source: 'rest',
  };
}

async function persistDeviceMetrics(device, metrics) {
  const { Device } = require('../models');
  const { cpu, mem, bogus } = sanitizeCpuRam(metrics.cpu, metrics.mem);
  const patch = {
    cpu_load: cpu,
    memory_usage: mem,
    last_polled: new Date(),
  };
  if (metrics.uptime) patch.uptime = metrics.uptime;
  if (metrics.firmware) patch.firmware = metrics.firmware;
  if (!bogus) {
    patch.status = metrics.status || (cpu > 90 ? 'warning' : 'online');
  }
  await Device.update(patch, { where: { id: device.id } });
  return { ...patch, bogus, source: metrics.source || null };
}

async function syncDeviceMetrics(device) {
  if (!device || !device.id) return null;
  if (!canUseMikrotikApi(device)) return null;
  try {
    const m = await fetchMikrotikResource(device);
    return await persistDeviceMetrics(device, m);
  } catch (e) {
    logger.warn(`[deviceMetrics] REST ${device.name || device.id}: ${e.message}`);
    return null;
  }
}

function startWatching(device) {
  try {
    const SNMPService = require('../services/SNMPService');
    const snmp = SNMPService.getInstance();
    if (snmp && device && device.id) snmp.startDevice(device);
  } catch (_) { /* poller belum siap saat boot */ }
}

module.exports = {
  WRITE_STRIP,
  sanitizeDeviceWrite,
  canUseMikrotikApi,
  fetchMikrotikResource,
  persistDeviceMetrics,
  syncDeviceMetrics,
  startWatching,
};
