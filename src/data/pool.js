'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');

let pool = null;

/** Create a connection pool. Tests may pass overrides. */
function createPool(overrides = {}) {
  return mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: overrides.connectionLimit || 10,
    queueLimit: 0,
    // Multi-statement is only used by the migration runner.
    multipleStatements: Boolean(overrides.multipleStatements),
  });
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

function setPool(customPool) {
  pool = customPool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { createPool, getPool, setPool, closePool };
