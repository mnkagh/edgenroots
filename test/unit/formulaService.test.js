'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { createInterpreter } = require('../../src/lib/interpreter');
const { createFormulaService } = require('../../src/services/formulaService');

const interpreter = createInterpreter({ timeoutMs: 3000, memoryMB: 64 });

/** In-memory repo + saveRecord over the same state, mimicking insert-only. */
function makeEnv(initial = []) {
  const state = {
    formulas: initial.map((f, i) => ({
      id: i + 1,
      uuid: f.uuid || randomUUID(),
      version: 1,
      status: 'ACTIVE',
      created_by: 'seed',
      description: null,
      updated_by: null,
      first_created_at: new Date('2020-01-01T00:00:00Z'),
      inserted_at: new Date('2020-01-01T00:00:00Z'),
      ...f,
    })),
    nextId: initial.length + 1,
  };

  const repo = {
    async getCurrentAll({ status } = {}) {
      return state.formulas.filter((f) => !status || f.status === status).map((f) => ({ ...f }));
    },
    async getCurrentByUuid(uuid) {
      const f = state.formulas.find((x) => x.uuid === uuid);
      return f ? { ...f } : null;
    },
    async findActiveByName(name, exceptUuid) {
      const f = state.formulas.find(
        (x) => x.name === name && x.status === 'ACTIVE' && x.uuid !== (exceptUuid || '')
      );
      return f ? { ...f } : null;
    },
    async existsUuid(uuid) {
      return state.formulas.some((x) => x.uuid === uuid);
    },
    async getHistory(uuid) {
      return state.formulas.filter((x) => x.uuid === uuid).map((x) => ({ ...x }));
    },
    async getVersion(uuid, version) {
      const f = state.formulas.find((x) => x.uuid === uuid && x.version === version);
      return f ? { ...f } : null;
    },
  };

  async function saveRecord(table, data) {
    const uuid = data.uuid || randomUUID();
    const existing = state.formulas.find((f) => f.uuid === uuid);
    const defined = {};
    for (const [k, v] of Object.entries(data)) if (v !== undefined) defined[k] = v;

    const merged = existing
      ? { ...existing, ...defined, created_by: existing.created_by, first_created_at: existing.first_created_at }
      : { status: 'ACTIVE', ...defined, uuid };

    merged.uuid = uuid;
    merged.id = state.nextId++;
    merged.inserted_at = new Date();
    state.formulas = state.formulas.filter((f) => f.uuid !== uuid);
    state.formulas.push(merged);
    return [merged];
  }

  const service = createFormulaService({ formulaRepo: repo, saveRecord, interpreter });
  return { service, state };
}

test('create: saves a valid formula at version 1', async () => {
  const { service } = makeEnv();
  const saved = await service.createOrChange({
    name: 'commission',
    formula: 'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;',
    createdBy: 'admin',
  });
  assert.equal(saved.version, 1);
  assert.equal(saved.status, 'ACTIVE');
  assert.equal(saved.name, 'commission');
});

test('rejects invalid identifiers, duplicate names and syntax errors', async () => {
  const { service } = makeEnv([{ name: 'tax', formula: 'return 1;' }]);

  await assert.rejects(
    () => service.createOrChange({ name: '1bad', formula: 'return 1;', createdBy: 'a' }),
    (e) => e.code === 'INVALID_NAME'
  );
  await assert.rejects(
    () => service.createOrChange({ name: 'tax', formula: 'return 1;', createdBy: 'a' }),
    (e) => e.code === 'NAME_TAKEN'
  );
  await assert.rejects(
    () => service.createOrChange({ name: 'broken', formula: 'return EXTERNAL_VAR.x *;', createdBy: 'a' }),
    (e) => e.code === 'FORMULA_INVALID'
  );
});

test('change requires a version and rejects a stale one with 409', async () => {
  const { service } = makeEnv([{ name: 'tax', formula: 'return EXTERNAL_VAR.c * 0.18;' }]);
  const uuid = (await service.list())[0].uuid;

  await assert.rejects(
    () => service.createOrChange({ uuid, name: 'tax', formula: 'return EXTERNAL_VAR.c * 0.12;' }),
    (e) => e.code === 'VERSION_REQUIRED'
  );
  await assert.rejects(
    () => service.createOrChange({ uuid, name: 'tax', formula: 'return EXTERNAL_VAR.c * 0.12;', version: 99 }),
    (e) => e.code === 'VERSION_CONFLICT'
  );
});

test('a save that would create a loop is rejected with the full path', async () => {
  const { service } = makeEnv();
  await service.createOrChange({ name: 'a', formula: 'return EXTERNAL_VAR.b + 1;', createdBy: 'x' });
  await assert.rejects(
    () => service.createOrChange({ name: 'b', formula: 'return EXTERNAL_VAR.a + 1;', createdBy: 'x' }),
    (e) => e.code === 'DEPENDENCY_CYCLE' && /a → b → a/.test(e.message)
  );
});

test('deactivating a formula with dependents needs force', async () => {
  const { service } = makeEnv();
  const total = await service.createOrChange({
    name: 'total',
    formula: 'return EXTERNAL_VAR.tax + 1;',
    createdBy: 'x',
  });
  const tax = await service.createOrChange({ name: 'tax', formula: 'return 5;', createdBy: 'x' });

  await assert.rejects(
    () => service.deactivate(tax.uuid, { version: 1 }),
    (e) => e.code === 'DEPENDENTS_EXIST' && e.details.impacted.some((f) => f.name === 'total')
  );

  const forced = await service.deactivate(tax.uuid, { version: 1, force: true });
  assert.equal(forced.status, 'INACTIVE');
  assert.equal(forced.version, 2);
  assert.ok(total.uuid);
});

test('impact returns direct and indirect dependents', async () => {
  const { service } = makeEnv();
  await service.createOrChange({ name: 'total', formula: 'return EXTERNAL_VAR.tax;', createdBy: 'x' });
  await service.createOrChange({ name: 'tax', formula: 'return EXTERNAL_VAR.commission;', createdBy: 'x' });
  const commission = await service.createOrChange({ name: 'commission', formula: 'return 1;', createdBy: 'x' });

  const impacted = await service.impact(commission.uuid);
  assert.deepEqual(impacted.map((f) => f.name).sort(), ['tax', 'total']);
});
