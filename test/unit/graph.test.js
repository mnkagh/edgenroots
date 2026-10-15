'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGraph,
  topoSort,
  findMissingInputs,
  transitiveDependents,
  formatCycle,
} = require('../../src/lib/graph');

const f = (name, formula) => ({ name, formula });

test('orders formulas so dependencies run first, regardless of input order', () => {
  const graph = buildGraph([
    f('total', 'return EXTERNAL_VAR.commission + EXTERNAL_VAR.tax;'),
    f('tax', 'return EXTERNAL_VAR.commission * 0.18;'),
    f('commission', 'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;'),
  ]);
  const { levels, cycle } = topoSort(graph.deps);
  assert.equal(cycle, null);
  assert.deepEqual(levels, [['commission'], ['tax'], ['total']]);
});

test('independent formulas land in the same level (parallelisable)', () => {
  const graph = buildGraph([f('a', 'return EXTERNAL_VAR.x;'), f('b', 'return EXTERNAL_VAR.y;')]);
  const { levels } = topoSort(graph.deps);
  assert.deepEqual(levels, [['a', 'b']]);
});

test('detects a cycle and returns the full path', () => {
  const graph = buildGraph([
    f('a', 'return EXTERNAL_VAR.b;'),
    f('b', 'return EXTERNAL_VAR.c;'),
    f('c', 'return EXTERNAL_VAR.a;'),
  ]);
  const { cycle } = topoSort(graph.deps);
  assert.ok(cycle);
  assert.equal(formatCycle(cycle), 'a → b → c → a');
});

test('detects a self reference as a loop', () => {
  const graph = buildGraph([f('a', 'return EXTERNAL_VAR.a + 1;')]);
  const { cycle } = topoSort(graph.deps);
  assert.equal(formatCycle(cycle), 'a → a');
});

test('reports missing inputs that are neither a formula nor a record field', () => {
  const formulas = [f('total', 'return EXTERNAL_VAR.commission + EXTERNAL_VAR.mystery;')];
  const missing = findMissingInputs(formulas, ['amount']);
  assert.deepEqual(missing, [
    { name: 'commission', formulas: ['total'] },
    { name: 'mystery', formulas: ['total'] },
  ]);
});

test('does not report a name provided by the record', () => {
  const formulas = [f('total', 'return EXTERNAL_VAR.commission;')];
  assert.deepEqual(findMissingInputs(formulas, ['commission']), []);
});

test('transitiveDependents walks the whole chain', () => {
  const graph = buildGraph([
    f('total', 'return EXTERNAL_VAR.tax;'),
    f('tax', 'return EXTERNAL_VAR.commission;'),
    f('commission', 'return EXTERNAL_VAR.amount;'),
  ]);
  assert.deepEqual(transitiveDependents(graph, 'commission').sort(), ['tax', 'total']);
});
