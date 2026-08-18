const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const crypto = require('crypto');
const logger = require('../utils/logger');

function resolveDeviceId(req) {
  const q = req.query?.device_id;
  const h = req.headers?.['x-device-id'];
  const v = q || h;
  return v ? parseInt(v) : null;
}
async function getMt(req) {
  return getMikrotikInstanceByDevice(resolveDeviceId(req));
}

function genWgKeys() {
  const kp = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    privateKey: kp.privateKey.slice(-32).toString('base64'),
    publicKey: kp.publicKey.slice(-32).toString('base64'),
  };
}

class WireGuardController {
  async overview(req, res) {
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const mt = await getMt(req);
      const [ifaces, peers] = await Promise.all([
        mt.getWireGuardInterfaces(),
        mt.getWireGuardPeers(),
      ]);
      const handshakeLive = (hs) => {
        if (!hs) return false;
        return !/[dw]/i.test(hs) && !/\d+h/i.test(hs);
      };
      const live = peers.filter(p => !p.disabled && handshakeLive(p.lastHandshake)).length;
      res.json({
        success: true,
        data: {
          interfaces: ifaces,
          peers,
          stats: {
            interfaces: ifaces.length,
            peers: peers.length,
            online: live,
            disabled: peers.filter(p => p.disabled).length + ifaces.filter(i => i.disabled).length,
          }
        }
      });
    } catch (err) {
      logger.error(`WireGuard overview: ${err.message}`);
      if (/ECONNRESET|timeout|ECONNREFUSED/i.test(err.message)) {
        return res.json({ success: true, data: { interfaces: [], peers: [], stats: { interfaces: 0, peers: 0, online: 0, disabled: 0 } }, warning: err.message });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  generateKeys(req, res) {
    try {
      res.json({ success: true, data: genWgKeys() });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async createInterface(req, res) {
    try {
      const mt = await getMt(req);
      if (!req.body?.name) return res.status(400).json({ success: false, message: 'Nama interface wajib diisi' });
      await mt.createWireGuardInterface(req.body);
      res.json({ success: true, message: 'Interface WireGuard dibuat' });
    } catch (err) {
      logger.error('WG createInterface: ' + err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  }

  async updateInterface(req, res) {
    try {
      const mt = await getMt(req);
      await mt.updateWireGuardInterface(req.params.id, req.body || {});
      res.json({ success: true, message: 'Interface WireGuard diupdate' });
    } catch (err) {
      logger.error('WG updateInterface: ' + err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  }

  async deleteInterface(req, res) {
    try {
      const mt = await getMt(req);
      await mt.deleteWireGuardInterface(req.params.id);
      res.json({ success: true, message: 'Interface WireGuard dihapus' });
    } catch (err) {
      logger.error('WG deleteInterface: ' + err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  }

  async createPeer(req, res) {
    try {
      const mt = await getMt(req);
      const body = { ...(req.body || {}) };
      if (!body.interface) return res.status(400).json({ success: false, message: 'Interface wajib dipilih' });
      if (!body.publicKey && !body['public-key']) {
        const keys = genWgKeys();
        body.publicKey = keys.publicKey;
        body.privateKey = keys.privateKey;
        await mt.createWireGuardPeer(body);
        return res.json({
          success: true,
          message: 'Peer WireGuard dibuat',
          data: { publicKey: keys.publicKey, privateKey: keys.privateKey }
        });
      }
      await mt.createWireGuardPeer(body);
      res.json({ success: true, message: 'Peer WireGuard dibuat' });
    } catch (err) {
      logger.error('WG createPeer: ' + err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  }

  async updatePeer(req, res) {
    try {
      const mt = await getMt(req);
      await mt.updateWireGuardPeer(req.params.id, req.body || {});
      res.json({ success: true, message: 'Peer WireGuard diupdate' });
    } catch (err) {
      logger.error('WG updatePeer: ' + err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  }

  async deletePeer(req, res) {
    try {
      const mt = await getMt(req);
      await mt.deleteWireGuardPeer(req.params.id);
      res.json({ success: true, message: 'Peer WireGuard dihapus' });
    } catch (err) {
      logger.error('WG deletePeer: ' + err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  }
}

module.exports = new WireGuardController();
