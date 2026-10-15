'use strict';

const express = require('express');
const { buildContainer } = require('./container');
const { createFormulaRoutes } = require('./routes/formulaRoutes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

function createApp({ pool, config, interpretorFn }) {
  const container = buildContainer({ pool, config, interpretorFn });

  const app = express();
  app.locals.services = container;
  app.locals.config = config;

  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (req, res) => res.json({ data: { status: 'ok' } }));
  app.use('/formulas', createFormulaRoutes(config));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
