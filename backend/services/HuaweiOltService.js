'use strict';

/**
 * HuaweiOltService.js — MA5600T / MA5800 (GPON)
 *
 * Pola CLI:
 *   enable → config
 *   interface gpon <frame>/<slot>
 *   display ont info <port> all
 *   display ont optical-info <port> <ont-id>
 *   ont add <port> <id> sn-auth "<SN>" omci ont-lineprofile-id N ont-srvprofile-id N
 *
 * Index PON: frame/slot/port  (mis. 0/1/0). Berbeda dari ZTE 1/2/1 tapi
 * bentuknya sama tiga segmen, jadi UI memakai placeholder 0/1/0.
 */

const BaseCliOltService = require('./BaseCliOltService');
const logger = require('../utils/logger');

class HuaweiOltService extends BaseCliOltService {
  constructor(config = {}) {
    super(Object.assign({
      pagingOffCmd: 'scroll',
      prompt: /[)#>\]]\s*$/,
    }, config));
    this.brand = 'huawei';
    this.rxGood = config.rxGood ?? -25;
    this.rxWarning = config.rxWarning ?? -28;
    this.lineProfileId = config.lineProfileId || 1;
    this.srvProfileId = config.srvProfileId || 1;
  }

  _parsePon(ref) {
    const s = String(ref || '').replace(/gpon[-_ ]?/i, '').trim();
    let m = s.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
    if (m) return { frame: +m[1], slot: +m[2], port: +m[3], board: `${m[1]}/${m[2]}` };
    m = s.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return { frame: 0, slot: +m[1], port: +m[2], board: `0/${m[1]}` };
    m = s.match(/(\d+)/);
    if (m) return { frame: 0, slot: 1, port: +m[1], board: '0/1' };
    return { frame: 0, slot: 1, port: 0, board: '0/1' };
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

  async _enterConfig() {
    await this._safeExec('enable');
    if (this.enablePassword) await this._safeExec(this.enablePassword);
    await this._safeExec('config');
  }

  async _enterIf(pon) {
    const p = this._parsePon(pon);
    await this._enterConfig();
    await this.exec(`interface gpon ${p.board}`);
    return p;
  }

  async _exitIf() {
    await this._safeExec('quit');
    await this._safeExec('quit');
  }

  async testConnection() {
    try {
      await this.connect();
      await this._safeExec('enable');
      const out = await this._safeExec('display version') || await this._safeExec('display sysinfo');
      await this.disconnect();
      const first = String(out).split('\n').map(s => s.trim()).filter(Boolean)[0] || 'OK';
      return { success: true, message: `Terhubung ke ${this.name} (Huawei)`, info: first.slice(0, 160) };
    } catch (err) {
      await this.disconnect().catch(() => {});
      return { success: false, error: err.message };
    }
  }

  parseOnuList(out, pon) {
    const p = this._parsePon(pon);
    const list = [];
    const lines = String(out || '').split(/\r?\n/);
    for (const line of lines) {
      const row = line.trim();
      if (!row || /^-{5,}|F\/S\/P|ONT\s+ID|SN\s+Control/i.test(row)) continue;
      const m = row.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)/)
        || row.match(/(\d+)\s+([A-Fa-f0-9]{8,}|[A-Z]{4}[A-Fa-f0-9]{8,})\s+\S+\s+(\S+)\s+(\S+)/);
      if (!m) continue;
      const onuId = parseInt(m[1], 10);
      if (Number.isNaN(onuId)) continue;
      const sn = m[2];
      const run = String(m[4] || m[3] || '').toLowerCase();
      const online = /online|up|working/.test(run);
      list.push({
        onu_id: onuId,
        onu_if: `${p.board}/${p.port}:${onuId}`,
        pon: `${p.frame}/${p.slot}/${p.port}`,
        sn,
        name: '',
        type: '',
        status: online ? 'online' : 'offline',
        onu_rx_dbm: null,
        quality: 'unknown',
      });
    }
    return list;
  }

  async getOnuState(portRef, { withPower = false } = {}) {
    const p = await this._enterIf(portRef);
    const out = await this.exec(`display ont info ${p.port} all`);
    let list = this.parseOnuList(out, portRef);
    if (withPower) {
      for (const o of list) {
        try {
          const pow = await this.exec(`display ont optical-info ${p.port} ${o.onu_id}`);
          const rx = this._extractRx(pow);
          o.onu_rx_dbm = rx;
          o.quality = this._quality(rx);
        } catch (e) { o.onu_rx_dbm = null; o.quality = 'unknown'; }
      }
    }
    await this._exitIf();
    return list;
  }

  _extractRx(out) {
    const m = String(out || '').match(/Rx\s*optical\s*power[^\d\-]*([\-\d.]+)/i)
      || String(out || '').match(/ONT\s*Rx[^\d\-]*([\-\d.]+)/i)
      || String(out || '').match(/([\-\d.]+)\s*dBm/i);
    return m ? this._parseDbm(m[1]) : null;
  }

  async getUncfgOnu() {
    await this._enterConfig();
    const out = await this._safeExec('display ont autofind all') || '';
    await this._safeExec('quit');
    const items = [];
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/(\d+\/\s*\d+\/\s*\d+)\s+(\S+)/) || line.match(/SN\s*[:=]\s*(\S+)/i);
      if (!m) continue;
      if (m[2]) items.push({ pon: m[1].replace(/\s+/g, ''), sn: m[2], type: '' });
      else items.push({ pon: '', sn: m[1], type: '' });
    }
    return items;
  }

  async getOnuDetail(portRef, onuId) {
    const p = await this._enterIf(portRef);
    const info = await this._safeExec(`display ont info ${p.port} ${onuId}`);
    const pow = await this._safeExec(`display ont optical-info ${p.port} ${onuId}`);
    await this._exitIf();
    const rx = this._extractRx(pow);
    return {
      onu_id: onuId,
      pon: `${p.frame}/${p.slot}/${p.port}`,
      raw: info,
      onu_rx_dbm: rx,
      quality: this._quality(rx),
    };
  }

  async getOnuPower(portRef, onuId) {
    const p = await this._enterIf(portRef);
    const out = await this.exec(`display ont optical-info ${p.port} ${onuId}`);
    await this._exitIf();
    const rx = this._extractRx(out);
    return { onu_rx_dbm: rx, quality: this._quality(rx), raw: out };
  }

  async getSystemInfo() {
    await this._enterConfig();
    const ver = await this._safeExec('display version');
    const cpu = await this._safeExec('display cpu');
    await this._safeExec('quit');
    const version = (String(ver).match(/Version\s*[:=]\s*(.+)/i) || [])[1]
      || String(ver).split('\n').map(s => s.trim()).find(Boolean) || '—';
    const cpuM = String(cpu).match(/(\d+)\s*%/);
    return {
      version: String(version).slice(0, 80),
      model: 'Huawei GPON',
      cpu: cpuM ? cpuM[1] + '%' : '—',
      temperature: '—',
      uptime: '—',
    };
  }

  async getPortSummary(ports = []) {
    const result = [];
    const list = ports.length ? ports : ['0/1/0', '0/1/1', '0/2/0'];
    for (const pon of list) {
      try {
        const onus = await this.getOnuState(pon, { withPower: false });
        const online = onus.filter(o => o.status === 'online').length;
        result.push({ port: pon, total: onus.length, online, offline: onus.length - online });
      } catch (e) {
        result.push({ port: pon, total: 0, online: 0, offline: 0, error: e.message });
      }
    }
    return result;
  }

  async getAllOnus({ withPower = false, ports = null } = {}) {
    await this._enterConfig();
    const out = await this._safeExec('display ont info all') || '';
    await this._safeExec('quit');
    const onus = [];
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s+(\d+)\s+(\S+)\s+\S+\s+(\S+)/);
      if (!m) continue;
      const pon = `${m[1]}/${m[2]}/${m[3]}`;
      if (ports && ports.length && !ports.includes(pon) && !ports.includes(m[3])) continue;
      const online = /online|up|working/i.test(m[6]);
      onus.push({
        onu_id: +m[4],
        onu_if: `${pon}:${m[4]}`,
        pon,
        sn: m[5],
        name: '',
        type: '',
        status: online ? 'online' : 'offline',
        onu_rx_dbm: null,
        quality: 'unknown',
      });
    }
    if (!onus.length && ports && ports.length) {
      for (const pon of ports) {
        try { onus.push(...await this.getOnuState(pon, { withPower })); }
        catch (e) { logger.warn('[HuaweiOlt] getAllOnus port ' + pon + ': ' + e.message); }
      }
    }
    return { onus, ports: this._portSummaryFromOnus(onus), scannedPorts: [...new Set(onus.map(o => o.pon))] };
  }

  _portSummaryFromOnus(onus) {
    const map = {};
    for (const o of onus) {
      const k = o.pon || '?';
      if (!map[k]) map[k] = { port: k, total: 0, online: 0, offline: 0 };
      map[k].total++;
      if (o.status === 'online') map[k].online++;
      else map[k].offline++;
    }
    return Object.values(map);
  }

  async authorizeOnu({ port, onuId, type, sn, name, description }) {
    const p = await this._enterIf(port);
    const id = onuId || 1;
    const snClean = String(sn || '').replace(/[^A-Za-z0-9]/g, '');
    const desc = String(description || name || '').replace(/["\r\n]/g, '').slice(0, 40);
    const cmd = `ont add ${p.port} ${id} sn-auth "${snClean}" omci ont-lineprofile-id ${this.lineProfileId} ont-srvprofile-id ${this.srvProfileId}`
      + (desc ? ` desc "${desc}"` : '');
    const out = await this.exec(cmd);
    await this._exitIf();
    const err = this._firstError(out);
    if (err) throw new Error(err);
    return { success: true, onuIf: `${p.frame}/${p.slot}/${p.port}:${id}`, onu_id: id, output: out };
  }

  async editOnu(portRef, onuId, { name, description } = {}) {
    const p = await this._enterIf(portRef);
    const desc = String(description || name || '').replace(/["\r\n]/g, '').slice(0, 40);
    if (desc) await this.exec(`ont modify ${p.port} ${onuId} desc "${desc}"`);
    await this._exitIf();
    return { success: true };
  }

  async rebootOnu(portRef, onuId) {
    const p = await this._enterIf(portRef);
    await this.exec(`ont reset ${p.port} ${onuId}`);
    await this._safeExec('y');
    await this._exitIf();
    return { success: true };
  }

  async deleteOnu(portRef, onuId) {
    const p = await this._enterIf(portRef);
    await this.exec(`ont delete ${p.port} ${onuId}`);
    await this._safeExec('y');
    await this._exitIf();
    return { success: true };
  }
}

module.exports = HuaweiOltService;
