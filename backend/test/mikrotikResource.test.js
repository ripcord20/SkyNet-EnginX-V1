'use strict';

const assert = require('assert');
const {
  unwrapSingleton,
  parseCpuPercent,
  parseResource,
  unwrapRestData,
  formatSnmpUptime,
} = require('../utils/mikrotikResource');

// REST v7: /system/resource sering array
const restArray = [{
  'architecture-name': 'arm',
  'board-name': 'RB4011iGS+',
  cpu: 'ARM',
  'cpu-count': '4',
  'cpu-frequency': '1400',
  'cpu-load': '36',
  'free-memory': '180355072',
  'total-memory': '1073741824',
  uptime: '1w1d19h23m43s',
  version: '7.11.3 (stable)',
  platform: 'MikroTik',
}];

assert.strictEqual(parseCpuPercent('36'), 36);
assert.strictEqual(parseCpuPercent(0), 0);
assert.strictEqual(parseCpuPercent('1400'), 0, 'cpu-frequency tidak boleh jadi CPU %');
assert.strictEqual(parseCpuPercent(-1), 0);
assert.strictEqual(parseCpuPercent(''), 0);

const fromArray = parseResource(restArray);
assert.strictEqual(fromArray.cpuLoad, 36);
assert.strictEqual(fromArray.cpuFrequency, 1400);
assert.strictEqual(fromArray.boardName, 'RB4011iGS+');
assert.strictEqual(fromArray.totalMemory, 1073741824);

const fromObject = parseResource(restArray[0]);
assert.strictEqual(fromObject.cpuLoad, 36);

assert.deepStrictEqual(unwrapSingleton(restArray)['cpu-load'], '36');
assert.deepStrictEqual(unwrapSingleton(null), {});

const unwrapped = unwrapRestData('/system/resource', restArray);
assert.strictEqual(unwrapped['cpu-load'], '36');
const listKept = unwrapRestData('/interface', [{ name: 'ether1' }, { name: 'ether2' }]);
assert.strictEqual(listKept.length, 2);

// SNMP TimeTicks: 8d 19h 23m = (8*86400 + 19*3600 + 23*60) * 100
assert.strictEqual(formatSnmpUptime(76098000), '8d 19h 23m');
assert.strictEqual(formatSnmpUptime('1w1d19h23m43s'), '1w1d19h23m43s');

const {
  mikrotikFlag,
  mapInterfaceRow,
  isMikrotikApiCapable,
  presentNmsRouter,
} = require('../utils/mikrotikResource');

// Bug lama: REST v7 kirim boolean true, mapper cek string === 'true' → semua iface "down"
function legacyRunning(v) { return v === 'true'; }
assert.strictEqual(legacyRunning(true), false, 'repro: REST boolean running dianggap down');
assert.strictEqual(legacyRunning('true'), true);
assert.strictEqual(mikrotikFlag(true), true, 'fix: boolean running harus true');

const restIfaces = [
  { name: 'ether1', running: true, disabled: false },
  { name: 'ether2', running: false, disabled: false },
  { name: 'bridge1', running: 'true', disabled: 'false' },
].map(mapInterfaceRow);
const runningNames = restIfaces.filter(i => i.running && !i.disabled).map(i => i.name);
assert.deepStrictEqual(runningNames, ['ether1', 'bridge1'], 'monitorAll tidak boleh kosong karena boolean REST');

assert.strictEqual(mikrotikFlag(true), true);
assert.strictEqual(mikrotikFlag('true'), true);
assert.strictEqual(mikrotikFlag('yes'), true);
assert.strictEqual(mikrotikFlag(false), false);
assert.strictEqual(mikrotikFlag('false'), false);

const restIface = mapInterfaceRow({ name: 'ether1', type: 'ether', running: true, disabled: false, 'rx-byte': '100' });
assert.strictEqual(restIface.running, true, 'REST boolean running harus true');
assert.strictEqual(restIface.disabled, false);
assert.strictEqual(restIface.rxByte, 100);

const apiIface = mapInterfaceRow({ name: 'sfp-sfpplus1', running: 'true', disabled: 'false' });
assert.strictEqual(apiIface.running, true, 'binary API string running=true');

assert.strictEqual(isMikrotikApiCapable({ type: 'router', api_port: 80 }), false, 'port saja tidak cukup');
assert.strictEqual(isMikrotikApiCapable({ type: 'router', monitoring_type: 'api' }), false, 'tanpa username tidak bisa REST');
assert.strictEqual(isMikrotikApiCapable({ type: 'router', api_username: 'admin' }), true);
assert.strictEqual(isMikrotikApiCapable({ type: 'router', api_username: '  ' }), false);

const snmpOnly = presentNmsRouter({ id: 1, name: 'GANANET', ip_address: '141.11.241.96', type: 'router', api_port: 80, status: 'online' });
assert.strictEqual(snmpOnly.api_ready, false);
assert.ok(snmpOnly.api_hint);

const apiReady = presentNmsRouter({ id: 2, name: 'ACS', ip_address: '192.168.22.1', type: 'router', api_username: 'admin', status: 'online' });
assert.strictEqual(apiReady.api_ready, true);
assert.strictEqual(apiReady.api_hint, null);

console.log('mikrotikResource.test.js ok');
