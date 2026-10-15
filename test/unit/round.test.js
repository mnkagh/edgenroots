'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { round2, roundDeep } = require('../../src/lib/round');

test('round2 kills floating point noise', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(0.30000000000000004), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(200 / 3), 66.67);
  assert.equal(round2(36), 36);
  assert.equal(round2(-0.005), -0.01);
});

test('round2 leaves non-numbers alone', () => {
  assert.equal(round2(null), null);
  assert.equal(round2(undefined), undefined);
  assert.equal(round2('x'), 'x');
  assert.ok(Number.isNaN(round2(NaN)));
  assert.equal(round2(Infinity), Infinity);
});

test('roundDeep rounds nested numeric leaves', () => {
  assert.deepEqual(
    roundDeep({ a: 0.1 + 0.2, b: [1 / 3, 'keep'] }),
    { a: 0.3, b: [0.33, 'keep'] }
  );
});
