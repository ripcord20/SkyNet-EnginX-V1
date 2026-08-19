'use strict';

const assert = require('assert');
const {
  canPollMikrotik,
  normalizeIfaces,
  pickTrafficIfaces,
  trafficMbpsFromStats,
  parseBgpEntries,
  mergeBgpSources,
  bgpSummary,
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

const ros7 = parseBgpEntries([
  { name: 'upstream', 'remote.address': '1.2.3.4', established: true },
  { name: 'peer2', 'remote.address': '5.6.7.8', established: 'yes' },
]);
assert.strictEqual(ros7.length, 2);
assert.strictEqual(ros7[0].state, 'established');
assert.strictEqual(ros7[0].remote, '1.2.3.4');
assert.strictEqual(ros7[1].state, 'established', 'binary API established=yes');

const ros6 = parseBgpEntries([
  { name: 'peer-a', 'remote-address': '9.9.9.9', state: 'established' },
  { name: 'peer-b', 'remote-address': '8.8.8.8', state: 'idle' },
]);
assert.strictEqual(ros6[0].state, 'established');
assert.strictEqual(ros6[1].state, 'idle');

const merged = mergeBgpSources(null, ros6, [{ name: 'cfg-only', 'remote.address': '1.1.1.1' }]);
assert.strictEqual(merged.length, 2, 'peer menang dari connection');

const onlyConn = mergeBgpSources(null, null, [{ name: 'cfg-only', 'remote.address': '1.1.1.1' }]);
assert.strictEqual(onlyConn[0].state, 'configured');

const sum = bgpSummary([...ros7, { name: 'down', state: 'idle' }]);
assert.strictEqual(sum.total, 3);
assert.strictEqual(sum.up, 2);
assert.strictEqual(sum.down, 1);

assert.strictEqual(bgpSummary([]).total, 0);

const wifi = parseWirelessEntries([
  { 'mac-address': 'AA:BB', interface: 'wlan1', 'signal-strength': '-65dBm@1Mbps', 'tx-ccq': '90' },
]);
assert.strictEqual(wifi[0].signal, -65);
assert.strictEqual(wifi[0].ccq, 90);

console.log('networkHealthMetrics.test.js ok');
