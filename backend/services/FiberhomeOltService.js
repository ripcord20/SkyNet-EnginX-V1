'use strict';

/**
 * FiberhomeOltService.js — AN5516 / AN6000 (GPON)
 *
 * Pola CLI umum AN5516:
 *   enable
 *   cd onu
 *   show ont info / show ont_state
 *   show ont optical-info
 *   show ont autofind
 *
 * Firmware FiberHome sangat bervariasi. Service ini mencoba beberapa
 * perintah cadangan. Selalu Test Koneksi sebelum produksi.
 */

const BaseCliOltService = require('./BaseCliOltService');
const logger = require('../utils/logger');

class FiberhomeOltService extends BaseCliOltService {
  constructor(config = {}) {
    super(Object.assign({
      pagingOffCmd: 'terminal length 0',
      prompt: /[)#>\]]\s*$/,
    }, config));
    this.brand = 'fiberhome';
    this.rxGood = config.rxGood ?? -25;
    this.rxWarning = config.rxWarning ?? -28;
    this.defaultPonPorts = config.defaultPonPorts || 8;
  }

  _normPort(p) {
    const s = String(p || '').replace(/^.*pon[\s_\/-]*/i, '');
    const m = s.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }

  _quality(rx) {
    if (rx == null || Number.isNaN(rx)) return 'unknown';
    if (rx >= this.rxGood) return 'good';
    if (rx >= this.rxWarning) return 'warning';
    return 'critical';
  }

