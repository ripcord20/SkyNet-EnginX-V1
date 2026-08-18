'use strict';

/**
 * HsgqGponOltService.js — OLT HSGQ GPON (HA400 / mini GPON, Cortina-like)
 *
 * Bukan HSGQ EPON E04/E08. ONU diidentifikasi serial GPON.
 *   interface gpon 0/<port>
 *   show onu_information
 *   onu add <id> type <type> sn <sn>
 */

const GponCliOltService = require('./GponCliOltService');

class HsgqGponOltService extends GponCliOltService {
  constructor(config = {}) {
    super(Object.assign({}, config, {
      brand: 'hsgq-gpon',
      cmd: Object.assign({
        versionCheck: 'show system_info',
        ifEnter:      'interface gpon 0/{port}',
        onuList:      'show onu_information',
        onuOptical:   'show onu optical-info {id} all',
        onuDetail:    'show onu_information {id}',
        uncfg:        'show onu auto-find',
        authorize:    'onu add {id} type {type} sn {sn}',
        editName:     'onu {id} name {name}',
        editDesc:     'onu {id} description {desc}',
        reboot:       'onu reboot {id}',
        del:          'no onu {id}',
      }, config.cmd || {}),
    }));
    this.defaultPonPorts = config.defaultPonPorts || 8;
    this.epon = false;
  }
}

module.exports = HsgqGponOltService;
