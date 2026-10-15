'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

const SQL_DIR = path.resolve(__dirname, '../../sql');
const FILES = ['01_schema.sql', '02_views.sql'];

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4`
  );
  await conn.query(`USE \`${config.db.database}\``);

  for (const file of FILES) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`Applying ${file}...`);
    await conn.query(sql);
  }

  await conn.end();
  // eslint-disable-next-line no-console
  console.log('Migration complete.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err.message);
  process.exit(1);
});
