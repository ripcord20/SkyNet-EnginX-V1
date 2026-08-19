'use strict';

/**
 * Parser murni untuk Network Health Monitor (tanpa I/O).
 * Dipakai collector + tes supaya BGP / traffic / filter device tidak “diam-diam kosong”.
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

function parseBgpEntries(rawList) {
  return asList(rawList).slice(0, 30).map((p) => {
    const established = mikrotikFlag(p.established);
    const stateRaw = p.state || p['session-state'] || p['bgp-state'] || '';
    let state;
    if (established) state = 'established';
    else if (stateRaw) state = String(stateRaw).toLowerCase();
    else state = 'unknown';
    return {
      name: p.name || p['remote-address'] || p['remote.address'] || p['.id'] || '',
      remote: p['remote-address'] || p['remote.address'] || p.remote || '',
      as: String(p['remote-as'] || p['remote.as'] || ''),
      state,
    };
  }).filter((p) => p.name || p.remote);
}

function mergeBgpSources(session, peer, connection) {
  const fromSession = parseBgpEntries(session);
  if (fromSession.length) return fromSession;
  const fromPeer = parseBgpEntries(peer);
  if (fromPeer.length) return fromPeer;
  return parseBgpEntries(connection).map((p) => ({
    ...p,
    state: (p.state && p.state !== 'unknown') ? p.state : 'configured',
  }));
}

function bgpSummary(entries) {
  const list = entries || [];
  let up = 0;
  let down = 0;
  let configured = 0;
  list.forEach((p) => {
    const st = String(p.state || '').toLowerCase();
    if (st === 'established') up += 1;
    else if (st === 'configured') configured += 1;
    else down += 1;
  });
  return { total: list.length, up, down, configured };
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
  parseBgpEntries,
  mergeBgpSources,
  bgpSummary,
  parseWirelessEntries,
};
