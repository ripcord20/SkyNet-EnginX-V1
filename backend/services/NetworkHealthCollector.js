'use strict';

/**
 * NetworkHealthCollector — pemantauan 3-tier infrastruktur ISP.
 *
 * DEFAULT OFF. Tidak jalan sama sekali sampai admin menekan ON.
 * Hanya mem-poll tabel `devices` (router/OLT/switch/AP), BUKAN semua pelanggan.
 * Concurrency 2, timeout pendek, tanpa NetFlow collector (berat).
 *
 * Tier 1: ICMP RTT/loss, up/down, traffic interface
 * Tier 2: CPU/RAM/disk, suhu/tegangan, optik SFP + ringkasan ONT
 * Tier 3: sesi PPPoE (bukan BGP), error/CRC port, DHCP/DNS/RADIUS, flow lite
 */

const { exec } = require('child_process');
const dns = require('dns').promises;
const net = require('net');
const logger = require('../utils/logger');
const { parseResource, mikrotikFlag } = require('../utils/mikrotikResource');
const {
  INFRA_DEVICE_TYPES,
  canPollMikrotik,
  normalizeIfaces,
  pickTrafficIfaces,
  trafficMbpsFromStats,
  parsePppoeActive,
  pppoeRollup,
  parseWirelessEntries,
} = require('../utils/networkHealthMetrics');

const KEYS = {
  enabled:  'nhealth_enabled',
  interval: 'nhealth_interval',
  tier2:    'nhealth_tier2',
  tier3:    'nhealth_tier3',
};

const DEFAULTS = {
  enabled:  '0',
  interval: '60',
  tier2:    '1',
  tier3:    '1',
};

const CPU_WARN = 85;
const RAM_WARN = 85;
const LOSS_WARN = 2;
const LOSS_CRIT = 5;
const RTT_WARN_MS = 20;
const TEMP_WARN = 70;
const RX_WEAK_DBM = -27;

let _running = false;
let _status = {
  enabled: false,
  running: false,
  lastRunAt: null,
  lastDurationMs: 0,
  lastError: null,
  devicesPolled: 0,
  services: null,
};

async function _setting(key, fallback) {
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key } });
    if (row && row.value != null && String(row.value) !== '') return String(row.value);
  } catch (_) {}
  return fallback;
}

async function getConfig() {
  const enabled = await _setting(KEYS.enabled, DEFAULTS.enabled);
  const interval = await _setting(KEYS.interval, DEFAULTS.interval);
  const tier2 = await _setting(KEYS.tier2, DEFAULTS.tier2);
  const tier3 = await _setting(KEYS.tier3, DEFAULTS.tier3);
  const cfg = {
    enabled: enabled === '1',
    interval: [60, 120, 300].includes(parseInt(interval, 10)) ? parseInt(interval, 10) : 60,
    tier2: tier2 !== '0',
    tier3: tier3 !== '0',
  };
  _status.enabled = cfg.enabled;
  return cfg;
}

async function setConfig(partial = {}) {
  const { AppSetting } = require('../models');
  const map = {
    enabled: KEYS.enabled,
    interval: KEYS.interval,
    tier2: KEYS.tier2,
    tier3: KEYS.tier3,
  };
  for (const [k, settingKey] of Object.entries(map)) {
    if (partial[k] === undefined) continue;
    let val = partial[k];
    if (k === 'enabled' || k === 'tier2' || k === 'tier3') val = (val === true || val === '1' || val === 1) ? '1' : '0';
    if (k === 'interval') {
      const n = parseInt(val, 10);
      val = String([60, 120, 300].includes(n) ? n : 60);
    }
    await AppSetting.upsert({ key: settingKey, value: String(val), type: 'string' });
  }
  const cfg = await getConfig();
  try { await require('./CronService').rescheduleNetworkHealth(); } catch (_) {}
  if (cfg.enabled && !_running) {
    setImmediate(() => runCycle().catch(e => logger.warn('[NHealth] immediate poll: ' + e.message)));
  }
  return cfg;
}

