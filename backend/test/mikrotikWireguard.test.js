'use strict';

const assert = require('assert');
const {
  buildWgInterfaceBody,
  buildWgPeerBody,
  mikrotikCreatePlan,
  asMikrotikList,
  friendlyWireGuardError,
} = require('../utils/mikrotikWireguard');

// Repro: create WG memakai POST collection — binary API TIDAK menambah (/add)
const plan = mikrotikCreatePlan('/interface/wireguard');
assert.strictEqual(plan.primary.method, 'PUT', 'REST/binary add harus PUT');
assert.strictEqual(plan.primary.path, '/interface/wireguard');
assert.strictEqual(plan.fallback.method, 'POST');
assert.strictEqual(plan.fallback.path, '/interface/wireguard/add');

const peerPlan = mikrotikCreatePlan('/interface/wireguard/peers');
assert.strictEqual(peerPlan.primary.method, 'PUT');
assert.strictEqual(peerPlan.fallback.path, '/interface/wireguard/peers/add');

const body = buildWgInterfaceBody({
  name: '  wg-sky  ',
  listenPort: '13231',
  mtu: '',
  comment: '',
});
assert.deepStrictEqual(body, { name: 'wg-sky', 'listen-port': '13231' });
assert.ok(!('mtu' in body), 'field kosong tidak boleh dikirim (REST v7 sering 400)');

const min = buildWgInterfaceBody({ name: 'wg1' });
assert.deepStrictEqual(min, { name: 'wg1' });

const peer = buildWgPeerBody({
  interface: 'wg-sky',
  publicKey: 'abc=',
  allowedAddress: '10.10.10.2/32',
  keepalive: '25s',
});
assert.strictEqual(peer.interface, 'wg-sky');
assert.strictEqual(peer['public-key'], 'abc=');
assert.strictEqual(peer['allowed-address'], '10.10.10.2/32');
assert.strictEqual(peer['persistent-keepalive'], '25s');

assert.deepStrictEqual(asMikrotikList(null), []);
assert.strictEqual(asMikrotikList({ name: 'wg1' }).length, 1, 'REST 1 row object harus tetap list');
assert.strictEqual(asMikrotikList([{ name: 'a' }, { name: 'b' }]).length, 2);

assert.match(
  friendlyWireGuardError('MikroTik: no such command or directory (wireguard)'),
  /package wireguard/i
);

// Binary API: PUT → /add, POST collection tanpa verb = command mentah (gagal)
function binaryCommand(method, endpoint) {
  if (method === 'PUT') return endpoint + '/add';
  if (method === 'POST') return endpoint; // bug lama
  return endpoint;
}
assert.strictEqual(binaryCommand('POST', '/interface/wireguard'), '/interface/wireguard', 'repro: POST bukan add');
assert.strictEqual(binaryCommand('PUT', '/interface/wireguard'), '/interface/wireguard/add');

console.log('mikrotikWireguard.test.js ok');
