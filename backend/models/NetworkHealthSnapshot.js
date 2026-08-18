'use strict';

const { DataTypes } = require('sequelize');

/**
 * Satu baris per device — snapshot terakhir Network Health Monitor.
 * Dipakai dashboard (bukan time-series berat). Histori ringkas ada di
 * network_health_samples (retensi 24 jam).
 */
module.exports = (sequelize) => {
  return sequelize.define('NetworkHealthSnapshot', {
    id:               { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    device_id:        { type: DataTypes.INTEGER, allowNull: false, unique: true },
    status:           { type: DataTypes.ENUM('online', 'offline', 'warning', 'unknown'), defaultValue: 'unknown' },
    reachable:        { type: DataTypes.BOOLEAN, defaultValue: false },
    rtt_avg:          { type: DataTypes.FLOAT, allowNull: true },
    rtt_min:          { type: DataTypes.FLOAT, allowNull: true },
    rtt_max:          { type: DataTypes.FLOAT, allowNull: true },
    packet_loss:      { type: DataTypes.FLOAT, allowNull: true },
    cpu:              { type: DataTypes.FLOAT, allowNull: true },
    ram:              { type: DataTypes.FLOAT, allowNull: true },
    disk:             { type: DataTypes.FLOAT, allowNull: true },
    temperature:      { type: DataTypes.FLOAT, allowNull: true },
    voltage:          { type: DataTypes.FLOAT, allowNull: true },
    rx_mbps:          { type: DataTypes.FLOAT, allowNull: true },
    tx_mbps:          { type: DataTypes.FLOAT, allowNull: true },
    iface_errors:     { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    iface_drops:      { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    iface_down:       { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    details:          { type: DataTypes.JSON, allowNull: true },
    alerts:           { type: DataTypes.JSON, allowNull: true },
    polled_at:        { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'network_health_snapshots',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['device_id'] },
      { fields: ['status'] },
      { fields: ['polled_at'] },
    ],
  });
};
