'use strict';

const assert = require('assert');
const {
  unwrapSingleton,
  parseCpuPercent,
  parseResource,
  unwrapRestData,
  formatSnmpUptime,
  pickCpuLoad,
  sanitizeCpuRam,
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
assert.strictEqual(parseCpuPercent('36%'), 36);
assert.strictEqual(parseCpuPercent('1400'), 0, 'cpu-frequency tidak boleh jadi CPU %');
assert.strictEqual(pickCpuLoad({ 'cpu-frequency': '1400' }), 0, 'jangan pakai frequency');
assert.strictEqual(pickCpuLoad({ 'cpu-load': '36', 'cpu-frequency': '1400' }), 36);
assert.strictEqual(pickCpuLoad({ cpuLoad: 42 }), 42);
assert.strictEqual(pickCpuLoad([{ load: '10%' }, { load: '50%' }]), 30);
assert.deepStrictEqual(sanitizeCpuRam(100, 0), { cpu: 0, mem: 0, bogus: true });
assert.deepStrictEqual(sanitizeCpuRam(36, 80), { cpu: 36, mem: 80, bogus: false });
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

console.log('mikrotikResource.test.js ok');
