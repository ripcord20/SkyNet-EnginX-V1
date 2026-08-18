'use strict';

/**
 * CdataEponOltService.js — OLT CDATA EPON (FD1104 / FD1108 / FD1208)
 *
 * ONU diidentifikasi MAC, bukan serial GPON.
 *   interface epon 0/<port>
 *   show onu_information
 *   onu add <id> mac <mac>
 */

const GponCliOltService = require('./GponCliOltService');

class CdataEponOltService extends GponCliOltService {
  constructor(config = {}) {
    super(Object.assign({}, config, {
      brand: 'cdata-epon',
      cmd: Object.assign({
        versionCheck: 'show system_info',
        ifEnter:      'interface epon 0/{port}',
        onuList:      'show onu_information',
        onuOptical:   'show onu optical-info {id} all',
        onuDetail:    'show onu_information {id}',
        uncfg:        'show onu auto-find',
        authorize:    'onu add {id} mac {mac}',
        editName:     'onu {id} name {name}',
        editDesc:     'onu {id} description {desc}',
        reboot:       'onu reboot {id}',
        del:          'no onu {id}',
      }, config.cmd || {}),
    }));
    this.defaultPonPorts = config.defaultPonPorts || 8;
    this.epon = true;
  }
}

module.exports = CdataEponOltService;
