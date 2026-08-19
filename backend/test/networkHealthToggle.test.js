'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ejs = fs.readFileSync(
  path.join(__dirname, '../../frontend/views/pages/network-health.ejs'),
  'utf8'
);
const start = ejs.lastIndexOf('<script>');
const end = ejs.lastIndexOf('</script>');
assert.ok(start >= 0 && end > start, 'script block Network Health tidak ditemukan');
const script = ejs.slice(start + 8, end);
assert.doesNotMatch(script, /try\s*\{[^}]*\}\s*,/, 'try tanpa catch di object literal');
assert.match(script, /} catch \(e\) \{/, 'render() harus punya catch');
assert.match(script, /NH\.toggle/, 'toggle harus terpasang');

const tmp = path.join(__dirname, '../../.tmp-nh-script.js');
fs.writeFileSync(tmp, script);
const checked = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
fs.unlinkSync(tmp);
assert.strictEqual(checked.status, 0, checked.stderr || 'script Network Health tidak valid');

console.log('networkHealthToggle.test.js ok');
