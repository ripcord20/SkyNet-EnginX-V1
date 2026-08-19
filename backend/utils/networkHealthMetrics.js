'use strict';

/**
 * Parser murni untuk Network Health Monitor (tanpa I/O).
 * Dipakai collector + tes supaya PPPoE / traffic / filter device tidak kosong.
 */

const { mikrotikFlag, mapInterfaceRow } = require('./mikrotikResource');

const INFRA_DEVICE_TYPES = ['router', 'switch', 'olt', 'access_point', 'server'];

function canPollMikrotik(device) {
  if (!device) return false;
  const user = String(device.api_username || '').trim();
  if (!user) return false;
  const type = device.type || 'router';
  return INFRA_DEVICE_TYPES.includes(type);
}

function asList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

function normalizeIfaces(raw) {
  return asList(raw).map(mapInterfaceRow).filter((i) => {
    if (!i.name || i.disabled) return false;
    if (/^pppoe-|^<pppoe-|^ovpn|^sstp|^l2tp|^pptp|^wg-/i.test(i.name)) return false;
    return /ether|sfp|vlan|bridge|wlan|wifi|bond/i.test(String(i.type || '') + i.name);
  }).slice(0, 24);
}

function pickTrafficIfaces(ifaces) {
  const running = (ifaces || []).filter((i) => i.running);
  if (!running.length) return [];
  const blob = (i) => `${i.name || ''} ${i.comment || ''}`;
  const tagged = running.filter((i) => /uplink|wan|trunk|backhaul|\bbb\b|metro/i.test(blob(i)));
  if (tagged.length) return tagged.slice(0, 4);
  const sfp = running.filter((i) => /sfp/i.test(`${i.name || ''} ${i.type || ''}`));
  if (sfp.length) return sfp.slice(0, 4);
  const ether = running.filter((i) => /ether/i.test(String(i.type || '') + i.name) && !/^bridge/i.test(i.name));
  return (ether.length ? ether : running).slice(0, 4);
}

function trafficMbpsFromStats(stats) {
  let rx = 0;
  let tx = 0;
  (stats || []).forEach((s) => {
    rx += (Number(s && s.rxBitsPerSecond) || 0) / 1e6;
    tx += (Number(s && s.txBitsPerSecond) || 0) / 1e6;
  });
  return { rxMbps: parseFloat(rx.toFixed(3)), txMbps: parseFloat(tx.toFixed(3)) };
}

function parsePppoeActive(rawList) {
  return asList(rawList).map((r) => ({
    name: r.name || '',
    service: r.service || 'pppoe',
    address: r.address || '',
    uptime: r.uptime || '',
    callerId: r['caller-id'] || '',
    interface: r.interface || '',
  })).filter((s) => s.name);
}

function pppoeRollup(sessions) {
  const list = sessions || [];
  return {
    active: list.length,
    sample: list.slice(0, 8).map((s) => s.name),
  };
}

function parseWirelessEntries(rawList) {
  return asList(rawList).slice(0, 40).map((w) => ({
    mac: w['mac-address'] || w.mac || '',
    interface: w.interface || w['ap'] || '',
    signal: w['signal-strength'] != null
      ? parseFloat(String(w['signal-strength']).split('d')[0])
      : (w['signal'] != null ? parseFloat(w.signal) : null),
    ccq: w['tx-ccq'] != null ? parseFloat(w['tx-ccq']) : (w.ccq != null ? parseFloat(w.ccq) : null),
    noise: w['signal-to-noise'] != null ? parseFloat(w['signal-to-noise']) : null,
  })).filter((w) => w.mac);
}

module.exports = {
  INFRA_DEVICE_TYPES,
  canPollMikrotik,
  asList,
  normalizeIfaces,
  pickTrafficIfaces,
  trafficMbpsFromStats,
  parsePppoeActive,
  pppoeRollup,
  parseWirelessEntries,
};
