'use strict';
const assert = require('assert');
const {
  generateNasMikrotikScript,
  suggestPool,
  normalizeProvision,
  hydrateNas,
} = require('../utils/nasMikrotikScript');

assert.deepStrictEqual(suggestPool(1), {
  gateway_ip: '10.2.96.1',
  pool_ranges: '10.2.96.2-10.2.111.254',
});

const now = new Date(2026, 7, 19, 18, 29, 54);
const sample = {
  shortname: 'uji',
  connection_mode: 'vpn',
  protocols: ['l2tp', 'pptp'],
  vpn_server: '217.216.34.97',
  vpn_username: 'billingradius_6a85939fbdc74',
  vpn_password: '2cd723bc',
  secret: '2cd723bc',
  profile_name: 'BILLINGRADIUS',
  gateway_ip: '10.2.96.1',
  pool_ranges: '10.2.96.2-10.2.111.254',
  expired_gateway: '10.200.200.1',
  expired_pool: '10.200.200.2-10.200.201.254',
  expired_src: '10.200.200.0/23',
  radius_address: '172.20.1.1',
  isolir_redirect: '217.216.34.97:3400',
  now,
};

const v6 = generateNasMikrotikScript({ ...sample, version: 'v6' });
assert.match(v6, /RouterOS v6 Script \(Format redirect-to\)/);
assert.match(v6, /Perangkat: uji/);
assert.match(v6, /Mode: VPN/);
assert.match(v6, /Tanggal: 19\/8\/2026, 18\.29\.54/);
assert.match(v6, /:foreach i in=\[\/ip pool find where name~"BILLINGRADIUS"\] do=\{\/ip pool remove \$i\}/);
assert.match(v6, /\/ip pool add name=BILLINGRADIUS ranges=10\.2\.96\.2-10\.2\.111\.254 comment="BILLINGRADIUS"/);
assert.match(v6, /\/ppp profile add name=BILLINGRADIUS local-address=10\.2\.96\.1 remote-address=BILLINGRADIUS comment="BILLINGRADIUS"/);
assert.match(v6, /\/interface l2tp-client add name=BILLINGRADIUS_L2TP connect-to=217\.216\.34\.97 user=billingradius_6a85939fbdc74 password=2cd723bc /);
assert.match(v6, /\/interface pptp-client add name=BILLINGRADIUS_PPTP connect-to=217\.216\.34\.97 user=billingradius_6a85939fbdc74 password=2cd723bc /);
assert.match(v6, /\/radius add service=ppp,hotspot address=172\.20\.1\.1 secret=2cd723bc comment="BILLINGRADIUS"/);
assert.match(v6, /\/radius incoming set accept=yes/);
assert.match(v6, /\/ppp aaa set use-radius=yes accounting=yes interim-update=00:04:00/);
assert.match(v6, /redirect-to=217\.216\.34\.97:3400 comment="BILLINGRADIUS"/);
assert.match(v6, /out-interface=BILLINGRADIUS_L2TP/);
assert.match(v6, /out-interface=BILLINGRADIUS_PPTP/);
assert.match(v6, /action=redirect to-ports=3128/);

const v7 = generateNasMikrotikScript({ ...sample, version: 'v7' });
assert.match(v7, /RouterOS v7 Script/);
assert.match(v7, /BILLINGRADIUS_L2TP/);
assert.doesNotMatch(v7, /pptp-client add/);
assert.doesNotMatch(v7, /BILLINGRADIUS_PPTP/);

assert.throws(
  () => generateNasMikrotikScript({ ...sample, profile_name: 'X"; /system reboot' }),
  /Nama profile/
);
assert.throws(
  () => generateNasMikrotikScript({ ...sample, vpn_username: 'ab\ncd' }),
  /baris baru/
);

const local = generateNasMikrotikScript({
  ...sample,
  connection_mode: 'local',
  version: 'v6',
});
assert.doesNotMatch(local, /l2tp-client add/);
assert.match(local, /Mode: Langsung/);

const hydrated = hydrateNas({
  id: 1,
  nasname: '10.1.1.1',
  shortname: 'uji',
  secret: 's3cret',
  location: 'SINGOTRUNAN',
  provision: JSON.stringify({ vpn_server: '1.2.3.4', connection_mode: 'vpn' }),
});
assert.strictEqual(hydrated.vpn_server, '1.2.3.4');
assert.strictEqual(hydrated.profile_name, 'BILLINGRADIUS');
assert.strictEqual(hydrated.connection_mode, 'vpn');

const norm = normalizeProvision({}, { nasId: 1 });
assert.strictEqual(norm.gateway_ip, '10.2.96.1');

console.log('nasMikrotikScript.test.js ok');
