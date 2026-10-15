'use strict';

const express = require('express');
const { formulaController } = require('../controllers/formulaController');
const {
  createOrChangeSchema,
  deactivateSchema,
  rollbackSchema,
  previewSchema,
  buildBulkSchema,
  validate,
  validateUuidParam,
} = require('../validators');

function createFormulaRoutes(config) {
  const router = express.Router();
  const maxRecords = (config && config.preview && config.preview.bulkMaxRecords) || 500;

  router.post('/preview/bulk', validate(buildBulkSchema(maxRecords)), formulaController.previewBulk);
  router.post('/preview', validate(previewSchema), formulaController.preview);

  router.post('/', validate(createOrChangeSchema), formulaController.createOrChange);
  router.get('/', formulaController.list);

  router.get('/:uuid/history', validateUuidParam(), formulaController.history);
  router.get('/:uuid/impact', validateUuidParam(), formulaController.impact);
  router.post('/:uuid/deactivate', validateUuidParam(), validate(deactivateSchema), formulaController.deactivate);
  router.post('/:uuid/rollback', validateUuidParam(), validate(rollbackSchema), formulaController.rollback);
  router.get('/:uuid', validateUuidParam(), formulaController.getByUuid);

  return router;
}

module.exports = { createFormulaRoutes };
