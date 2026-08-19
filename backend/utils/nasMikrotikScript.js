'use strict';
/**
 * Generator script MikroTik NAS (pola Detail NAS / isolir proxy redirect-to).
 * Nilai diambil dari konfigurasi NAS instalasi ini — bukan kredensial pihak ketiga.
 */

const PROFILE_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const HOST_RE = /^[A-Za-z0-9.:_-]{1,253}$/;
const USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const RANGE_RE = /^[0-9.,\/\-]+$/;
const REDIRECT_RE = /^[A-Za-z0-9.:_-]+:\d{1,5}$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatScriptDate(d = new Date()) {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}, ${pad2(d.getHours())}.${pad2(d.getMinutes())}.${pad2(d.getSeconds())}`;
}

function rosQuote(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function rosWord(value) {
  const s = String(value ?? '');
  if (/^[A-Za-z0-9._:\/@+-]+$/.test(s)) return s;
  return rosQuote(s);
}

function rejectUnsafe(label, value) {
  const s = String(value ?? '');
  if (/[\r\n\0]/.test(s)) {
    throw new Error(`${label} tidak boleh berisi baris baru`);
  }
  return s;
}

function requireProfile(name) {
  const s = rejectUnsafe('Nama profile', name).trim();
  if (!PROFILE_RE.test(s)) {
    throw new Error('Nama profile hanya huruf, angka, dan underscore');
  }
  return s;
}

function requireHost(label, value, { optional = false } = {}) {
  const s = rejectUnsafe(label, value).trim();
  if (!s) {
    if (optional) return '';
    throw new Error(`${label} wajib diisi`);
  }
  if (!HOST_RE.test(s)) throw new Error(`${label} tidak valid`);
  return s;
}

function suggestPool(id) {
  const n = Math.max(1, parseInt(id, 10) || 1);
  const block = (n - 1) % 16;
  const base = 96 + block * 16;
  return {
    gateway_ip: `10.2.${base}.1`,
    pool_ranges: `10.2.${base}.2-10.2.${base + 15}.254`,
  };
}

function parseProvision(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function asStringList(value, fallback) {
  if (Array.isArray(value) && value.length) {
    return value.map(v => String(v).toLowerCase().trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,\s]+/).map(v => v.toLowerCase().trim()).filter(Boolean);
  }
  return fallback.slice();
}

function pick(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key) ? body[key] : undefined;
}

function normalizeProvision(input = {}, { nasId } = {}) {
  const pool = suggestPool(nasId);
  const protocols = asStringList(input.protocols, ['l2tp', 'pptp'])
    .filter(p => p === 'l2tp' || p === 'pptp');
  const mode = String(input.connection_mode || 'vpn').toLowerCase() === 'local' ? 'local' : 'vpn';
  const profile_name = String(input.profile_name || 'BILLINGRADIUS').trim() || 'BILLINGRADIUS';
  const vpn_server = String(input.vpn_server || '').trim();
  let isolir_redirect = String(input.isolir_redirect || '').trim();
  if (!isolir_redirect && vpn_server) isolir_redirect = `${vpn_server}:3400`;

  return {
    connection_mode: mode,
    protocols: protocols.length ? protocols : ['l2tp'],
    vpn_server,
    vpn_username: String(input.vpn_username || '').trim(),
    vpn_password: String(input.vpn_password || ''),
    profile_name,
    gateway_ip: String(input.gateway_ip || pool.gateway_ip).trim(),
    pool_ranges: String(input.pool_ranges || pool.pool_ranges).trim(),
    expired_gateway: String(input.expired_gateway || '10.200.200.1').trim(),
    expired_pool: String(input.expired_pool || '10.200.200.2-10.200.201.254').trim(),
    expired_src: String(input.expired_src || '10.200.200.0/23').trim(),
    radius_address: String(input.radius_address || '172.20.1.1').trim(),
    isolir_redirect,
    keepalive: parseInt(input.keepalive, 10) > 0 ? parseInt(input.keepalive, 10) : 120,
  };
}

function mergeProvision(currentRaw, body = {}, { nasId } = {}) {
  const cur = parseProvision(currentRaw);
  const keys = [
    'connection_mode', 'protocols', 'vpn_server', 'vpn_username', 'vpn_password',
    'profile_name', 'gateway_ip', 'pool_ranges', 'expired_gateway', 'expired_pool',
    'expired_src', 'radius_address', 'isolir_redirect', 'keepalive',
  ];
  const next = { ...cur };
  for (const key of keys) {
    const v = pick(body, key);
    if (v !== undefined) next[key] = v;
  }
  return normalizeProvision(next, { nasId });
}

function hydrateNas(row) {
  if (!row) return null;
  const provision = normalizeProvision(parseProvision(row.provision), { nasId: row.id });
  const { provision: _ignored, ...rest } = row;
  return { ...rest, ...provision };
}

function generateNasMikrotikScript(opts = {}) {
  const version = opts.version === 'v7' ? 'v7' : 'v6';
  const name = rejectUnsafe('Nama NAS', opts.shortname || opts.nasname || 'NAS').trim() || 'NAS';
  const tag = requireProfile(opts.profile_name || 'BILLINGRADIUS');
  const mode = String(opts.connection_mode || 'vpn').toLowerCase() === 'local' ? 'local' : 'vpn';
  const protocols = asStringList(opts.protocols, ['l2tp', 'pptp']);
  const useL2tp = mode === 'vpn' && protocols.includes('l2tp');
  const usePptp = mode === 'vpn' && version === 'v6' && protocols.includes('pptp');

  const pool = rejectUnsafe('Block IP pool', opts.pool_ranges);
  const gw = rejectUnsafe('IP gateway', opts.gateway_ip);
  const expiredPool = rejectUnsafe('Expired pool', opts.expired_pool);
  const expiredGw = rejectUnsafe('Expired gateway', opts.expired_gateway);
  const expiredSrc = rejectUnsafe('Expired src', opts.expired_src);
  const radiusAddr = requireHost('RADIUS address', opts.radius_address);
  const secret = rejectUnsafe('Secret NAS', opts.secret || opts.vpn_password);
  if (!secret) throw new Error('Secret NAS wajib diisi');
  if (!RANGE_RE.test(pool) || !RANGE_RE.test(expiredPool) || !RANGE_RE.test(expiredSrc)) {
    throw new Error('Rentang IP pool tidak valid');
  }
  if (!HOST_RE.test(gw) || !HOST_RE.test(expiredGw)) {
    throw new Error('IP gateway tidak valid');
  }

  let vpnServer = '';
  let vpnUser = '';
  let vpnPass = '';
  if (mode === 'vpn') {
    vpnServer = requireHost('IP server VPN', opts.vpn_server);
    vpnUser = rejectUnsafe('Username VPN', opts.vpn_username).trim();
    if (!USER_RE.test(vpnUser)) throw new Error('Username VPN tidak valid');
    vpnPass = rejectUnsafe('Password VPN', opts.vpn_password);
    if (!vpnPass) throw new Error('Password VPN wajib diisi');
  }

  let redirect = String(opts.isolir_redirect || '').trim();
  if (!redirect && vpnServer) redirect = `${vpnServer}:3400`;
  rejectUnsafe('Redirect isolir', redirect);
  if (redirect && !REDIRECT_RE.test(redirect)) {
    throw new Error('Redirect isolir harus host:port');
  }
  if (!redirect) redirect = `${radiusAddr}:3400`;

  const keepalive = parseInt(opts.keepalive, 10) > 0 ? parseInt(opts.keepalive, 10) : 120;
  const l2tpName = `${tag}_L2TP`;
  const pptpName = `${tag}_PPTP`;
  const expiredName = `EXPIRED_${tag}`;
  const when = formatScriptDate(opts.now instanceof Date ? opts.now : new Date());
  const title = version === 'v7'
    ? 'RouterOS v7 Script (Format redirect-to, tanpa PPTP)'
    : 'RouterOS v6 Script (Format redirect-to)';

  const qTag = rosQuote(tag);
  const qSecret = rosWord(secret);
  const qVpnPass = rosWord(vpnPass);
  const qRedirect = rosWord(redirect);

  const L = [];
  L.push(`# ${title}`);
  L.push(`# Perangkat: ${name.replace(/#/g, '')}`);
  L.push(`# Mode: ${mode === 'vpn' ? 'VPN' : 'Langsung'}`);
  L.push(`# Tanggal: ${when}`);
  L.push('');
  L.push(`  # Hapus konfigurasi ${tag} lama`);
  L.push(`  :foreach i in=[/ip pool find where name~${qTag}] do={/ip pool remove $i}`);
  L.push(`  :foreach i in=[/ppp profile find where name~${qTag}] do={/ppp profile remove $i}`);
  L.push(`  :foreach i in=[/interface l2tp-client find where comment~${qTag}] do={/interface l2tp-client remove $i}`);
  if (version === 'v6') {
    L.push(`  :foreach i in=[/interface pptp-client find where comment~${qTag}] do={/interface pptp-client remove $i}`);
  }
  L.push(`  :foreach i in=[/radius find where comment~${qTag}] do={/radius remove $i}`);
  L.push(`  :foreach i in=[/ip pool find where name~${rosQuote(expiredName)}] do={/ip pool remove $i}`);
  L.push(`  :foreach i in=[/ppp profile find where name~${rosQuote(expiredName)}] do={/ppp profile remove $i}`);
  L.push(`  :foreach i in=[/ip proxy access find where comment~${qTag}] do={/ip proxy access remove $i}`);
  L.push(`  :foreach i in=[/ip firewall address-list find where comment~${qTag}] do={/ip firewall address-list remove $i}`);
  L.push(`  :foreach i in=[/ip firewall filter find where comment~${qTag}] do={/ip firewall filter remove $i}`);
  L.push(`  :foreach i in=[/ip firewall nat find where comment~${qTag}] do={/ip firewall nat remove $i}`);
  L.push('  :foreach i in=[/ip firewall address-list find where comment~"IP PRIVATE"] do={/ip firewall address-list remove $i}');
  L.push('  :foreach i in=[/ip firewall filter find where comment~"BLOKIR PROXY DARI LUAR"] do={/ip firewall filter remove $i}');
  L.push(`  # Tambahkan konfigurasi ${tag}`);
  L.push(`  /ip pool add name=${tag} ranges=${pool} comment=${qTag}`);
  L.push('  :delay 1s');
  L.push(`  /ppp profile add name=${tag} local-address=${gw} remote-address=${tag} comment=${qTag}`);
  L.push('  :delay 1s');
  if (useL2tp) {
    L.push(`  /interface l2tp-client add name=${l2tpName} connect-to=${vpnServer} user=${vpnUser} password=${qVpnPass} disabled=no keepalive-timeout=${keepalive} add-default-route=no use-peer-dns=no profile=default-encryption use-ipsec=no allow-fast-path=yes comment=${qTag}`);
    L.push('  :delay 1s');
  }
  if (usePptp) {
    L.push(`  /interface pptp-client add name=${pptpName} connect-to=${vpnServer} user=${vpnUser} password=${qVpnPass} disabled=no keepalive-timeout=${keepalive} add-default-route=no use-peer-dns=no profile=default-encryption comment=${qTag}`);
    L.push('  :delay 1s');
  }
  L.push('  /radius disable [find]');
  L.push('  :delay 1s');
  L.push(`  /radius add service=ppp,hotspot address=${radiusAddr} secret=${qSecret} comment=${qTag}`);
  L.push('  :delay 1s');
  L.push('  /radius incoming set accept=yes');
  L.push('  :delay 1s');
  L.push('  /ppp aaa set use-radius=yes accounting=yes interim-update=00:04:00');
  L.push('  :delay 1s');
  L.push(`  /ip pool add name=${expiredName} ranges=${expiredPool} comment=${qTag}`);
  L.push('  :delay 1s');
  L.push(`  /ppp profile add name=${expiredName} local-address=${expiredGw} remote-address=${expiredName} comment=${qTag}`);
  L.push('  :delay 1s');
  L.push('  /ip proxy');
  L.push('  set enabled=yes port=3128 parent-proxy=0.0.0.0');
  L.push('  :delay 1s');
  L.push('  /ip proxy access');
  L.push(`  add src-address=${expiredSrc} dst-address=!${expiredGw} action=deny redirect-to=${qRedirect} comment=${qTag}`);
  L.push('  :delay 1s');
  L.push('  /ip firewall address-list');
  L.push(`  add list=EXPIRED address=${expiredSrc} comment=${qTag}`);
  L.push('  :delay 1s');
  L.push('  /ip firewall address-list');
  L.push(`  add list=EXPIRED_PAGE address=${expiredGw} comment=${qTag}`);
  L.push('  :delay 1s');
  if (vpnServer) {
    L.push(`  add list=EXPIRED_PAGE address=${vpnServer} comment=${qTag}`);
    L.push('  :delay 1s');
  }
  L.push('  add list=RFC_1918 address=10.0.0.0/8 comment="IP PRIVATE"');
  L.push('  :delay 1s');
  L.push('  add list=RFC_1918 address=172.16.0.0/12 comment="IP PRIVATE"');
  L.push('  :delay 1s');
  L.push('  add list=RFC_1918 address=192.168.0.0/16 comment="IP PRIVATE"');
  L.push('  :delay 1s');
  L.push('  /ip firewall filter');
  L.push('  add chain=input protocol=tcp dst-port=3128 src-address-list=!RFC_1918 action=drop comment="BLOKIR PROXY DARI LUAR"');
  L.push('  :delay 1s');
  L.push('  /ip firewall filter');
  L.push(`  add chain=forward protocol=tcp dst-port=!53,80 src-address-list=EXPIRED dst-address-list=!EXPIRED_PAGE action=drop comment=${qTag}`);
  L.push('  :delay 1s');
  L.push('  /ip firewall nat');
  if (useL2tp) {
    L.push(`  add chain=srcnat action=masquerade out-interface=${l2tpName} comment=${qTag}`);
    L.push('  :delay 1s');
  }
  if (usePptp) {
    L.push(`  add chain=srcnat action=masquerade out-interface=${pptpName} comment=${qTag}`);
    L.push('  :delay 1s');
  }
  L.push('  /ip firewall nat');
  L.push(`  add chain=dstnat protocol=tcp dst-port=80,443 src-address-list=EXPIRED action=redirect to-ports=3128 comment=${qTag}`);
  L.push('  :delay 1s');
  return L.join('\n');
}

module.exports = {
  suggestPool,
  parseProvision,
  normalizeProvision,
  mergeProvision,
  hydrateNas,
  generateNasMikrotikScript,
  formatScriptDate,
};
