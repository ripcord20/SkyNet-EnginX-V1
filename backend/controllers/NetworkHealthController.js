'use strict';

const Collector = require('../services/NetworkHealthCollector');
const { NetworkHealthSnapshot, NetworkHealthSample, Device, InfrastructurePoint } = require('../models');
const { Op } = require('sequelize');
const { INFRA_DEVICE_TYPES, bgpSummary } = require('../utils/networkHealthMetrics');

exports.status = async (req, res) => {
  try {
    const cfg = await Collector.getConfig();
    const live = Collector.getStatus();
    res.json({ success: true, data: { ...cfg, ...live, enabled: cfg.enabled } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.saveConfig = async (req, res) => {
  try {
    const body = req.body || {};
    const cfg = await Collector.setConfig({
      enabled: body.enabled,
      interval: body.interval,
      tier2: body.tier2,
      tier3: body.tier3,
    });
    const live = Collector.getStatus();
    res.json({
      success: true,
      message: cfg.enabled
        ? 'Network Health Monitor diaktifkan. Polling perangkat infrastruktur dimulai.'
        : 'Network Health Monitor dimatikan. Tidak ada polling tambahan — billing tidak terbebani.',
      data: { ...cfg, ...live, enabled: cfg.enabled },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.pollNow = async (req, res) => {
  try {
    const cfg = await Collector.getConfig();
    if (!cfg.enabled) {
      return res.status(400).json({ success: false, message: 'Nyalakan monitor dulu (tombol ON).' });
    }
    const result = await Collector.runCycle();
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.overview = async (req, res) => {
  try {
    const cfg = await Collector.getConfig();
    const live = Collector.getStatus();
    if (!cfg.enabled) {
      return res.json({
        success: true,
        data: {
          enabled: false,
          config: cfg,
          status: live,
          summary: emptySummary(),
          devices: [],
          services: live.services || null,
        },
      });
    }

    const rows = await Device.findAll({
      where: {
        is_active: true,
        type: { [Op.in]: INFRA_DEVICE_TYPES },
      },
      attributes: ['id', 'name', 'ip_address', 'type', 'brand', 'model', 'location', 'status', 'pop_id', 'api_username'],
      include: [
        { model: NetworkHealthSnapshot, as: 'health_snapshot', required: false },
        { model: InfrastructurePoint, as: 'pop', attributes: ['id', 'name', 'type'], required: false },
      ],
      order: [['id', 'ASC']],
      limit: 80,
    });

    const devices = rows.map((d) => {
      const j = d.toJSON();
      const snap = j.health_snapshot || null;
      const details = (snap && snap.details) || {};
      return {
        id: j.id,
        name: j.name,
        ip: j.ip_address,
        type: j.type,
        brand: j.brand,
        location: j.location,
        pop: j.pop ? { id: j.pop.id, name: j.pop.name } : null,
        apiReady: !!(j.api_username && String(j.api_username).trim()),
        status: snap ? snap.status : 'unknown',
        reachable: snap ? !!snap.reachable : false,
        rttAvg: snap ? snap.rtt_avg : null,
        rttMin: snap ? snap.rtt_min : null,
        rttMax: snap ? snap.rtt_max : null,
        packetLoss: snap ? snap.packet_loss : null,
        cpu: snap ? snap.cpu : null,
        ram: snap ? snap.ram : null,
        disk: snap ? snap.disk : null,
        temperature: snap ? snap.temperature : null,
        voltage: snap ? snap.voltage : null,
        rxMbps: snap ? snap.rx_mbps : null,
        txMbps: snap ? snap.tx_mbps : null,
        ifaceErrors: snap ? snap.iface_errors : 0,
        ifaceDrops: snap ? snap.iface_drops : 0,
        ifaceDown: snap ? snap.iface_down : 0,
        details,
        alerts: (snap && snap.alerts) || [],
        polledAt: snap ? snap.polled_at : null,
      };
    });

    res.json({
      success: true,
      data: {
        enabled: true,
        config: cfg,
        status: live,
        summary: buildSummary(devices, live.services),
        devices,
        services: live.services || null,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.history = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'device id wajib' });
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 6, 1), 24);
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const rows = await NetworkHealthSample.findAll({
      where: { device_id: id, sampled_at: { [Op.gte]: since } },
      order: [['sampled_at', 'ASC']],
      limit: 1500,
    });
    res.json({
      success: true,
      data: rows.map(r => ({
        t: r.sampled_at,
        rtt: r.rtt_avg,
        loss: r.packet_loss,
        cpu: r.cpu,
        ram: r.ram,
        rx: r.rx_mbps,
        tx: r.tx_mbps,
      })),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

function emptySummary() {
  return {
    total: 0, online: 0, offline: 0, warning: 0, unknown: 0,
    avgRtt: null, maxLoss: 0, cpuHot: 0, opticalWeak: 0,
    bgpDown: 0, bgpUp: 0, bgpTotal: 0, errorPorts: 0,
    rxMbps: 0, txMbps: 0,
  };
}

function buildSummary(devices, services) {
  const s = emptySummary();
  s.total = devices.length;
  let rttSum = 0, rttN = 0;
  devices.forEach(d => {
    if (d.status === 'offline') s.offline += 1;
    else if (d.status === 'warning') s.warning += 1;
    else if (d.status === 'online') s.online += 1;
    else s.unknown += 1;
    if (d.rttAvg != null) { rttSum += d.rttAvg; rttN += 1; }
    if (d.packetLoss != null && d.packetLoss > s.maxLoss) s.maxLoss = d.packetLoss;
    if (d.cpu != null && d.cpu >= 85) s.cpuHot += 1;
    if ((d.ifaceErrors || 0) > 0) s.errorPorts += 1;
    s.rxMbps += Number(d.rxMbps) || 0;
    s.txMbps += Number(d.txMbps) || 0;
    const bgp = bgpSummary((d.details && d.details.bgp) || []);
    s.bgpDown += bgp.down;
    s.bgpUp += bgp.up;
    s.bgpTotal += bgp.total;
    (d.details && d.details.sfp || []).forEach(f => {
      if (f.rxPower != null && f.rxPower <= -27) s.opticalWeak += 1;
    });
  });
  s.avgRtt = rttN ? Math.round((rttSum / rttN) * 10) / 10 : null;
  s.rxMbps = parseFloat(s.rxMbps.toFixed(2));
  s.txMbps = parseFloat(s.txMbps.toFixed(2));
  if (services && services.optical) s.opticalWeak += services.optical.weak || 0;
  return s;
}
