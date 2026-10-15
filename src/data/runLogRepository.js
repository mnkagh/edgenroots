'use strict';

/**
 * Run-log writes. Every preview produces one row per formula evaluated, all
 * sharing a run uuid. They are inserted through the same generic saveRecord()
 * (single multi-row INSERT).
 */
function createRunLogRepository(saveRecord) {
  async function insertMany(rows) {
    if (!rows.length) return [];
    return saveRecord('formula_run_log', rows, {
      uuidColumn: 'uuid',
      immutableColumns: [],
      versionColumn: '__none__',
    });
  }

  return { insertMany };
}

module.exports = { createRunLogRepository };
