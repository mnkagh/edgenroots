'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInterpreter, parseCalculation } = require('../../src/lib/interpreter');

const interpreter = createInterpreter({ timeoutMs: 2000, memoryMB: 64 });

test('evaluates a formula and splits the explanation into steps', async () => {
  const res = await interpreter.evaluateOne(
    'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;',
    { amount: 2000, rate: 10 }
  );
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.result, 200);
  assert.deepEqual(res.calculation.inputs, { amount: 2000, rate: 10 });
  assert.equal(res.calculation.result, '200');
  assert.match(res.calculation.formula, /return/);
});

test('rounds results so 0.1 + 0.2 is exactly 0.3', async () => {
  const res = await interpreter.evaluateOne('return EXTERNAL_VAR.a + EXTERNAL_VAR.b;', {
    a: 0.1,
    b: 0.2,
  });
  assert.equal(res.result, 0.3);
});

test('a syntax error is returned, not thrown', async () => {
  const res = await interpreter.evaluateOne('return EXTERNAL_VAR.a *;', { a: 1 });
  assert.equal(res.status, 'FAILED');
  assert.ok(res.error);
});

test('an infinite loop is stopped at the timeout and marked FAILED', async () => {
  const res = await interpreter.evaluateOne('while (true) {} return 1;', {});
  assert.equal(res.status, 'FAILED');
  assert.match(res.error, /Timed out/i);
});

test('batch evaluation returns one result per row in one process', async () => {
  const res = await interpreter.evaluateBatch('return EXTERNAL_VAR.amount * 2;', [
    { amount: 1 },
    { amount: 2 },
    { amount: 3 },
  ]);
  assert.deepEqual(
    res.map((r) => r.result),
    [2, 4, 6]
  );
});

test('parseCalculation understands the library output shape', () => {
  const parsed = parseCalculation(
    'amount = 2000\nrate = 10\nreturn EXTERNAL_VAR.CODE.amount * EXTERNAL_VAR.CODE.rate / 100;\n= 2000 * 10 / 100;\n= 200'
  );
  assert.deepEqual(parsed.inputs, { amount: 2000, rate: 10 });
  assert.deepEqual(parsed.substituted, ['2000 * 10 / 100;']);
  assert.equal(parsed.result, '200');
});
