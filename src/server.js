'use strict';

const config = require('./config');
const { getPool, closePool } = require('./data/pool');
const { createApp } = require('./app');

const app = createApp({ pool: getPool(), config });

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Formula engine listening on http://localhost:${config.port}`);
});

async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received, shutting down...`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
