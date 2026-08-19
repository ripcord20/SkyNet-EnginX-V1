'use strict';
const assert = require('assert');
const {
  sanitizeDevicePayload,
  wantsApiMonitor,
  wantsSnmpMonitor,
} = require('../utils/devicePayload');

const snmp = sanitizeDevicePayload({
  name: 'SW-1',
  ip_address: '10.0.0.1',
  monitoring_type: 'snmp',
  api_username: 'admin',
  api_password: 'secret',
  api_port: 80,
  api_protocol: 'rest-http',
});
assert.strictEqual(snmp.api_username, null);
assert.strictEqual(snmp.api_password, null);
assert.strictEqual(snmp.api_port, null);
assert.strictEqual(snmp.api_protocol, null);
assert.strictEqual(snmp.monitoring_type, 'snmp');

assert.throws(
  () => sanitizeDevicePayload({ name: 'R1', monitoring_type: 'snmp' }),
  /Nama dan IP Address wajib diisi/
);
assert.throws(
  () => sanitizeDevicePayload({ name: 'R1', ip_address: '1.1.1.1', monitoring_type: 'api' }),
  /API Username wajib diisi/
);

const api = sanitizeDevicePayload({
  name: 'R1',
  ip_address: '1.1.1.1',
  monitoring_type: 'both',
  api_username: '  noc  ',
});
assert.strictEqual(api.api_username, 'noc');

assert.strictEqual(wantsApiMonitor('snmp'), false);
assert.strictEqual(wantsApiMonitor('api'), true);
assert.strictEqual(wantsSnmpMonitor('snmp'), true);
assert.strictEqual(wantsSnmpMonitor('api'), false);

console.log('devicePayload.test.js ok');
