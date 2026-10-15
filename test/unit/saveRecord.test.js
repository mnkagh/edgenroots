'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSaveRecord } = require('../../src/data/saveRecord');
const { createFakeDb, formulaSchema, runLogSchema } = require('../helpers/fakeDb');

function setup() {
  const db = createFakeDb({ formula: formulaSchema, formula_run_log: runLogSchema });
  const { saveRecord } = createSaveRecord(db);
  return { db, saveRecord };
}

test('create: generates a uuid, version 1 and first_created_at', async () => {
  const { saveRecord } = setup();
  const [row] = await saveRecord(
    'formula',
    { name: 'tax', formula: 'return EXTERNAL_VAR.amount * 0.18;', status: 'ACTIVE', created_by: 'admin' },
    { uuidColumn: 'uuid', immutableColumns: ['created_by', 'first_created_at'] }
  );

  assert.match(row.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(row.version, 1);
  assert.equal(row.id, 1);
  assert.ok(row.first_created_at instanceof Date);
});

test('change: inserts a new row, keeps creation details, merges unsent fields', async () => {
  const { saveRecord } = setup();
  const opts = { uuidColumn: 'uuid', immutableColumns: ['created_by', 'first_created_at'] };
  const [v1] = await saveRecord(
    'formula',
    { name: 'tax', formula: 'return EXTERNAL_VAR.commission * 0.18;', status: 'ACTIVE', created_by: 'admin' },
    opts
  );

  const [v2] = await saveRecord(
    'formula',
    { uuid: v1.uuid, version: v1.version + 1, formula: 'return EXTERNAL_VAR.commission * 0.12;' },
    opts
  );

  assert.notEqual(v2.id, v1.id); // a new physical row
  assert.equal(v2.uuid, v1.uuid); // same logical record
  assert.equal(v2.version, 2);
  assert.equal(v2.formula, 'return EXTERNAL_VAR.commission * 0.12;'); // changed
  assert.equal(v2.name, 'tax'); // unsent -> previous value
  assert.equal(v2.status, 'ACTIVE'); // unsent -> previous value
  assert.equal(v2.created_by, 'admin'); // immutable creation detail preserved
  assert.equal(v2.first_created_at, v1.first_created_at);
});

test('array insert uses a single INSERT statement with contiguous ids', async () => {
  const { db, saveRecord } = setup();
  const rows = await saveRecord(
    'formula_run_log',
    [
      { run_uuid: 'r1', formula_name: 'a', status: 'SUCCESS' },
      { run_uuid: 'r1', formula_name: 'b', status: 'FAILED' },
    ],
    { uuidColumn: 'uuid', versionColumn: '__none__', immutableColumns: [] }
  );

  const inserts = db.queryLog.filter((q) => /^INSERT/i.test(q.sql.trim()));
  assert.equal(inserts.length, 1);
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2]
  );
  assert.ok(rows.every((r) => r.uuid));
});

test('never issues UPDATE or DELETE', async () => {
  const { db, saveRecord } = setup();
  const opts = { uuidColumn: 'uuid', immutableColumns: ['created_by', 'first_created_at'] };
  const [v1] = await saveRecord('formula', { name: 'a', formula: 'return 1;', created_by: 'x' }, opts);
  await saveRecord('formula', { uuid: v1.uuid, version: 2, name: 'a2' }, opts);

  const writes = db.queryLog.filter((q) => /^(UPDATE|DELETE)/i.test(q.sql.trim()));
  assert.equal(writes.length, 0);
});

test('unique(uuid, version) makes a lost update impossible', async () => {
  const { saveRecord } = setup();
  const opts = { uuidColumn: 'uuid', immutableColumns: ['created_by', 'first_created_at'] };
  const [v1] = await saveRecord('formula', { name: 'tax', formula: 'return 1;', created_by: 'x' }, opts);

  // Two writers both based on v1 try to create v2.
  const first = saveRecord('formula', { uuid: v1.uuid, version: 2, formula: 'return 2;' }, opts);
  const second = saveRecord('formula', { uuid: v1.uuid, version: 2, formula: 'return 3;' }, opts);

  const results = await Promise.allSettled([first, second]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'ER_DUP_ENTRY');
});
