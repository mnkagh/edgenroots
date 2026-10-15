'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidName,
  extractRefs,
  normalizeExternalVars,
  compileBatch,
} = require('../../src/lib/formulaText');

test('isValidName accepts identifiers and rejects the rest', () => {
  assert.ok(isValidName('tax'));
  assert.ok(isValidName('_private'));
  assert.ok(isValidName('t1'));
  assert.ok(isValidName('$x'));
  assert.ok(!isValidName('1tax'));
  assert.ok(!isValidName('has space'));
  assert.ok(!isValidName('a-b'));
  assert.ok(!isValidName(''));
  assert.ok(!isValidName(null));
});

test('extractRefs finds plain, chained and optional refs once each', () => {
  const refs = extractRefs(
    'const x = EXTERNAL_VAR.amount + EXTERNAL_VAR.rate; return EXTERNAL_VAR.amount + EXTERNAL_VAR?.tax + EXTERNAL_VAR.CODE.fee;'
  ).sort();
  assert.deepEqual(refs, ['amount', 'fee', 'rate', 'tax']);
});

test('extractRefs never reports CODE itself', () => {
  assert.deepEqual(extractRefs('return EXTERNAL_VAR.CODE;'), []);
  assert.deepEqual(extractRefs('return EXTERNAL_VAR.CODE.amount;'), ['amount']);
});

test('normalizeExternalVars is idempotent and preserves CODE', () => {
  assert.equal(
    normalizeExternalVars('return EXTERNAL_VAR.amount + EXTERNAL_VAR.CODE.rate;'),
    'return EXTERNAL_VAR.CODE.amount + EXTERNAL_VAR.CODE.rate;'
  );
  assert.equal(
    normalizeExternalVars('return EXTERNAL_VAR?.amount;'),
    'return EXTERNAL_VAR.CODE.amount;'
  );
});

test('compileBatch maps over rows with __row access', () => {
  const out = compileBatch('return EXTERNAL_VAR.amount * 2;', [{ amount: 1 }]);
  assert.match(out, /^return \(\[\{"amount":1\}\]\)\.map\(function\(__row\)\{ /);
  assert.match(out, /__row\.amount \* 2/);
});
