'use strict';

const { interpretor } = require('formula-interpreter');
const { normalizeExternalVars, compileBatch } = require('./formulaText');
const { roundDeep, round2 } = require('./round');

/**
 * Thin, well-tested wrapper around `formula-interpreter`.
 *
 * Responsibilities:
 *  - normalise `EXTERNAL_VAR.x` to the `.CODE.` form the library expects;
 *  - pass a timeout and memory cap (every formula runs in its own process);
 *  - turn the library's free-text `calculation` blob into structured steps.
 *
 * The library never rejects: it resolves with { status: 1, data, calculation }
 * on success or { status: 0, error } on failure/timeout. We keep that shape and
 * add structured `steps`.
 */
function createInterpreter(options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const memoryMB = options.memoryMB || 64;
  const run = options.interpretorFn || interpretor;

  /**
   * Evaluate one formula against one record. Returns
   * `{ status, result, raw, error, calculation }`.
   */
  async function evaluateOne(formulaText, record) {
    const normalized = normalizeExternalVars(formulaText);
    let response;
    try {
      response = await run(normalized, [], { CODE: record || {} }, {
        timeout: timeoutMs,
        memoryInMB: memoryMB,
      });
    } catch (err) {
      return { status: 'FAILED', error: err.message, raw: null };
    }

    if (!response || response.status !== 1) {
      return {
        status: 'FAILED',
        error: (response && response.error) || 'Formula evaluation failed',
        raw: response || null,
      };
    }

    const parsed = parseCalculation(response.calculation);
    return {
      status: 'SUCCESS',
      result: roundDeep(response.data),
      raw: response.data,
      calculation: parsed,
    };
  }

  /**
   * Evaluate one formula against many records in a single isolated process.
   * Returns an array of per-row `{ status, result, error }`.
   */
  async function evaluateBatch(formulaText, rows) {
    const batchFormula = compileBatch(formulaText, rows);
    let response;
    try {
      response = await run(batchFormula, [], {}, {
        timeout: timeoutMs,
        memoryInMB: memoryMB,
      });
    } catch (err) {
      return rows.map(() => ({ status: 'FAILED', error: err.message }));
    }

    if (!response || response.status !== 1 || !Array.isArray(response.data)) {
      const error = (response && response.error) || 'Formula evaluation failed';
      return rows.map(() => ({ status: 'FAILED', error }));
    }

    return response.data.map((value) => ({
      status: 'SUCCESS',
      result: roundDeep(value),
      raw: value,
    }));
  }

  return { evaluateOne, evaluateBatch, timeoutMs, memoryMB };
}

/**
 * Convert the interpreter's calculation text into structured steps.
 *
 * Example input:
 *   amount = 2000
 *   rate = 10
 *   return EXTERNAL_VAR.CODE.amount * EXTERNAL_VAR.CODE.rate / 100;
 *   = 2000 * 10 / 100;
 *   = 200
 */
function parseCalculation(calculation) {
  const text = typeof calculation === 'string' ? calculation : '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const inputs = {};
  const substitutes = [];
  let formulaLine = null;
  let resultLine = null;

  for (const line of lines) {
    if (line.startsWith('return ')) {
      if (formulaLine === null) formulaLine = line;
      continue;
    }
    if (line.startsWith('=')) {
      const value = line.replace(/^=+/, '').trim();
      substitutes.push(value);
      continue;
    }
    const inputMatch = line.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.*)$/);
    if (inputMatch) inputs[inputMatch[1]] = coerce(inputMatch[2]);
  }

  if (substitutes.length) resultLine = substitutes[substitutes.length - 1];

  return {
    inputs,
    formula: formulaLine,
    substituted: substitutes.slice(0, -1),
    result: resultLine,
    steps: lines,
  };
}

/**
 * The interpreter prints input values as text. Restore obvious numbers so the
 * explanation is machine-usable; everything else stays a string.
 */
function coerce(text) {
  if (text === 'undefined') return undefined;
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text !== '' && !Number.isNaN(Number(text))) {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  return text;
}

module.exports = { createInterpreter, parseCalculation, round2 };
