'use strict';

const AppError = require('../errors/AppError');
const { isValidName, extractRefs } = require('../lib/formulaText');
const {
  buildGraph,
  topoSort,
  transitiveDependents,
  formatCycle,
} = require('../lib/graph');
const { serializeFormula } = require('../lib/serialize');

/**
 * Everything an admin can do to formulas: create, change, deactivate, roll
 * back, plus the validation that guards every write.
 *
 * No method here writes directly: every mutation is delegated to saveRecord().
 */
function createFormulaService({ formulaRepo, saveRecord, interpreter }) {
  function assertValidName(name) {
    if (!isValidName(name)) {
      throw AppError.badRequest(
        `"${name}" is not a valid formula name. Use letters, digits and underscore, not starting with a digit.`,
        'INVALID_NAME'
      );
    }
  }

  function assertVersionMatches(suppliedVersion, current) {
    if (suppliedVersion === undefined || suppliedVersion === null) {
      throw AppError.badRequest(
        'The "version" you last saw is required when changing an existing formula.',
        'VERSION_REQUIRED'
      );
    }
    if (Number(suppliedVersion) !== Number(current.version)) {
      throw AppError.conflict(
        `Formula '${current.name}' has moved on: you based your change on version ${suppliedVersion} but the current version is ${current.version}.`,
        'VERSION_CONFLICT',
        { current: serializeFormula(current) }
      );
    }
  }

  async function assertNameUnique(name, exceptUuid) {
    const clash = await formulaRepo.findActiveByName(name, exceptUuid);
    if (clash) {
      throw AppError.badRequest(
        `An active formula named '${name}' already exists (uuid ${clash.uuid}).`,
        'NAME_TAKEN',
        { conflictingUuid: clash.uuid }
      );
    }
  }

  /**
   * Run the formula once against sample data so a syntax error can never be
   * saved. Referenced-but-unsupplied names default to 1 so dependency names
   * resolve; callers may pass explicit sampleData.
   *
   * A timeout during the sample run is deliberately NOT a save-time error: the
   * formula parsed and started executing, so it is valid data. Its non-
   * termination is handled at run time (FAILED at timeout + SKIPPED dependents).
   */
  async function assertRunnable(formulaText, sampleData) {
    const sample = { ...(sampleData || {}) };
    for (const ref of extractRefs(formulaText)) {
      if (!(ref in sample)) sample[ref] = 1;
    }
    const result = await interpreter.evaluateOne(formulaText, sample);
    if (result.status === 'SUCCESS') return;
    if (/timed out/i.test(result.error || '')) return;
    throw AppError.badRequest(
      `Formula failed to evaluate: ${result.error}`,
      'FORMULA_INVALID',
      { error: result.error }
    );
  }

  /**
   * Reject a save that would introduce a loop. The proposed formula is checked
   * against all other active formulas.
   */
  async function assertNoCycle({ uuid, name, formula }) {
    const active = await formulaRepo.getCurrentAll({ status: 'ACTIVE' });
    const list = active.filter((f) => f.uuid !== uuid);
    list.push({ uuid: uuid || '__new__', name, formula });
    const { deps } = buildGraph(list);
    const { cycle } = topoSort(deps);
    if (cycle) {
      throw AppError.badRequest(
        `This save would create a dependency loop: ${formatCycle(cycle)}`,
        'DEPENDENCY_CYCLE',
        { cycle }
      );
    }
  }

  /**
   * Every active formula that directly or indirectly depends on `uuid`.
   */
  async function impact(uuid) {
    const target = await formulaRepo.getCurrentByUuid(uuid);
    if (!target) throw AppError.notFound(`Formula ${uuid} not found`, 'FORMULA_NOT_FOUND');
    const active = await formulaRepo.getCurrentAll({ status: 'ACTIVE' });
    const graph = buildGraph(active);
    const names = new Set(transitiveDependents(graph, target.name));
    return active
      .filter((f) => names.has(f.name))
      .map(serializeFormula);
  }

  /**
   * Every formula write goes through here so a duplicate (uuid, version) - the
   * signature of a stale-writer race - becomes a clean 409 that carries the
   * current version, rather than a raw database error.
   */
  async function persist(data, uuid) {
    try {
      const [saved] = await saveRecord('formula', data, {
        uuidColumn: 'uuid',
        immutableColumns: ['created_by', 'first_created_at'],
      });
      return saved;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        const current = uuid ? await formulaRepo.getCurrentByUuid(uuid) : null;
        throw AppError.conflict(
          'Another change was saved first. Reload the latest version and retry.',
          'VERSION_CONFLICT',
          { current: serializeFormula(current) }
        );
      }
      throw err;
    }
  }

  async function list({ status } = {}) {
    const rows = await formulaRepo.getCurrentAll({ status: status || null });
    return rows.map(serializeFormula);
  }

  async function getByUuid(uuid) {
    const row = await formulaRepo.getCurrentByUuid(uuid);
    if (!row) throw AppError.notFound(`Formula ${uuid} not found`, 'FORMULA_NOT_FOUND');
    return serializeFormula(row);
  }

  async function history(uuid) {
    if (!(await formulaRepo.existsUuid(uuid))) {
      throw AppError.notFound(`Formula ${uuid} not found`, 'FORMULA_NOT_FOUND');
    }
    const rows = await formulaRepo.getHistory(uuid);
    return rows.map(serializeFormula);
  }

  async function createOrChange(input) {
    const { uuid, name, formula, createdBy, version, force, sampleData } = input;
    assertValidName(name);

    const existing = uuid ? await formulaRepo.getCurrentByUuid(uuid) : null;
    if (uuid && !existing) {
      throw AppError.notFound(`Formula ${uuid} not found`, 'FORMULA_NOT_FOUND');
    }
    if (existing) assertVersionMatches(version, existing);

    await assertNameUnique(name, uuid);

    // Renaming can orphan dependents that reference the old name.
    if (existing && existing.name !== name && !force) {
      const affected = await impact(uuid);
      if (affected.length) {
        throw AppError.badRequest(
          `Renaming '${existing.name}' to '${name}' would break: ${affected
            .map((f) => f.name)
            .join(', ')}. Send force=true to override.`,
          'DEPENDENTS_EXIST',
          { impacted: affected }
        );
      }
    }

    await assertRunnable(formula, sampleData);
    await assertNoCycle({ uuid, name, formula });

    const data = {
      uuid: existing ? uuid : undefined,
      version: existing ? existing.version + 1 : 1,
      name,
      formula,
      status: 'ACTIVE',
      created_by: createdBy,
      updated_by: createdBy,
    };
    if (input.description !== undefined) data.description = input.description;

    const saved = await persist(data, existing ? uuid : null);
    return serializeFormula(saved);
  }

  async function deactivate(uuid, { version, force, createdBy } = {}) {
    const existing = await formulaRepo.getCurrentByUuid(uuid);
    if (!existing) throw AppError.notFound(`Formula ${uuid} not found`, 'FORMULA_NOT_FOUND');
    if (existing.status === 'INACTIVE') {
      throw AppError.badRequest(`Formula '${existing.name}' is already inactive.`, 'ALREADY_INACTIVE');
    }
    assertVersionMatches(version, existing);

    const affected = await impact(uuid);
    if (affected.length && !force) {
      throw AppError.badRequest(
        `Deactivating '${existing.name}' would break: ${affected
          .map((f) => f.name)
          .join(', ')}. Send force=true to override.`,
        'DEPENDENTS_EXIST',
        { impacted: affected }
      );
    }

    const saved = await persist(
      { uuid, version: existing.version + 1, status: 'INACTIVE', updated_by: createdBy },
      uuid
    );
    return serializeFormula(saved);
  }

  async function rollback(uuid, { toVersion, version, force, createdBy } = {}) {
    const existing = await formulaRepo.getCurrentByUuid(uuid);
    if (!existing) throw AppError.notFound(`Formula ${uuid} not found`, 'FORMULA_NOT_FOUND');
    assertVersionMatches(version, existing);

    if (toVersion === undefined || toVersion === null) {
      throw AppError.badRequest('"toVersion" is required.', 'TO_VERSION_REQUIRED');
    }
    const target = await formulaRepo.getVersion(uuid, toVersion);
    if (!target) {
      throw AppError.notFound(
        `Version ${toVersion} of formula ${uuid} not found`,
        'VERSION_NOT_FOUND'
      );
    }

    const nameChanges = target.name !== existing.name;
    const becomesInactive = target.status === 'INACTIVE';

    if (target.status === 'ACTIVE') {
      await assertNameUnique(target.name, uuid);
    }

    if ((nameChanges || becomesInactive) && !force) {
      const affected = await impact(uuid);
      if (affected.length) {
        throw AppError.badRequest(
          `Rolling back '${existing.name}' to version ${toVersion} would break: ${affected
            .map((f) => f.name)
            .join(', ')}. Send force=true to override.`,
          'DEPENDENTS_EXIST',
          { impacted: affected }
        );
      }
    }

    await assertRunnable(target.formula);
    if (target.status === 'ACTIVE') {
      await assertNoCycle({ uuid, name: target.name, formula: target.formula });
    }

    const saved = await persist(
      {
        uuid,
        version: existing.version + 1,
        name: target.name,
        formula: target.formula,
        status: target.status,
        description: target.description,
        updated_by: createdBy,
      },
      uuid
    );
    return serializeFormula(saved);
  }

  return {
    list,
    getByUuid,
    history,
    impact,
    createOrChange,
    deactivate,
    rollback,
    // exposed for reuse/tests
    assertRunnable,
    assertNoCycle,
  };
}

module.exports = { createFormulaService };