function icmpProbe(ip, { count = 3, timeoutSec = 1 } = {}) {
  return new Promise((resolve) => {
    const fail = { reachable: false, loss: 100, rttAvg: null, rttMin: null, rttMax: null };
    if (!ip || !/^[a-zA-Z0-9_.:-]+$/.test(ip)) return resolve(fail);
    const cmd = `ping -c ${count} -W ${timeoutSec} -i 0.2 ${ip}`;
    exec(cmd, { timeout: (count * timeoutSec + 4) * 1000 }, (err, stdout) => {
      const text = String(stdout || '');
      const lossM = text.match(/(\d+(?:\.\d+)?)%\s+packet loss/);
      const rttM = text.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
      const loss = lossM ? parseFloat(lossM[1]) : (err ? 100 : 0);
      resolve({
        reachable: loss < 100,
        loss,
        rttMin: rttM ? parseFloat(rttM[1]) : null,
        rttAvg: rttM ? parseFloat(rttM[2]) : null,
        rttMax: rttM ? parseFloat(rttM[3]) : null,
      });
    });
  });
}

function parseHealth(raw) {
  const out = { temperature: null, voltage: null };
  if (!raw) return out;
  const pick = (name, val) => {
    const n = String(name || '').toLowerCase();
    const v = parseFloat(val);
    if (!Number.isFinite(v)) return;
    if (n.includes('temp')) {
      if (out.temperature == null || n.includes('cpu')) out.temperature = v;
    }
    if (n.includes('voltage') || n === 'psu') {
      if (out.voltage == null) out.voltage = v;
    }
  };
  if (Array.isArray(raw)) {
    raw.forEach(r => pick(r.name || r.type, r.value));
  } else if (typeof raw === 'object') {
    Object.keys(raw).forEach(k => pick(k, raw[k]));
  }
  return out;
}

