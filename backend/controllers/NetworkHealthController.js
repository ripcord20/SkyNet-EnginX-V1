'use strict';

const Collector = require('../services/NetworkHealthCollector');
const { NetworkHealthSnapshot, NetworkHealthSample, Device } = require('../models');
const { Op } = require('sequelize');

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

    const rows = await NetworkHealthSnapshot.findAll({
      include: [{
        model: Device,
        as: 'device',
        attributes: ['id', 'name', 'ip_address', 'type', 'brand', 'model', 'location', 'status'],
      }],
      order: [['device_id', 'ASC']],
    });

    const devices = rows.map(r => {
      const j = r.toJSON();
      return {
        id: j.device_id,
        name: j.device ? j.device.name : (j.details && j.details.deviceName) || ('#' + j.device_id),
        ip: j.device ? j.device.ip_address : (j.details && j.details.ip) || '',
        type: j.device ? j.device.type : (j.details && j.details.deviceType) || 'other',
        brand: j.device ? j.device.brand : null,
        location: j.device ? j.device.location : null,
        status: j.status,
        reachable: !!j.reachable,
        rttAvg: j.rtt_avg,
        rttMin: j.rtt_min,
        rttMax: j.rtt_max,
        packetLoss: j.packet_loss,
        cpu: j.cpu,
        ram: j.ram,
        disk: j.disk,
        temperature: j.temperature,
        voltage: j.voltage,
        rxMbps: j.rx_mbps,
        txMbps: j.tx_mbps,
        ifaceErrors: j.iface_errors,
        ifaceDrops: j.iface_drops,
        ifaceDown: j.iface_down,
        details: j.details || {},
        alerts: j.alerts || [],
        polledAt: j.polled_at,
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
    total: 0, online: 0, offline: 0, warning: 0,
    avgRtt: null, maxLoss: 0, cpuHot: 0, opticalWeak: 0,
    bgpDown: 0, errorPorts: 0,
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
    if (d.rttAvg != null) { rttSum += d.rttAvg; rttN += 1; }
    if (d.packetLoss != null && d.packetLoss > s.maxLoss) s.maxLoss = d.packetLoss;
    if (d.cpu != null && d.cpu >= 85) s.cpuHot += 1;
    if ((d.ifaceErrors || 0) > 0) s.errorPorts += 1;
    (d.details && d.details.bgp || []).forEach(p => {
      if (p.state && String(p.state).toLowerCase() !== 'established') s.bgpDown += 1;
    });
    (d.details && d.details.sfp || []).forEach(f => {
      if (f.rxPower != null && f.rxPower <= -27) s.opticalWeak += 1;
    });
  });
  s.avgRtt = rttN ? Math.round((rttSum / rttN) * 10) / 10 : null;
  if (services && services.optical) s.opticalWeak += services.optical.weak || 0;
  return s;
}
