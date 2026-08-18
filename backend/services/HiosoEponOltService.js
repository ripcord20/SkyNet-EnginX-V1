'use strict';

/**
 * HiosoEponOltService.js — OLT HIOSO EPON
 *
 * ONU diidentifikasi MAC.
 *   interface epon 0/<port>
 *   show onu / show onu-info all
 *   onu add <id> mac <mac>   (fallback bind-onu di firmware NEUTRAL)
 */

const GponCliOltService = require('./GponCliOltService');

class HiosoEponOltService extends GponCliOltService {
  constructor(config = {}) {
    super(Object.assign({}, config, {
      brand: 'hioso-epon',
      cmd: Object.assign({
        versionCheck: 'show system',
        ifEnter:      'interface epon 0/{port}',
        onuList:      'show onu',
        onuOptical:   'show onu optical-info {id}',
        onuDetail:    'show onu {id}',
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

module.exports = HiosoEponOltService;
