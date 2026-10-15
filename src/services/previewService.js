'use strict';

const { randomUUID } = require('crypto');
const AppError = require('../errors/AppError');
const {
  buildGraph,
  findMissingInputs,
  topoSort,
  formatCycle,
} = require('../lib/graph');
const { mapLimit } = require('../lib/concurrency');

/**
 * Preview: evaluate formulas for one record, or for many records in bulk, and
 * explain every number.
 *
 * Single preview evaluates one formula at a time in an isolated process so the
 * interpreter can return its calculation text.
 *
 * Bulk preview evaluates one formula across ALL records in a single isolated
 * process (the formula is compiled into a map over the records). 500 records x
 * 10 formulas therefore costs 10 processes instead of 5000 and finishes in a
 * couple of seconds.
 */
function createPreviewService({ formulaRepo, runLogRepo, interpreter, config }) {
  const concurrency = (config && config.preview && config.preview.concurrency) || 8;
  const bulkConcurrency = (config && config.preview && config.preview.bulkConcurrency) || 8;
  const bulkMaxRecords = (config && config.preview && config.preview.bulkMaxRecords) || 500;

  async function resolveFormulas({ formulaUuids, asOf }) {
    if (asOf) {
      const formulas = await formulaRepo.getActiveAsOf(new Date(asOf));
      if (formulaUuids && formulaUuids.length) {
        const wanted = new Set(formulaUuids);
        return formulas.filter((f) => wanted.has(f.uuid));
      }
      return formulas;
    }
    if (formulaUuids && formulaUuids.length) {
      const rows = await formulaRepo.getByUuids(formulaUuids);
      const active = rows.filter((f) => f.status === 'ACTIVE');
      const found = new Set(active.map((f) => f.uuid));
      const missing = formulaUuids.filter((u) => !found.has(u));
      if (missing.length) {
        throw AppError.notFound(
          `Unknown or inactive formula(s): ${missing.join(', ')}`,
          'FORMULA_NOT_FOUND',
          { missing }
        );
      }
      return active;
    }
    return formulaRepo.getCurrentAll({ status: 'ACTIVE' });
  }

  function plan(formulas, recordFields) {
    const missing = findMissingInputs(formulas, recordFields);
    if (missing.length) {
      throw AppError.badRequest(
        `Missing input(s) that are neither a formula nor a record field: ${missing
          .map((m) => m.name)
          .join(', ')}`,
        'MISSING_INPUT',
        { missing }
      );
    }
    const graph = buildGraph(formulas);
    const { levels, cycle } = topoSort(graph.deps);
    if (cycle) {
      throw AppError.badRequest(
        `Dependency loop detected: ${formatCycle(cycle)}`,
        'DEPENDENCY_CYCLE',
        { cycle }
      );
    }
    return { graph, levels };
  }

  function calculationText(calculation) {
    if (!calculation || !calculation.steps) return null;
    return calculation.steps.join('\n');
  }

  // -------------------------------------------------------------------------
  // Single record
  // -------------------------------------------------------------------------
  async function preview({ record, formulaUuids, asOf }) {
    const formulas = await resolveFormulas({ formulaUuids, asOf });
    const { graph, levels } = plan(formulas, Object.keys(record || {}));

    const runId = randomUUID();
    const env = { ...(record || {}) };
    const statusByName = new Map();
    const results = [];
    const logs = [];
    const order = [];

    for (const level of levels) {
      const evaluated = await mapLimit(level, concurrency, async (name) => {
        const f = graph.byName.get(name);
        const deps = [...graph.deps.get(name)];
        const failedDep = deps.find(
          (d) => statusByName.get(d) && statusByName.get(d) !== 'SUCCESS'
        );
        if (failedDep) {
          return {
            f,
            status: 'SKIPPED',
            result: null,
            error: `Dependency '${failedDep}' did not succeed`,
            calculation: null,
            durationMs: 0,
            input: { ...env },
          };
        }
        const t0 = Date.now();
        const res = await interpreter.evaluateOne(f.formula, env);
        return {
          f,
          status: res.status,
          result: res.status === 'SUCCESS' ? res.result : null,
          error: res.error || null,
          calculation: res.calculation || null,
          durationMs: Date.now() - t0,
          input: { ...env },
        };
      });

      for (const e of evaluated) {
        statusByName.set(e.f.name, e.status);
        order.push(e.f.name);
        if (e.status === 'SUCCESS') env[e.f.name] = e.result;

        results.push({
          name: e.f.name,
          uuid: e.f.uuid,
          version: e.f.version,
          status: e.status,
          result: e.status === 'SUCCESS' ? e.result : null,
          error: e.error,
          calculation: e.calculation,
          durationMs: e.durationMs,
        });

        logs.push({
          uuid: randomUUID(),
          run_uuid: runId,
          record_index: null,
          formula_uuid: e.f.uuid,
          formula_name: e.f.name,
          formula_version: e.f.version,
          input: e.input,
          result: e.status === 'SUCCESS' ? e.result : null,
          calculation: calculationText(e.calculation),
          status: e.status,
          error: e.error,
          duration_ms: e.durationMs,
          as_of: asOf ? new Date(asOf) : null,
        });
      }
    }

    await runLogRepo.insertMany(logs);

    return { runId, order, results, record: env };
  }

  // -------------------------------------------------------------------------
  // Many records
  // -------------------------------------------------------------------------
  async function previewBulk({ records, formulaUuids, asOf }) {
    const list = records || [];
    if (list.length > bulkMaxRecords) {
      throw AppError.badRequest(
        `Bulk preview accepts at most ${bulkMaxRecords} records per request (received ${list.length}).`,
        'TOO_MANY_RECORDS',
        { max: bulkMaxRecords }
      );
    }

    const startedAt = Date.now();
    const formulas = await resolveFormulas({ formulaUuids, asOf });
    const unionFields = new Set();
    for (const rec of list) for (const key of Object.keys(rec || {})) unionFields.add(key);
    const { graph, levels } = plan(formulas, [...unionFields]);

    const runId = randomUUID();
    const rows = list.map((r) => ({ ...(r || {}) }));
    const statusByRecord = list.map(() => ({}));
    const errorByRecord = list.map(() => ({}));
    const durationByName = new Map();
    const batchDurations = [];

    for (const level of levels) {
      await mapLimit(level, bulkConcurrency, async (name) => {
        const f = graph.byName.get(name);
        const deps = [...graph.deps.get(name)];

        const eligible = [];
        for (let i = 0; i < rows.length; i += 1) {
          const failedDep = deps.find(
            (d) => statusByRecord[i][d] && statusByRecord[i][d] !== 'SUCCESS'
          );
          if (failedDep) {
            statusByRecord[i][name] = 'SKIPPED';
            errorByRecord[i][name] = `Dependency '${failedDep}' did not succeed`;
          } else {
            eligible.push(i);
          }
        }
        if (!eligible.length) return;

        const t0 = Date.now();
        const batchResults = await interpreter.evaluateBatch(
          f.formula,
          eligible.map((i) => rows[i])
        );
        const durationMs = Date.now() - t0;
        batchDurations.push(durationMs);
        durationByName.set(name, durationMs);

        eligible.forEach((recordIndex, idx) => {
          const res = batchResults[idx] || { status: 'FAILED', error: 'No result' };
          statusByRecord[recordIndex][name] = res.status;
          if (res.status === 'SUCCESS') {
            rows[recordIndex][name] = res.result;
          } else {
            errorByRecord[recordIndex][name] = res.error || 'Evaluation failed';
          }
        });
      });
    }

    const totalMs = Date.now() - startedAt;

    // One run-log row per (record, formula), written in a single insert.
    const logs = [];
    for (let i = 0; i < rows.length; i += 1) {
      for (const f of formulas) {
        const status = statusByRecord[i][f.name] || 'SKIPPED';
        logs.push({
          uuid: randomUUID(),
          run_uuid: runId,
          record_index: i,
          formula_uuid: f.uuid,
          formula_name: f.name,
          formula_version: f.version,
          input: list[i] || {},
          result: status === 'SUCCESS' ? rows[i][f.name] ?? null : null,
          calculation: null,
          status,
          error: errorByRecord[i][f.name] || null,
          duration_ms: durationByName.get(f.name) ?? null,
          as_of: asOf ? new Date(asOf) : null,
        });
      }
    }
    await runLogRepo.insertMany(logs);

    let failures = 0;
    let skipped = 0;
    let succeeded = 0;
    for (const perRecord of statusByRecord) {
      for (const f of formulas) {
        const status = perRecord[f.name];
        if (status === 'FAILED') failures += 1;
        else if (status === 'SKIPPED') skipped += 1;
        else if (status === 'SUCCESS') succeeded += 1;
      }
    }

    const results = rows.map((row, index) => ({
      index,
      record: row,
      results: formulas.map((f) => ({
        name: f.name,
        uuid: f.uuid,
        version: f.version,
        status: statusByRecord[index][f.name] || 'SKIPPED',
        result: statusByRecord[index][f.name] === 'SUCCESS' ? row[f.name] ?? null : null,
        error: errorByRecord[index][f.name] || null,
      })),
    }));

    return {
      runId,
      order: levels.flat(),
      summary: {
        records: rows.length,
        formulas: formulas.length,
        evaluations: rows.length * formulas.length,
        totalMs,
        avgMsPerRecord: rows.length ? Number((totalMs / rows.length).toFixed(3)) : 0,
        succeeded,
        failures,
        skipped,
      },
      results,
    };
  }

  return { preview, previewBulk };
}

module.exports = { createPreviewService };
