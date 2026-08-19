/**
 * DeviceMonitorController.js
 * Full device monitoring: CPU, RAM, Disk, Traffic
 * Protocol: MikroTik REST API + SNMP v2c/v3
 */

const { Device, DeviceLog, sequelize } = require('../models');
const { Op }   = require('sequelize');
const { getMikrotikInstance } = require('../services/MikrotikService');
const { SNMP_OIDS } = require('../config/constants');
const { parseCpuPercent } = require('../utils/mikrotikResource');
const { readCpuLoad, readMemory, formatSnmpUptime, pickVarbind, snmpText } = require('../utils/snmpMetrics');
const { sanitizeDevicePayload } = require('../utils/devicePayload');

let snmp;
try { snmp = require('net-snmp'); } catch(e) {}

// ── In-memory realtime cache ──────────────────────────────────
// deviceId → { cpu, memory, disk, interfaces, uptime, timestamp }
const realtimeCache = new Map();

// ─────────────────────────────────────────────────────────────
// GET /api/device-monitor/devices
// List semua device yang aktif untuk monitoring
// ─────────────────────────────────────────────────────────────
exports.listDevices = async (req, res) => {
  try {
    const devices = await Device.findAll({
      where: { is_active: true },
      attributes: ['id','name','ip_address','type','brand','model',
                   'monitoring_type','status','cpu_load','memory_usage',
                   'uptime','last_polled','snmp_version','snmp_community',
                   'snmp_port','location'],
      order: [['name','ASC']]
    });
    res.json({ success: true, data: devices });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/device-monitor/:id/realtime
// Poll realtime metrics dari device (MikroTik API atau SNMP)
// ─────────────────────────────────────────────────────────────
exports.realtimeMetrics = async (req, res) => {
  try {
    const device = await Device.findByPk(req.params.id);
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

    let metrics;

    // Smart protocol selection:
    // 1. Jika monitoring_type = 'api' atau 'both' → coba MikroTik API dulu
    // 2. Jika monitoring_type = 'snmp' → coba SNMP
    // 3. Jika API gagal dan type = 'both' → fallback SNMP
    // 4. Default (device tanpa config khusus) → coba API dulu

    const useApi  = device.monitoring_type === 'api'  || device.monitoring_type === 'both' || !device.monitoring_type;
    const useSnmp = device.monitoring_type === 'snmp' || device.monitoring_type === 'both';

    if (useApi) {
      metrics = await _pollMikrotikApi(device);
      // Jika API gagal dan SNMP juga tersedia, fallback
      if (!metrics.reachable && useSnmp) {
        metrics = await _pollSnmp(device);
      }
    } else if (useSnmp) {
      metrics = await _pollSnmp(device);
    } else {
      metrics = await _pollMikrotikApi(device);
    }

    // Update cache
    realtimeCache.set(device.id, { ...metrics, timestamp: Date.now() });

    // Save to DB log (async, don't wait)
    _saveLog(device.id, metrics);

    // Update device status
    const cpu = parseCpuPercent(metrics.cpu);
    await device.update({
      cpu_load:     cpu,
      memory_usage: metrics.memPercent,
      uptime:       metrics.uptime,
      status:       metrics.reachable ? (cpu > 90 ? 'warning' : 'online') : 'offline',
      last_polled:  new Date()
    });

    res.json({ success: true, data: metrics });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/device-monitor/:id/history?hours=24&metric=cpu
// History dari DeviceLog untuk grafik
// ─────────────────────────────────────────────────────────────
exports.history = async (req, res) => {
  try {
    const { hours = 24, metric = 'all' } = req.query;
    const since = new Date(Date.now() - parseInt(hours) * 3600000);

    const logs = await DeviceLog.findAll({
      where: {
        device_id: req.params.id,
        polled_at: { [Op.gte]: since }
      },
      attributes: ['cpu_load','memory_usage','interfaces','raw_data','polled_at'],
      order: [['polled_at','ASC']],
      limit: 2000
    });

    // Format untuk ApexCharts series
    const ts       = logs.map(l => new Date(l.polled_at).getTime());
    const cpuData  = logs.map(l => parseFloat(l.cpu_load   || 0));
    const memData  = logs.map(l => parseFloat(l.memory_usage || 0));

    // Traffic dari raw_data
    let rxData = [], txData = [];
    logs.forEach(l => {
      const rd = l.raw_data || {};
      rxData.push(parseFloat(rd.totalRxMbps || 0));
      txData.push(parseFloat(rd.totalTxMbps || 0));
    });

    // Disk dari raw_data
    const diskData = logs.map(l => parseFloat(l.raw_data?.diskPercent || 0));

    res.json({
      success: true,
      data: {
        timestamps: ts,
        cpu:    cpuData,
        memory: memData,
        rx:     rxData,
        tx:     txData,
        disk:   diskData
      }
    });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/device-monitor/:id/interfaces
// Detail per interface (traffic, status)
// ─────────────────────────────────────────────────────────────
exports.interfaces = async (req, res) => {
  try {
    const device = await Device.findByPk(req.params.id);
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

    let ifaces = [];
    if (device.monitoring_type !== 'snmp') {
      ifaces = await _getMikrotikInterfaces(device);
    } else {
      const cached = realtimeCache.get(device.id);
      ifaces = cached?.interfaces || [];
    }

    res.json({ success: true, data: ifaces });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/device-monitor/:id/interface-history?name=ether1&hours=1
// History traffic per interface
// ─────────────────────────────────────────────────────────────
exports.interfaceHistory = async (req, res) => {
  try {
    const { name, hours = 1 } = req.query;
    const since = new Date(Date.now() - parseInt(hours) * 3600000);

    const logs = await DeviceLog.findAll({
      where: { device_id: req.params.id, polled_at: { [Op.gte]: since } },
      attributes: ['interfaces','polled_at'],
      order: [['polled_at','ASC']],
      limit: 1000
    });

    const ts = [], rx = [], tx = [];
    logs.forEach(l => {
      const ifaces = l.interfaces || [];
      const iface  = ifaces.find(i => i.name === name);
      ts.push(new Date(l.polled_at).getTime());
      rx.push(parseFloat(iface?.rxMbps || 0));
      tx.push(parseFloat(iface?.txMbps || 0));
    });

    res.json({ success: true, data: { timestamps: ts, rx, tx, interface: name } });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/device-monitor/:id/summary
// Snapshot + info device untuk header dashboard
// ─────────────────────────────────────────────────────────────
exports.summary = async (req, res) => {
  try {
    const device = await Device.findByPk(req.params.id, {
      attributes: ['id','name','ip_address','type','brand','model','status',
                   'cpu_load','memory_usage','uptime','firmware','last_polled',
                   'monitoring_type','location']
    });
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

    const cached = realtimeCache.get(device.id) || {};
    res.json({ success: true, data: { ...device.toJSON(), ...cached } });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────
// INTERNAL — Poll MikroTik REST API
// ─────────────────────────────────────────────────────────────
async function _pollMikrotikApi(device) {
  try {
    let mt;
    // Cek apakah device punya credential sendiri atau pakai config global
    if (device.api_username && device.api_port) {
      // Device punya config sendiri — buat instance baru pakai credential device
      // (FIX: dulu pakai `MikrotikAPI` yang tidak diexport, fallback ke env. Sekarang pakai MikrotikService yang benar.)
      const { MikrotikService } = require('../services/MikrotikService');
      mt = new MikrotikService({
        host:         device.ip_address,
        port:         device.api_port,
        username:     device.api_username,
        password:     device.api_password || '',
        api_protocol: device.api_protocol || null,
        useSSL:       parseInt(device.api_port) === 443
      });
    } else {
      // Pakai MikroTik utama dari config (.env atau primary device)
      const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
      mt = await getMikrotikInstanceByDevice(device.id);
    }

    // Ambil semua data paralel
    const [resResult, ifaceResult] = await Promise.allSettled([
      mt.getSystemResource(),
      mt.getInterfaces()
    ]);

    const sysRes   = resResult.status === 'fulfilled'   ? resResult.value   : {};
    const ifaceRaw = ifaceResult.status === 'fulfilled' ? ifaceResult.value : [];

    // CPU — langsung dari system resource
    const cpuLoad = sysRes.cpuLoad ?? 0;

    // Memory
    const totalMem = sysRes.totalMemory || 0;
    const freeMem  = sysRes.freeMemory  || 0;
    const usedMem  = Math.max(0, totalMem - freeMem);
    const memPct   = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;

    // Interfaces — ambil yang running, max 12
    const runningIfaces = ifaceRaw.filter(i => !i.disabled).slice(0, 12);
    const ifaceStats = await Promise.allSettled(
      runningIfaces.map(i => mt.getInterfaceStats(i.name).catch(() => null))
    );

    let totalRx = 0, totalTx = 0;
    const interfaces = ifaceStats
      .map((r, idx) => {
        const s = r.status === 'fulfilled' ? r.value : null;
        if (!s) return null;
        const rxMbps = ((s.rxBitsPerSecond || 0) / 1e6);
        const txMbps = ((s.txBitsPerSecond || 0) / 1e6);
        if (runningIfaces[idx]?.running) {
          totalRx += rxMbps;
          totalTx += txMbps;
        }
        return {
          name:    runningIfaces[idx]?.name || s.name || '',
          type:    runningIfaces[idx]?.type || 'ether',
          running: runningIfaces[idx]?.running || false,
          rxMbps:  parseFloat(rxMbps.toFixed(3)),
          txMbps:  parseFloat(txMbps.toFixed(3))
        };
      })
      .filter(Boolean);

    const diskTotal = sysRes.totalHdd || 0;
    const diskFree  = sysRes.freeHdd || 0;
    const diskPct   = diskTotal > 0 ? Math.round(((diskTotal - diskFree) / diskTotal) * 100) : 0;

    return {
      reachable:    true,
      protocol:     'api',
      cpu:          cpuLoad,
      memPercent:   memPct,
      memUsed:      Math.round(usedMem / 1024 / 1024),
      memTotal:     Math.round(totalMem / 1024 / 1024),
      diskPercent:  diskPct,
      diskFree:     Math.round(diskFree / 1024 / 1024),
      diskTotal:    Math.round(diskTotal / 1024 / 1024),
      uptime:       sysRes.uptime    || '',
      firmware:     sysRes.version   || '',
      boardName:    sysRes.boardName || '',
      interfaces,
      totalRxMbps:  parseFloat(totalRx.toFixed(3)),
      totalTxMbps:  parseFloat(totalTx.toFixed(3))
    };
  } catch(e) {
    console.error('[DevMon API]', e.message);
    return {
      reachable: false, protocol: 'api', error: e.message,
      cpu: 0, memPercent: 0, memUsed: 0, memTotal: 0,
      diskPercent: 0, interfaces: [],
      totalRxMbps: 0, totalTxMbps: 0
    };
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL — Poll SNMP
// ─────────────────────────────────────────────────────────────
async function _pollSnmp(device) {
  const fail = (error) => ({
    reachable: false, protocol: 'snmp', error,
    cpu: 0, memPercent: 0, memUsed: 0, memTotal: 0,
    diskPercent: 0, interfaces: [], totalRxMbps: 0, totalTxMbps: 0
  });
  if (!snmp) return fail('net-snmp not installed');

  const sessionOpts = {
    port:    device.snmp_port || 161,
    retries: 1,
    timeout: 5000,
    version: device.snmp_version === 3 ? snmp.Version3 : snmp.Version2c
  };
  const session = snmp.createSession(device.ip_address,
    device.snmp_community || 'public', sessionOpts);

  const snmpGet = (oids) => new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => err ? reject(err) : resolve(varbinds || []));
  });
  const snmpTable = (oid, columns, maxRep) => new Promise((resolve) => {
    session.tableColumns(oid, columns, maxRep, (err, table) => resolve((!err && table) ? table : {}));
  });

  try {
    const varbinds = await snmpGet([
      SNMP_OIDS.SYSTEM_UPTIME,
      SNMP_OIDS.MT_FIRMWARE
    ]);
    const [cpuLoad, mem] = await Promise.all([
      readCpuLoad(session),
      readMemory(session)
    ]);
    const table = await snmpTable(SNMP_OIDS.IF_TABLE, [1, 2, 8, 10, 16], 50);

    let interfaces = [], totalRx = 0, totalTx = 0;
    Object.values(table).forEach(row => {
      const rxOctets = parseInt(row[10]) || 0;
      const txOctets = parseInt(row[16]) || 0;
      const rxMbps   = (rxOctets * 8) / 1e6;
      const txMbps   = (txOctets * 8) / 1e6;
      totalRx += rxMbps;
      totalTx += txMbps;
      interfaces.push({
        name:    snmpText(row[2]) || '',
        running: row[8] === 1,
        rxMbps:  parseFloat(rxMbps.toFixed(3)),
        txMbps:  parseFloat(txMbps.toFixed(3))
      });
    });

    return {
      reachable:   true,
      protocol:    'snmp',
      cpu:         cpuLoad,
      memPercent:  mem.memPercent,
      memUsed:     mem.memUsed,
      memTotal:    mem.memTotal,
      diskPercent: 0,
      uptime:      formatSnmpUptime(pickVarbind(varbinds, SNMP_OIDS.SYSTEM_UPTIME)?.value),
      firmware:    snmpText(pickVarbind(varbinds, SNMP_OIDS.MT_FIRMWARE)?.value),
      interfaces,
      totalRxMbps: parseFloat(totalRx.toFixed(3)),
      totalTxMbps: parseFloat(totalTx.toFixed(3))
    };
  } catch (e) {
    return fail(e.message);
  } finally {
    try { session.close(); } catch (_) {}
  }
}

async function _getMikrotikInterfaces(device) {
  try {
    let mt;
    // FIX: dulu function ini ignore parameter device dan selalu pakai env.
    // Sekarang prefer credential device kalau ada, fallback ke config global.
    if (device.api_username && device.api_port) {
      const { MikrotikService } = require('../services/MikrotikService');
      mt = new MikrotikService({
        host:         device.ip_address,
        port:         device.api_port,
        username:     device.api_username,
        password:     device.api_password || '',
        api_protocol: device.api_protocol || null,
        useSSL:       parseInt(device.api_port) === 443
      });
    } else {
      const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
      mt = await getMikrotikInstanceByDevice(device.id);
    }
    const ifaces = await mt.getInterfaces();
    return ifaces.filter(i => !i.disabled).map(i => ({
      name:    i.name,
      type:    i.type,
      running: i.running,
      rxMbps:  0, txMbps: 0
    }));
  } catch(e) { return []; }
}

async function _saveLog(deviceId, metrics) {
  try {
    await DeviceLog.create({
      device_id:    deviceId,
      cpu_load:     parseCpuPercent(metrics.cpu),
      memory_usage: metrics.memPercent,
      uptime:       metrics.uptime,
      status:       metrics.reachable ? (parseCpuPercent(metrics.cpu) > 90 ? 'warning' : 'online') : 'offline',
      interfaces:   metrics.interfaces,
      raw_data: {
        diskPercent:  metrics.diskPercent,
        totalRxMbps:  metrics.totalRxMbps,
        totalTxMbps:  metrics.totalTxMbps,
        memUsed:      metrics.memUsed,
        memTotal:     metrics.memTotal,
        firmware:     metrics.firmware,
        boardName:    metrics.boardName,
        protocol:     metrics.protocol
      }
    });
    // Prune logs > 24 jam
    const cutoff = new Date(Date.now() - 25 * 3600000);
    await DeviceLog.destroy({ where: { device_id: deviceId, polled_at: { [Op.lt]: cutoff } } });
  } catch(e) { /* silent */ }
}

function _getMikrotikDeviceId() { return null; }

// ─────────────────────────────────────────────────────────────
// POST /api/device-monitor/devices — Tambah device baru
// ─────────────────────────────────────────────────────────────
exports.createDevice = async (req, res) => {
  try {
    const payload = sanitizeDevicePayload(req.body);
    const device = await Device.create({
      ...payload,
      type:            payload.type            || 'router',
      brand:           payload.brand           || null,
      model:           payload.model           || null,
      location:        payload.location        || null,
      snmp_community:  payload.snmp_community  || 'public',
      snmp_version:    payload.snmp_version    || 2,
      snmp_port:       payload.snmp_port       || 161,
      poll_interval:   payload.poll_interval   || 60,
      notes:           payload.notes           || null,
      is_active:       true,
      status:          'offline'
    });

    res.status(201).json({ success: true, data: device, message: 'Device berhasil ditambahkan' });
  } catch(e) {
    res.status(e.status || 400).json({ success: false, message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/device-monitor/:id — Update device
// ─────────────────────────────────────────────────────────────
exports.updateDevice = async (req, res) => {
  try {
    const device = await Device.findByPk(req.params.id);
    if (!device) return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
    const payload = sanitizeDevicePayload({
      name: req.body.name != null ? req.body.name : device.name,
      ip_address: req.body.ip_address != null ? req.body.ip_address : device.ip_address,
      ...req.body,
      monitoring_type: req.body.monitoring_type != null ? req.body.monitoring_type : device.monitoring_type,
    });
    await device.update(payload);
    res.json({ success: true, data: device, message: 'Device berhasil diperbarui' });
  } catch(e) {
    res.status(e.status || 400).json({ success: false, message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/device-monitor/:id — Hapus device
// ─────────────────────────────────────────────────────────────
exports.deleteDevice = async (req, res) => {
  // Pakai destroy Device Management supaya cleanup FK sama
  // (nms_interface_presets, isolir extension, dll) — tanpa ini hapus
  // dari Device Monitor gagal & device tetap tampil.
  return require('./DeviceController').destroy(req, res);
};

// ─────────────────────────────────────────────────────────────
// POST /api/device-monitor/test-connection — Test sebelum simpan
// Body: { ip_address, monitoring_type, api_port, api_username,
//         api_password, snmp_community, snmp_version, snmp_port }
// ─────────────────────────────────────────────────────────────
exports.testConnection = async (req, res) => {
  const {
    ip_address, monitoring_type,
    api_port, api_username, api_password, api_protocol,
    snmp_community, snmp_version, snmp_port
  } = req.body;

  if (!ip_address) return res.status(400).json({ success: false, message: 'IP Address wajib diisi' });

  try {
    const useApi = monitoring_type === 'api' || monitoring_type === 'both';

    if (useApi) {
      const port = parseInt(api_port) || 80;
      const user = api_username || process.env.MT_USER || 'admin';
      const pass = api_password || process.env.MT_PASS || '';

      // Protokol ditentukan oleh user (eksplisit via api_protocol),
      // dengan fallback ke deteksi via port kalau api_protocol kosong.
      //   api-plain  → Binary API plain (port default 8728)
      //   api-ssl    → Binary API SSL   (port default 8729)
      //   rest-http  → REST plain
      //   rest-https → REST SSL
      const { MikrotikService } = require('../services/MikrotikService');
      const mt = new MikrotikService({
        host:         ip_address,
        port,
        username:     user,
        password:     pass,
        api_protocol: api_protocol || null,
        timeout:      6000,
      });

      try {
        const identityRow = await mt.getSystemIdentity();
        const identity = identityRow?.name || 'MikroTik';
        // Tutup koneksi binary kalau ada (REST tidak perlu)
        if (mt._apiClient) { try { mt._apiClient.close(); } catch (_) {} }
        const protoLabel = mt.protocol === 'api'     ? 'API binary (plain, port 8728)'
                         : mt.protocol === 'api-ssl' ? 'API binary (SSL, port 8729)'
                         : mt.useSSL                  ? 'REST (HTTPS)'
                         :                              'REST (HTTP)';
        return res.json({
          success: true,
          protocol: 'api',
          message: `✓ Terhubung via ${protoLabel} — ${identity}`,
          identity,
          transport: mt.protocol,  // 'api' | 'api-ssl' | 'rest'
        });
      } catch (err) {
        if (mt._apiClient) { try { mt._apiClient.close(); } catch (_) {} }
        throw err;
      }
    }

    // Test SNMP
    if (!snmp) return res.json({ success: false, message: 'net-snmp tidak terinstall' });

    const result = await new Promise((resolve) => {
      const session = snmp.createSession(ip_address, snmp_community || 'public', {
        port:    snmp_port    || 161,
        retries: 1,
        timeout: 5000,
        version: parseInt(snmp_version) === 3 ? snmp.Version3 : snmp.Version2c
      });
      session.get(['1.3.6.1.2.1.1.5.0'], (err, varbinds) => {
        session.close();
        if (err) resolve({ success: false, message: `SNMP Error: ${err.message}` });
        else resolve({ success: true, message: `✓ SNMP OK — ${varbinds[0]?.value?.toString() || ip_address}` });
      });
    });
    res.json({ ...result, protocol: 'snmp' });

  } catch(e) {
    res.status(200).json({
      success: false,
      message: `Gagal terhubung: ${e.message}`
    });
  }
};