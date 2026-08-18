'use strict';

const { DataTypes } = require('sequelize');

/**
 * Time-series ringkas (RTT / loss / CPU / traffic) untuk sparkline.
 * Dipangkas otomatis setelah 24 jam agar tidak memberatkan billing DB.
 */
module.exports = (sequelize) => {
  return sequelize.define('NetworkHealthSample', {
    id:          { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    device_id:   { type: DataTypes.INTEGER, allowNull: false },
    rtt_avg:     { type: DataTypes.FLOAT, allowNull: true },
    packet_loss: { type: DataTypes.FLOAT, allowNull: true },
    cpu:         { type: DataTypes.FLOAT, allowNull: true },
    ram:         { type: DataTypes.FLOAT, allowNull: true },
    rx_mbps:     { type: DataTypes.FLOAT, allowNull: true },
    tx_mbps:     { type: DataTypes.FLOAT, allowNull: true },
    sampled_at:  { type: DataTypes.DATE, allowNull: false },
  }, {
    tableName: 'network_health_samples',
    timestamps: false,
    indexes: [
      { fields: ['device_id', 'sampled_at'] },
      { fields: ['sampled_at'] },
    ],
  });
};