function num(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

async function _mtFor(device) {
  const { getMikrotikInstanceByDevice, MikrotikService } = require('./MikrotikService');
  if (device.api_username && device.api_port) {
    return new MikrotikService({
      host: device.ip_address,
      port: device.api_port,
      username: device.api_username,
      password: device.api_password || '',
      api_protocol: device.api_protocol || null,
      useSSL: parseInt(device.api_port, 10) === 443,
    });
  }
  return getMikrotikInstanceByDevice(device.id);
}

async function _safeGet(mt, ep, timeout = 4000) {
  try {
    return await mt.get(ep, { timeout, retries: 0 });
  } catch (_) {
    return null;
  }
}

async function pollMikrotik(device, cfg) {
  const extra = {
    protocol: 'api',
    board: null,
    version: null,
    uptime: null,
    interfaces: [],
    trafficIfaces: [],
    pppoe: { active: 0, sample: [] },
    wireless: [],
    sfp: [],
    dhcp: null,
    dns: null,
  };
  let metrics = {
    cpu: null, ram: null, disk: null, temperature: null, voltage: null,
    rxMbps: 0, txMbps: 0, ifaceErrors: 0, ifaceDrops: 0, ifaceDown: 0,
  };

  let mt;
  try { mt = await _mtFor(device); }
  catch (e) { return { ok: false, error: e.message, extra, metrics }; }

  const [resRaw, ifaceRaw, healthRaw] = await Promise.all([
    _safeGet(mt, '/system/resource', 8000),
    _safeGet(mt, '/interface', 8000),
    cfg.tier2 ? _safeGet(mt, '/system/health', 5000) : Promise.resolve(null),
  ]);

  if (!resRaw && !ifaceRaw) {
    return { ok: false, error: 'API MikroTik tidak merespons (/system/resource & /interface kosong)', extra, metrics };
  }

  if (resRaw) {
    const res = parseResource(resRaw);
    const totalMem = res.totalMemory;
    const freeMem = res.freeMemory;
    const totalHdd = res.totalHdd;
    const freeHdd = res.freeHdd;
    metrics.cpu = res.cpuLoad;
    metrics.ram = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null;
    metrics.disk = totalHdd > 0 ? Math.round(((totalHdd - freeHdd) / totalHdd) * 100) : null;
    extra.board = res.boardName || null;
    extra.version = res.version || null;
    extra.uptime = res.uptime || null;
  }

  if (cfg.tier2) {
    const h = parseHealth(healthRaw);
    metrics.temperature = h.temperature;
    metrics.voltage = h.voltage;
  }

  const rawIfaces = Array.isArray(ifaceRaw) ? ifaceRaw : (ifaceRaw ? [ifaceRaw] : []);
  extra.interfaces = normalizeIfaces(ifaceRaw).map((i) => {
    const src = rawIfaces.find((r) => r && r.name === i.name) || {};
    const err = num(src['rx-error']) + num(src['tx-error']) + num(src['rx-fcs-error']);
    const drop = num(src['rx-drop']) + num(src['tx-drop']);
    metrics.ifaceErrors += err;
    metrics.ifaceDrops += drop;
    if (!i.running) metrics.ifaceDown += 1;
    return {
      name: i.name,
      type: i.type || '',
      running: i.running,
      rxByte: i.rxByte,
      txByte: i.txByte,
      errors: err,
      drops: drop,
      comment: i.comment || '',
    };
  });

  const trafficIfaces = pickTrafficIfaces(extra.interfaces);
  extra.trafficIfaces = trafficIfaces.map((i) => i.name);
  if (trafficIfaces.length) {
    try {
      const stats = await mt.getInterfacesBulkStats(trafficIfaces.map((i) => i.name));
      const live = trafficMbpsFromStats(stats);
      metrics.rxMbps = live.rxMbps;
      metrics.txMbps = live.txMbps;
    } catch (e) {
      extra.trafficError = e.message;
    }
  }

  if (cfg.tier2) {
    const sfpIfaces = extra.interfaces
      .filter((i) => /sfp|qsfp/i.test(i.name + ' ' + i.type) && i.running)
      .slice(0, 2);
    for (const iface of sfpIfaces) {
      try {
        const mon = await mt.request('POST', '/interface/ethernet/monitor', {
          numbers: iface.name, once: true,
        }, { timeout: 3500, retries: 0 });
        const row = Array.isArray(mon) ? mon[0] : mon;
        if (row) {
          extra.sfp.push({
            name: iface.name,
            rxPower: row['sfp-rx-power'] != null ? parseFloat(row['sfp-rx-power']) : null,
            txPower: row['sfp-tx-power'] != null ? parseFloat(row['sfp-tx-power']) : null,
            temp: row['sfp-temperature'] != null ? parseFloat(row['sfp-temperature']) : null,
          });
        }
      } catch (_) { /* SFP monitor tidak tersedia di semua ether */ }
    }

    const [wifiLegacy, wifiWave] = await Promise.all([
      _safeGet(mt, '/interface/wireless/registration-table', 4000),
      _safeGet(mt, '/interface/wifi/registration', 4000),
    ]);
    extra.wireless = [
      ...parseWirelessEntries(wifiLegacy),
      ...parseWirelessEntries(wifiWave),
    ].slice(0, 40);
  }

  if (cfg.tier3) {
    const [pppRaw, dhcpSrv, dnsCfg] = await Promise.all([
      _safeGet(mt, '/ppp/active', 8000),
      _safeGet(mt, '/ip/dhcp-server', 3000),
      _safeGet(mt, '/ip/dns', 3000),
    ]);
    extra.pppoe = pppoeRollup(parsePppoeActive(pppRaw));
    if (Array.isArray(dhcpSrv)) {
      extra.dhcp = {
        servers: dhcpSrv.length,
        disabled: dhcpSrv.filter((s) => mikrotikFlag(s.disabled)).length,
      };
    }
    if (dnsCfg && typeof dnsCfg === 'object' && !Array.isArray(dnsCfg)) {
      extra.dns = { servers: dnsCfg.servers || '', allowRemote: dnsCfg['allow-remote-requests'] };
    }
  }

  return { ok: true, extra, metrics };
}

async function checkServices() {
  const out = { dns: null, radius: null, dhcp: null };

  const t0 = Date.now();
  try {
    await Promise.race([
      dns.resolve4('google.com'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
    ]);
    out.dns = { ok: true, ms: Date.now() - t0, detail: 'resolve google.com OK' };
  } catch (e) {
    out.dns = { ok: false, ms: Date.now() - t0, detail: e.message || 'DNS gagal' };
  }

  try {
    const { sequelize, AppSetting } = require('../models');
    const { QueryTypes } = require('sequelize');
    const en = await AppSetting.findOne({ where: { key: 'radius_enabled' } });
    if (!en || String(en.value) !== '1') {
      out.radius = { ok: null, detail: 'RADIUS AAA tidak aktif' };
    } else {
      const nas = await sequelize.query('SELECT COUNT(*) AS c FROM nas', { type: QueryTypes.SELECT });
      let lastAcct = null;
      try {
        const acct = await sequelize.query(
          'SELECT MAX(acctupdatetime) AS last_ts FROM radacct',
          { type: QueryTypes.SELECT }
        );
        lastAcct = acct && acct[0] && acct[0].last_ts ? acct[0].last_ts : null;
      } catch (_) {}
      const nasCount = parseInt((nas && nas[0] && nas[0].c) || 0, 10) || 0;
      out.radius = {
        ok: nasCount > 0,
        detail: nasCount > 0
          ? `${nasCount} NAS terdaftar` + (lastAcct ? ` · acct terakhir ${lastAcct}` : '')
          : 'Tabel NAS kosong',
      };
    }
  } catch (e) {
    out.radius = { ok: false, detail: e.message || 'Cek RADIUS gagal' };
  }

  try {
    const { sequelize } = require('../models');
    const { QueryTypes } = require('sequelize');
    const rows = await sequelize.query(
      `SELECT
         SUM(CASE WHEN pppoe_username IS NOT NULL AND pppoe_username <> '' THEN 1 ELSE 0 END) AS with_pppoe,
         SUM(CASE WHEN isolir_status = 'isolated' OR status = 'isolated' THEN 1 ELSE 0 END) AS isolated,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
       FROM customers`,
      { type: QueryTypes.SELECT }
    );
    const r = rows && rows[0] ? rows[0] : {};
    out.pppoe = {
      withPppoe: num(r.with_pppoe),
      isolated: num(r.isolated),
      active: num(r.active),
      detail: `${num(r.with_pppoe)} akun PPPoE · ${num(r.isolated)} isolir · ${num(r.active)} pelanggan aktif`,
    };
  } catch (e) {
    out.pppoe = { withPppoe: 0, isolated: 0, active: 0, detail: e.message || 'Cek PPPoE/isolir gagal' };
  }

  return out;
}

function buildAlerts(device, ping, metrics, extra) {
  const alerts = [];
  if (!ping.reachable) alerts.push({ level: 'crit', msg: 'Perangkat tidak terjangkau (ICMP)' });
  else {
    if (ping.loss >= LOSS_CRIT) alerts.push({ level: 'crit', msg: `Packet loss ${ping.loss}%` });
    else if (ping.loss >= LOSS_WARN) alerts.push({ level: 'warn', msg: `Packet loss ${ping.loss}%` });
    if (ping.rttAvg != null && ping.rttAvg > RTT_WARN_MS) {
      alerts.push({ level: 'warn', msg: `Latensi ${ping.rttAvg.toFixed(1)} ms` });
    }
  }
  if (metrics.cpu != null && metrics.cpu >= CPU_WARN) alerts.push({ level: 'warn', msg: `CPU ${metrics.cpu}%` });
  if (metrics.ram != null && metrics.ram >= RAM_WARN) alerts.push({ level: 'warn', msg: `RAM ${metrics.ram}%` });
  if (metrics.temperature != null && metrics.temperature >= TEMP_WARN) {
    alerts.push({ level: 'warn', msg: `Suhu ${metrics.temperature}°C` });
  }
  if (metrics.ifaceDown > 0) alerts.push({ level: 'warn', msg: `${metrics.ifaceDown} interface down` });
  if (metrics.ifaceErrors > 0) alerts.push({ level: 'warn', msg: `Error port ${metrics.ifaceErrors}` });
  (extra.sfp || []).forEach(s => {
    if (s.rxPower != null && s.rxPower <= RX_WEAK_DBM) {
      alerts.push({ level: 'warn', msg: `SFP ${s.name} RX ${s.rxPower} dBm` });
    }
  });
  (extra.wireless || []).forEach(w => {
    if (w.signal != null && w.signal <= -80) {
      alerts.push({ level: 'warn', msg: `WiFi ${w.mac} RSSI ${w.signal} dBm` });
    }
    if (w.ccq != null && w.ccq < 70) {
      alerts.push({ level: 'warn', msg: `WiFi ${w.mac} CCQ ${w.ccq}%` });
    }
  });
  return alerts.slice(0, 8);
}

function deriveStatus(ping, alerts, metrics) {
  if (!ping.reachable) return 'offline';
  if (alerts.some(a => a.level === 'crit')) return 'warning';
  if (alerts.some(a => a.level === 'warn')) return 'warning';
  if (metrics.cpu != null && metrics.cpu >= CPU_WARN) return 'warning';
  return 'online';
}

async function _mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { ret[idx] = await fn(items[idx], idx); }
      catch (e) { ret[idx] = { error: e.message }; }
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return ret;
}

function applyTrafficDelta(extra, metrics, prev) {
  if (!prev || !prev.details || !prev.polled_at) return;
  const dt = (Date.now() - new Date(prev.polled_at).getTime()) / 1000;
  if (dt < 5 || dt > 3600) return;
  const prevIf = (prev.details.interfaces || []);
  if (!prevIf.length) return;
  let rx = 0, tx = 0;
  extra.interfaces.forEach(i => {
    const p = prevIf.find(x => x.name === i.name);
    if (!p) return;
    const dRx = (i.rxByte || 0) - (p.rxByte || 0);
    const dTx = (i.txByte || 0) - (p.txByte || 0);
    if (dRx >= 0) rx += (dRx * 8) / dt / 1e6;
    if (dTx >= 0) tx += (dTx * 8) / dt / 1e6;
  });
  metrics.rxMbps = parseFloat(rx.toFixed(3));
  metrics.txMbps = parseFloat(tx.toFixed(3));
}

async function pollDevice(device, cfg, prev) {
  const ping = await icmpProbe(device.ip_address);
  let extra = { protocol: 'icmp' };
  let metrics = {
    cpu: null, ram: null, disk: null, temperature: null, voltage: null,
    rxMbps: 0, txMbps: 0, ifaceErrors: 0, ifaceDrops: 0, ifaceDown: 0,
  };

  if (canPollMikrotik(device)) {
    const api = await pollMikrotik(device, cfg);
    if (api.ok) {
      extra = { ...extra, ...api.extra };
      metrics = { ...metrics, ...api.metrics };
      if (!(metrics.rxMbps > 0 || metrics.txMbps > 0)) {
        applyTrafficDelta(extra, metrics, prev);
      }
      if (!ping.reachable) {
        ping.reachable = true;
        extra.icmpBlocked = true;
        if (ping.loss == null) ping.loss = 100;
      }
    } else {
      extra.apiError = api.error;
    }
  } else {
    extra.apiError = 'Isi API Username di Device Management agar traffic/CPU/PPPoE terbaca (SNMP saja tidak cukup)';
  }

  const alerts = buildAlerts(device, ping, metrics, extra);
  const status = deriveStatus(ping, alerts, metrics);
  extra.deviceName = device.name;
  extra.deviceType = device.type;
  extra.ip = device.ip_address;
  extra.popId = device.pop_id || null;

  return { ping, metrics, extra, alerts, status };
}

async function opticalSummary() {
  try {
    const { OntDevice, sequelize } = require('../models');
    const [rows] = await sequelize.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='online' THEN 1 ELSE 0 END) AS online,
         SUM(CASE WHEN status='offline' THEN 1 ELSE 0 END) AS offline,
         SUM(CASE WHEN signal_strength IS NOT NULL AND signal_strength <= ${RX_WEAK_DBM} THEN 1 ELSE 0 END) AS weak
       FROM ont_devices`
    );
    const r = rows && rows[0] ? rows[0] : {};
    return {
      total: num(r.total),
      online: num(r.online),
      offline: num(r.offline),
      weak: num(r.weak),
    };
  } catch (_) {
    return { total: 0, online: 0, offline: 0, weak: 0 };
  }
}

async function flowLite() {
  try {
    const { Device } = require('../models');
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const router = await Device.findOne({
      where: { type: 'router', is_active: true },
      order: [['id', 'ASC']],
    });
    if (!router) return { available: false, data: [] };
    const mt = await getMikrotikInstanceByDevice(router.id);
    const res = await mt.getTopConnections({ limit: 10, excludeLocal: true });
    return {
      available: !!(res && res.available !== false),
      router: router.name,
      data: (res && res.data) ? res.data.slice(0, 10) : [],
      note: 'Snapshot connection-tracking (bukan NetFlow collector).',
    };
  } catch (e) {
    return { available: false, data: [], note: e.message };
  }
}

async function pruneSamples() {
  try {
    const { NetworkHealthSample, sequelize } = require('../models');
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
    await NetworkHealthSample.destroy({ where: { sampled_at: { [require('sequelize').Op.lt]: cutoff } } });
    // Jaga tabel tetap kecil: max ~80 ribu baris
    await sequelize.query(
      `DELETE FROM network_health_samples
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id FROM network_health_samples ORDER BY sampled_at DESC LIMIT 80000
          ) t
        )`
    ).catch(() => {});
  } catch (e) {
    logger.warn('[NHealth] prune: ' + e.message);
  }
}

async function runCycle() {
  const cfg = await getConfig();
  _status.enabled = cfg.enabled;
  if (!cfg.enabled) {
    _status.running = false;
    return { skipped: true, reason: 'disabled' };
  }
  if (_running) return { skipped: true, reason: 'busy' };
  _running = true;
  _status.running = true;
  const t0 = Date.now();
  try {
    const { Device, NetworkHealthSnapshot, NetworkHealthSample } = require('../models');
    const { Op } = require('sequelize');
    const devices = await Device.findAll({
      where: {
        is_active: true,
        type: { [Op.in]: INFRA_DEVICE_TYPES },
      },
      attributes: ['id', 'name', 'ip_address', 'type', 'monitoring_type', 'pop_id',
        'api_username', 'api_password', 'api_port', 'api_protocol'],
      order: [['id', 'ASC']],
      limit: 60,
    });

    const prevRows = await NetworkHealthSnapshot.findAll({
      attributes: ['device_id', 'details', 'polled_at'],
    });
    const prevMap = new Map(prevRows.map(r => [r.device_id, r]));

    const results = await _mapLimit(devices, 3, async (device) => {
      const r = await pollDevice(device, cfg, prevMap.get(device.id));
      const now = new Date();
      await NetworkHealthSnapshot.upsert({
        device_id: device.id,
        status: r.status,
        reachable: r.ping.reachable,
        rtt_avg: r.ping.rttAvg,
        rtt_min: r.ping.rttMin,
        rtt_max: r.ping.rttMax,
        packet_loss: r.ping.loss,
        cpu: r.metrics.cpu,
        ram: r.metrics.ram,
        disk: r.metrics.disk,
        temperature: r.metrics.temperature,
        voltage: r.metrics.voltage,
        rx_mbps: r.metrics.rxMbps,
        tx_mbps: r.metrics.txMbps,
        iface_errors: r.metrics.ifaceErrors,
        iface_drops: r.metrics.ifaceDrops,
        iface_down: r.metrics.ifaceDown,
        details: r.extra,
        alerts: r.alerts,
        polled_at: now,
      });
      await NetworkHealthSample.create({
        device_id: device.id,
        rtt_avg: r.ping.rttAvg,
        packet_loss: r.ping.loss,
        cpu: r.metrics.cpu,
        ram: r.metrics.ram,
        rx_mbps: r.metrics.rxMbps,
        tx_mbps: r.metrics.txMbps,
        sampled_at: now,
      });
      return { id: device.id, status: r.status };
    });

    const services = await checkServices();
    if (cfg.tier2) services.optical = await opticalSummary();
    if (cfg.tier3) services.flow = await flowLite();
    _status.services = services;

    await pruneSamples();
    if (devices.length) {
      const ids = devices.map(d => d.id);
      await NetworkHealthSnapshot.destroy({
        where: { device_id: { [require('sequelize').Op.notIn]: ids } },
      }).catch(() => {});
    }

    _status.lastRunAt = new Date().toISOString();
    _status.lastDurationMs = Date.now() - t0;
    _status.lastError = null;
    _status.devicesPolled = devices.length;
    logger.info(`[NHealth] cycle ${devices.length} device in ${_status.lastDurationMs}ms`);
    return { ok: true, count: devices.length, results };
  } catch (e) {
    _status.lastError = e.message;
    logger.error('[NHealth] cycle error: ' + (e.stack || e.message));
    return { ok: false, error: e.message };
  } finally {
    _running = false;
    _status.running = false;
  }
}

function getStatus() {
  return { ..._status };
}

module.exports = {
  KEYS,
  DEFAULTS,
  getConfig,
  setConfig,
  runCycle,
  getStatus,
  icmpProbe,
};
