/**
 * Normalisasi payload create/update Device Management.
 * SNMP saja tidak boleh membawa sisa field API (port 80 + username kosong)
 * yang kemudian memicu "isi username" di Traffic / NMS / Kesehatan Jaringan.
 */
function sanitizeDevicePayload(body = {}) {
  const data = { ...(body || {}) };
  const name = String(data.name || '').trim();
  const ip = String(data.ip_address || '').trim();
  const mon = String(data.monitoring_type || 'snmp').trim() || 'snmp';

  if (!name || !ip) {
    const err = new Error('Nama dan IP Address wajib diisi');
    err.status = 400;
    throw err;
  }

  data.name = name;
  data.ip_address = ip;
  data.monitoring_type = mon;

  if (mon === 'snmp') {
    data.api_username = null;
    data.api_password = null;
    data.api_port = null;
    data.api_protocol = null;
  } else if (mon === 'api' || mon === 'both') {
    const user = String(data.api_username || '').trim();
    if (!user) {
      const err = new Error('API Username wajib diisi untuk metode API / SNMP+API. Untuk SNMP saja, pilih "SNMP saja".');
      err.status = 400;
      throw err;
    }
    data.api_username = user;
  }

  return data;
}

function wantsApiMonitor(monitoringType) {
  return monitoringType === 'api' || monitoringType === 'both';
}

function wantsSnmpMonitor(monitoringType) {
  return monitoringType === 'snmp' || monitoringType === 'both' || !monitoringType;
}

module.exports = {
  sanitizeDevicePayload,
  wantsApiMonitor,
  wantsSnmpMonitor,
};
