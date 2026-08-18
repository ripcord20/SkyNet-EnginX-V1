'use strict';

const assert = require('assert');
const {
  ident,
  parseFkTableFromError,
  desiredDeleteRule,
  KEEP_TABLES,
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

console.log('deviceCascade.test.js ok');
