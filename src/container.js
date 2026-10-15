'use strict';

const { createSaveRecord } = require('./data/saveRecord');
const { createFormulaRepository } = require('./data/formulaRepository');
const { createRunLogRepository } = require('./data/runLogRepository');
const { createInterpreter } = require('./lib/interpreter');
const { createFormulaService } = require('./services/formulaService');
const { createPreviewService } = require('./services/previewService');

/**
 * Wire the application's dependencies. Everything is constructor-injected so
 * tests can swap the pool or the interpreter for fakes.
 */
function buildContainer({ pool, config, interpretorFn }) {
  const saveRecord = createSaveRecord(pool);
  const formulaRepo = createFormulaRepository(pool);
  const runLogRepo = createRunLogRepository(saveRecord);
  const interpreter = createInterpreter({
    timeoutMs: config.formula.timeoutMs,
    memoryMB: config.formula.memoryMB,
    interpretorFn,
  });
  const formulaService = createFormulaService({ formulaRepo, saveRecord, interpreter });
  const previewService = createPreviewService({ formulaRepo, runLogRepo, interpreter, config });

  return { saveRecord, formulaRepo, runLogRepo, interpreter, formulaService, previewService };
}

module.exports = { buildContainer };
