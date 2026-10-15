'use strict';

require('dotenv').config();

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: int(process.env.PORT, 3000),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'edgenroots',
  },
  formula: {
    timeoutMs: int(process.env.FORMULA_TIMEOUT_MS, 3000),
    memoryMB: int(process.env.FORMULA_MEMORY_MB, 64),
  },
  preview: {
    concurrency: int(process.env.PREVIEW_CONCURRENCY, 8),
    bulkConcurrency: int(process.env.BULK_CONCURRENCY, 8),
    bulkMaxRecords: int(process.env.BULK_MAX_RECORDS, 500),
  },
};

module.exports = config;
