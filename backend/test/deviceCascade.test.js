'use strict';

const assert = require('assert');
const {
  ident,
  parseFkTableFromError,
  desiredDeleteRule,
  KEEP_TABLES,
  pickDeviceToKeep,
  groupDuplicatesByIp,
} = require('../utils/deviceCascade');

assert.strictEqual(ident('network_health_samples'), '`network_health_samples`');
assert.throws(() => ident('devices; drop table'), /Invalid/);

assert.strictEqual(
  parseFkTableFromError(
    "Cannot delete or update a parent row: a foreign key constraint fails (`skynet`.`network_health_samples`, CONSTRAINT `nhs_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`))"
  ),
  'network_health_samples'
);

assert.strictEqual(desiredDeleteRule({ tableName: 'customers', isNullable: 'YES' }), 'SET NULL');
assert.strictEqual(desiredDeleteRule({ tableName: 'network_health_samples', isNullable: 'NO' }), 'CASCADE');
assert.ok(KEEP_TABLES.has('resellers'));

const a = { id: 1, name: 'GANANET', ip_address: '141.11.241.96', status: 'online', last_polled: '2026-08-18T12:00:00Z' };
const b = { id: 2, name: 'GANANET', ip_address: '141.11.241.96', status: 'offline', last_polled: '2026-08-18T13:00:00Z' };
const keep = pickDeviceToKeep([a, b]);
assert.strictEqual(keep.id, 1, 'prefer online over newer offline');

const groups = groupDuplicatesByIp([a, b, { id: 3, ip_address: '10.0.0.1', status: 'online' }]);
assert.strictEqual(groups.length, 1);
assert.strictEqual(groups[0].ip, '141.11.241.96');
assert.strictEqual(groups[0].keep.id, 1);
assert.strictEqual(groups[0].remove.length, 1);
assert.strictEqual(groups[0].remove[0].id, 2);
assert.deepStrictEqual(groupDuplicatesByIp([{ id: 1, ip_address: '1.1.1.1' }]), []);

console.log('deviceCascade.test.js ok');