  _parseDbm(v) {
    const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  async _priv() {
    await this._safeExec('enable');
    if (this.enablePassword) await this._safeExec(this.enablePassword);
  }

  async _enterOnu() {
    await this._priv();
    await this._safeExec('cd onu');
  }

  async _leaveOnu() {
    await this._safeExec('cd ..');
  }

  async testConnection() {
    try {
      await this.connect();
      await this._priv();
      const out = await this._safeExec('show version')
        || await this._safeExec('show sysinfo')
        || await this._safeExec('show card');
      await this.disconnect();
      const first = String(out || 'OK').split('\n').map(s => s.trim()).filter(Boolean)[0] || 'OK';
      return { success: true, message: `Terhubung ke ${this.name} (FiberHome)`, info: first.slice(0, 160) };
    } catch (err) {
      await this.disconnect().catch(() => {});
      return { success: false, error: err.message };
    }
  }

  parseOnuList(out, port) {
    const list = [];
    for (const line of String(out || '').split(/\r?\n/)) {
      const row = line.trim();
      if (!row || /ont[- ]?id|serial|-{5,}/i.test(row)) continue;
      const m = row.match(/^(\d+)\s+(\S+)\s+(\S+)/);
      if (!m) continue;
      const onuId = parseInt(m[1], 10);
      if (Number.isNaN(onuId)) continue;
      const online = /online|up|working|active/i.test(row);
      list.push({
        onu_id: onuId,
        onu_if: `${port}/${onuId}`,
        pon: String(port),
        sn: m[2],
        name: '',
        type: m[3] && !/online|offline/i.test(m[3]) ? m[3] : '',
        status: online ? 'online' : 'offline',
        onu_rx_dbm: null,
        quality: 'unknown',
      });
    }
    return list;
  }

  async _showOnu(port) {
    return await this._safeExec(`show ont info ${port}`)
      || await this._safeExec(`show ont_state ${port}`)
      || await this._safeExec('show ont info')
      || await this._safeExec('show ont_state')
      || '';
  }

  async getOnuState(portRef, { withPower = false } = {}) {
    const port = this._normPort(portRef);
    await this._enterOnu();
    const out = await this._showOnu(port);
    let list = this.parseOnuList(out, port);
    if (withPower) {
      for (const o of list) {
        try {
          const pow = await this._safeExec(`show ont optical-info ${port} ${o.onu_id}`)
            || await this._safeExec(`show ont_opticalinfo ${port} ${o.onu_id}`) || '';
          const rx = this._extractRx(pow);
          o.onu_rx_dbm = rx;
          o.quality = this._quality(rx);
        } catch (e) { o.onu_rx_dbm = null; o.quality = 'unknown'; }
      }
    }
    await this._leaveOnu();
    return list;
  }

  _extractRx(out) {
    const m = String(out || '').match(/Rx[^\d\-]*([\-\d.]+)/i) || String(out || '').match(/([\-\d.]+)\s*dBm/i);
    return m ? this._parseDbm(m[1]) : null;
  }

  async getUncfgOnu(portRef) {
    await this._enterOnu();
    const out = await this._safeExec('show ont autofind')
      || await this._safeExec('show ont_autofind')
      || await this._safeExec('show uncfg')
      || '';
    await this._leaveOnu();
    const items = [];
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/([A-Z0-9]{8,}|[A-Fa-f0-9:]{12,})/);
      if (m) items.push({ pon: portRef || '', sn: m[1], type: '' });
    }
    return items;
  }

  async getOnuDetail(portRef, onuId) {
    const port = this._normPort(portRef);
    await this._enterOnu();
    const info = await this._safeExec(`show ont info ${port} ${onuId}`) || '';
    const pow = await this._safeExec(`show ont optical-info ${port} ${onuId}`) || '';
    await this._leaveOnu();
    const rx = this._extractRx(pow);
    return { onu_id: onuId, pon: String(port), raw: info, onu_rx_dbm: rx, quality: this._quality(rx) };
  }

  async getOnuPower(portRef, onuId) {
    const port = this._normPort(portRef);
    await this._enterOnu();
    const out = await this._safeExec(`show ont optical-info ${port} ${onuId}`)
      || await this._safeExec(`show ont_opticalinfo ${port} ${onuId}`) || '';
    await this._leaveOnu();
    const rx = this._extractRx(out);
    return { onu_rx_dbm: rx, quality: this._quality(rx), raw: out };
  }

  async getSystemInfo() {
    await this._priv();
    const ver = await this._safeExec('show version') || await this._safeExec('show sysinfo') || '';
    const first = String(ver).split('\n').map(s => s.trim()).find(Boolean) || 'FiberHome';
    return { version: first.slice(0, 80), model: 'FiberHome GPON', cpu: '—', temperature: '—', uptime: '—' };
  }

  async getPortSummary(ports = []) {
    const list = (ports && ports.length) ? ports : [1, 2, 3, 4];
    const result = [];
    for (const p of list) {
      try {
        const onus = await this.getOnuState(p, { withPower: false });
        const online = onus.filter(o => o.status === 'online').length;
        result.push({ port: p, total: onus.length, online, offline: onus.length - online });
      } catch (e) {
        result.push({ port: p, total: 0, online: 0, offline: 0, error: e.message });
      }
    }
    return result;
  }

  async getAllOnus({ withPower = false, ports = null, maxPorts = 8 } = {}) {
    const scan = (ports && ports.length) ? ports : Array.from({ length: maxPorts || this.defaultPonPorts }, (_, i) => i + 1);
    const onus = [];
    for (const p of scan) {
      try { onus.push(...await this.getOnuState(p, { withPower })); }
      catch (e) { logger.warn('[FiberhomeOlt] port ' + p + ': ' + e.message); }
    }
    return { onus, ports: this._portSummaryFromOnus(onus) };
  }

  _portSummaryFromOnus(onus) {
    const map = {};
    for (const o of onus) {
      const k = String(o.pon || '?');
      if (!map[k]) map[k] = { port: k, total: 0, online: 0, offline: 0 };
      map[k].total++;
      if (o.status === 'online') map[k].online++;
      else map[k].offline++;
    }
    return Object.values(map);
  }

  async authorizeOnu({ port, onuId, type, sn, name, description }) {
    const p = this._normPort(port);
    const id = onuId || 1;
    const snClean = String(sn || '').replace(/[^A-Za-z0-9]/g, '');
    await this._enterOnu();
    const out = await this.exec(`set ont add ${p} ${id} ${snClean} ${type || 'ONU'}`)
      .catch(async () => this.exec(`whitelist add ${p} ${id} sn ${snClean}`));
    if (name || description) {
      await this._safeExec(`set ont desc ${p} ${id} ${String(description || name).replace(/\s+/g, '_')}`);
    }
    await this._leaveOnu();
    return { success: true, onuIf: `${p}/${id}`, onu_id: id, output: out };
  }

  async editOnu(portRef, onuId, { name, description } = {}) {
    const p = this._normPort(portRef);
    await this._enterOnu();
    const desc = String(description || name || '').replace(/\s+/g, '_').slice(0, 32);
    if (desc) await this._safeExec(`set ont desc ${p} ${onuId} ${desc}`);
    await this._leaveOnu();
    return { success: true };
  }

  async rebootOnu(portRef, onuId) {
    const p = this._normPort(portRef);
    await this._enterOnu();
    await this._safeExec(`reset ont ${p} ${onuId}`);
    await this._leaveOnu();
    return { success: true };
  }

  async deleteOnu(portRef, onuId) {
    const p = this._normPort(portRef);
    await this._enterOnu();
    await this._safeExec(`set ont delete ${p} ${onuId}`);
    await this._safeExec(`whitelist delete ${p} ${onuId}`);
    await this._leaveOnu();
    return { success: true };
  }
}

module.exports = FiberhomeOltService;
