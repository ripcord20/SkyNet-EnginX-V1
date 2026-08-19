'use strict';

const assert = require('assert');
const {
  canPollMikrotik,
  normalizeIfaces,
  pickTrafficIfaces,
  trafficMbpsFromStats,
  parsePppoeActive,
  pppoeRollup,
  parseWirelessEntries,
  INFRA_DEVICE_TYPES,
} = require('../utils/networkHealthMetrics');

assert.ok(INFRA_DEVICE_TYPES.includes('router'));
assert.strictEqual(canPollMikrotik({ type: 'router', api_username: 'admin' }), true);
assert.strictEqual(canPollMikrotik({ type: 'switch', api_username: 'admin' }), true);
assert.strictEqual(canPollMikrotik({ type: 'router', api_port: 80 }), false);
assert.strictEqual(canPollMikrotik({ type: 'ont', api_username: 'admin' }), false);

const ifaces = normalizeIfaces([
  { name: 'ether1', type: 'ether', running: true, disabled: false, comment: 'WAN uplink', 'rx-byte': '1000' },
  { name: 'sfp-sfpplus1', type: 'sfp-sfpplus', running: true, disabled: false, 'rx-byte': '9000' },
  { name: 'bridge1', type: 'bridge', running: true, disabled: false },
  { name: 'pppoe-out1', type: 'pppoe-out', running: true, disabled: false },
  { name: 'ether2', type: 'ether', running: true, disabled: true },
]);
assert.deepStrictEqual(ifaces.map((i) => i.name), ['ether1', 'sfp-sfpplus1', 'bridge1']);
assert.strictEqual(ifaces[0].running, true);
assert.strictEqual(ifaces[0].rxByte, 1000);

const picked = pickTrafficIfaces(ifaces);
assert.deepStrictEqual(picked.map((i) => i.name), ['ether1'], 'prioritas comment uplink/WAN');

const sfpOnly = pickTrafficIfaces([
  { name: 'sfp-sfpplus1', type: 'sfp-sfpplus', running: true },
  { name: 'ether2', type: 'ether', running: true },
]);
assert.deepStrictEqual(sfpOnly.map((i) => i.name), ['sfp-sfpplus1']);

const live = trafficMbpsFromStats([
  { rxBitsPerSecond: 10e6, txBitsPerSecond: 2e6 },
  { rxBitsPerSecond: 5e6, txBitsPerSecond: 1e6 },
]);
assert.strictEqual(live.rxMbps, 15);
assert.strictEqual(live.txMbps, 3);

const sessions = parsePppoeActive([
  { name: 'pelanggan-01', service: 'pppoe', address: '10.10.0.2', uptime: '1h', 'caller-id': 'AA:BB' },
  { name: '', address: '10.10.0.3' },
  { name: 'pelanggan-02', interface: '<pppoe-pelanggan-02>' },
]);
assert.strictEqual(sessions.length, 2);
assert.strictEqual(sessions[0].address, '10.10.0.2');
const roll = pppoeRollup(sessions);
assert.strictEqual(roll.active, 2);
assert.deepStrictEqual(roll.sample, ['pelanggan-01', 'pelanggan-02']);
assert.strictEqual(pppoeRollup([]).active, 0);

const wifi = parseWirelessEntries([
  { 'mac-address': 'AA:BB', interface: 'wlan1', 'signal-strength': '-65dBm@1Mbps', 'tx-ccq': '90' },
]);
assert.strictEqual(wifi[0].signal, -65);
assert.strictEqual(wifi[0].ccq, 90);

console.log('networkHealthMetrics.test.js ok');
