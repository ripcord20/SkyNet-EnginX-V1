'use strict';

/**
 * Payload + rencana create WireGuard ke MikroTik.
 *
 * REST v7: PUT /interface/wireguard = add
 * Binary API: PUT dipetakan ke /interface/wireguard/add
 * POST ke collection (tanpa /add) BUKAN add — binary mengirim command
 * "/interface/wireguard" yang invalid, REST biasanya 400.
 */

function trimStr(v) {
  return String(v == null ? '' : v).trim();
}

function buildWgInterfaceBody(data = {}) {
  const body = {};
  const name = trimStr(data.name);
  if (name) body.name = name;
  const listen = trimStr(data.listenPort || data['listen-port']);
  if (listen) body['listen-port'] = listen;
  const mtu = trimStr(data.mtu);
  if (mtu) body.mtu = mtu;
  const comment = trimStr(data.comment);
  if (comment) body.comment = comment;
  const priv = data.privateKey || data['private-key'];
  if (priv) body['private-key'] = priv;
  return body;
}

function buildWgPeerBody(data = {}) {
  const body = {};
  if (data.interface) body.interface = data.interface;
  const pub = data.publicKey || data['public-key'];
  if (pub) body['public-key'] = pub;
  const priv = data.privateKey || data['private-key'];
  if (priv) body['private-key'] = priv;
  const allowed = data.allowedAddress || data['allowed-address'];
  if (allowed) body['allowed-address'] = allowed;
  const ep = data.endpointAddress || data['endpoint-address'];
  if (ep) body['endpoint-address'] = ep;
  const epPort = data.endpointPort || data['endpoint-port'];
  if (epPort) body['endpoint-port'] = String(epPort);
  const ka = data.keepalive || data['persistent-keepalive'];
  if (ka) body['persistent-keepalive'] = ka;
  if (data.comment) body.comment = data.comment;
  const psk = data.presharedKey || data['preshared-key'];
  if (psk) body['preshared-key'] = psk;
  return body;
}

function mikrotikCreatePlan(collectionPath) {
  const path = String(collectionPath || '').replace(/\/+$/, '') || '/';
  return {
    primary: { method: 'PUT', path },
    fallback: { method: 'POST', path: `${path}/add` },
  };
}

function asMikrotikList(rows) {
  if (Array.isArray(rows)) return rows;
  if (rows && typeof rows === 'object') return [rows];
  return [];
}

function friendlyWireGuardError(message) {
  const msg = String(message || '');
  if (/no such command|no such item directory|failure:.*wireguard|\(wireguard\)/i.test(msg)) {
    return 'Router tidak punya menu WireGuard. Aktifkan package wireguard di MikroTik (System → Packages), pastikan REST/API Username terisi di Device Management.';
  }
  if (/already have interface|already have such name|already exists/i.test(msg)) {
    return 'Nama interface WireGuard sudah dipakai. Pilih nama lain.';
  }
  return msg;
}

module.exports = {
  buildWgInterfaceBody,
  buildWgPeerBody,
  mikrotikCreatePlan,
  asMikrotikList,
  friendlyWireGuardError,
};
