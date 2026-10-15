'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInterpreter } = require('../../src/lib/interpreter');
const { createPreviewService } = require('../../src/services/previewService');

const config = { preview: { concurrency: 4, bulkConcurrency: 4, bulkMaxRecords: 500 } };

function makeRepo(formulas) {
  return {
    async getCurrentAll({ status } = {}) {
      return formulas.filter((f) => !status || f.status === status).map((f) => ({ ...f }));
    },
    async getByUuids(uuids) {
      return formulas.filter((f) => uuids.includes(f.uuid)).map((f) => ({ ...f }));
    },
    async getActiveAsOf() {
      return formulas.filter((f) => f.status === 'ACTIVE').map((f) => ({ ...f }));
    },
    async getCurrentByUuid(uuid) {
      const f = formulas.find((x) => x.uuid === uuid);
      return f ? { ...f } : null;
    },
  };
}

function makeRunLog() {
  return {
    rows: [],
    async insertMany(rows) {
      this.rows.push(...rows);
      return rows;
    },
  };
}

const workedExample = [
  { uuid: 'u-total', version: 1, name: 'total', formula: 'return EXTERNAL_VAR.commission + EXTERNAL_VAR.tax;', status: 'ACTIVE' },
  { uuid: 'u-tax', version: 1, name: 'tax', formula: 'return EXTERNAL_VAR.commission * 0.18;', status: 'ACTIVE' },
  { uuid: 'u-commission', version: 1, name: 'commission', formula: 'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;', status: 'ACTIVE' },
];

function build(formulas) {
  const interpreter = createInterpreter({ timeoutMs: 3000, memoryMB: 64 });
  const runLogRepo = makeRunLog();
  const service = createPreviewService({ formulaRepo: makeRepo(formulas), runLogRepo, interpreter, config });
  return { service, runLogRepo };
}

test('worked example: evaluates in dependency order and explains each number', async () => {
  const { service, runLogRepo } = build(workedExample);
  const out = await service.preview({ record: { amount: 2000, rate: 10 } });

  assert.deepEqual(out.order, ['commission', 'tax', 'total']);
  const byName = Object.fromEntries(out.results.map((r) => [r.name, r]));
  assert.equal(byName.commission.result, 200);
  assert.equal(byName.tax.result, 36);
  assert.equal(byName.total.result, 236);
  assert.equal(out.record.total, 236);

  // explanation is present and split into inputs / formula / substituted / result
  assert.deepEqual(byName.commission.calculation.inputs, { amount: 2000, rate: 10 });
  assert.equal(byName.commission.calculation.result, '200');

  // one run-log row per formula sharing one run id, written in one call
  assert.equal(runLogRepo.rows.length, 3);
  assert.equal(new Set(runLogRepo.rows.map((r) => r.run_uuid)).size, 1);
});

test('one failing formula marks dependents SKIPPED but lets others run', async () => {
  const formulas = [
    { uuid: 'u-loop', version: 1, name: 'loop', formula: 'while(true){} return 1;', status: 'ACTIVE' },
    { uuid: 'u-dep', version: 1, name: 'dep', formula: 'return EXTERNAL_VAR.loop + 1;', status: 'ACTIVE' },
    { uuid: 'u-indep', version: 1, name: 'indep', formula: 'return EXTERNAL_VAR.amount * 2;', status: 'ACTIVE' },
  ];
  const { service } = build(formulas);
  const out = await service.preview({ record: { amount: 10 } });
  const byName = Object.fromEntries(out.results.map((r) => [r.name, r]));

  assert.equal(byName.loop.status, 'FAILED');
  assert.equal(byName.dep.status, 'SKIPPED');
  assert.match(byName.dep.error, /loop/);
  assert.equal(byName.indep.status, 'SUCCESS');
  assert.equal(byName.indep.result, 20);
});

test('missing inputs are reported before anything runs', async () => {
  const formulas = [
    { uuid: 'u-x', version: 1, name: 'x', formula: 'return EXTERNAL_VAR.mystery + 1;', status: 'ACTIVE' },
  ];
  const { service, runLogRepo } = build(formulas);
  await assert.rejects(
    () => service.preview({ record: { amount: 1 } }),
    (err) => err.code === 'MISSING_INPUT'
  );
  assert.equal(runLogRepo.rows.length, 0);
});

test('bulk preview evaluates all records and summarises timing', async () => {
  const { service } = build(workedExample);
  const records = [
    { amount: 2000, rate: 10 },
    { amount: 1000, rate: 10 },
    { amount: 500, rate: 20 },
  ];
  const out = await service.previewBulk({ records });

  assert.equal(out.summary.records, 3);
  assert.equal(out.summary.formulas, 3);
  assert.equal(out.summary.failures, 0);
  assert.equal(out.summary.skipped, 0);
  assert.equal(out.summary.succeeded, 9);
  assert.ok(out.summary.totalMs >= 0);

  assert.equal(out.results[1].record.total, 118); // 100 + 18
  assert.equal(out.results[2].record.commission, 100); // 500*20/100
});

test('bulk preview rejects more than the cap', async () => {
  const { service } = build(workedExample);
  const records = Array.from({ length: 501 }, () => ({ amount: 1, rate: 1 }));
  await assert.rejects(
    () => service.previewBulk({ records }),
    (err) => err.code === 'TOO_MANY_RECORDS'
  );
});
