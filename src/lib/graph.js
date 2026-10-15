'use strict';

const { extractRefs } = require('./formulaText');

/**
 * Build the dependency graph for a set of formulas.
 *
 * Nodes are formula names. A directed edge name -> dep exists when a formula
 * reads `EXTERNAL_VAR.dep` and `dep` is the name of another formula in the set
 * (rather than a plain field of the input record).
 *
 * @returns {{
 *   byName: Map<string, object>,
 *   deps: Map<string, Set<string>>,   // node -> names it needs
 *   dependents: Map<string, Set<string>>, // node -> names that need it
 * }}
 */
function buildGraph(formulas) {
  const byName = new Map();
  for (const f of formulas) byName.set(f.name, f);

  const deps = new Map();
  const dependents = new Map();
  for (const f of formulas) {
    deps.set(f.name, new Set());
    if (!dependents.has(f.name)) dependents.set(f.name, new Set());
  }

  for (const f of formulas) {
    for (const ref of extractRefs(f.formula)) {
      if (byName.has(ref)) {
        // A formula reading itself is a (degenerate) loop and must be caught.
        deps.get(f.name).add(ref);
        if (ref !== f.name) {
          if (!dependents.has(ref)) dependents.set(ref, new Set());
          dependents.get(ref).add(f.name);
        }
      }
    }
  }

  return { byName, deps, dependents };
}

/**
 * Names that a formula reads but that are neither another formula nor a field
 * of the input record. Reported before anything runs.
 */
function findMissingInputs(formulas, recordFields) {
  const byName = new Set(formulas.map((f) => f.name));
  const fields = new Set(recordFields || []);
  const missing = new Map(); // name -> [formula names]
  for (const f of formulas) {
    for (const ref of extractRefs(f.formula)) {
      if (byName.has(ref) || fields.has(ref)) continue;
      if (!missing.has(ref)) missing.set(ref, []);
      missing.get(ref).push(f.name);
    }
  }
  return [...missing.entries()].map(([name, forms]) => ({ name, formulas: forms }));
}

/**
 * Kahn's algorithm producing parallel "levels". Every formula in a level only
 * depends on formulas in earlier levels, so a level can run concurrently.
 * Within a level names are sorted for deterministic output.
 *
 * If a cycle exists, `cycle` contains the full path (e.g. ['a','b','c','a']).
 */
function topoSort(deps) {
  const indegree = new Map();
  const dependents = new Map();
  for (const [node, set] of deps) {
    indegree.set(node, set.size);
    if (!dependents.has(node)) dependents.set(node, new Set());
  }
  for (const [node, set] of deps) {
    for (const dep of set) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep).add(node);
    }
  }

  let ready = [...deps.keys()].filter((n) => indegree.get(n) === 0).sort();
  const levels = [];
  let processed = 0;

  while (ready.length) {
    levels.push(ready);
    const next = [];
    for (const node of ready) {
      processed += 1;
      for (const dependent of dependents.get(node) || []) {
        indegree.set(dependent, indegree.get(dependent) - 1);
        if (indegree.get(dependent) === 0) next.push(dependent);
      }
    }
    ready = next.sort();
  }

  if (processed < deps.size) {
    return { levels, cycle: findCycle(deps, indegree) };
  }
  return { levels, cycle: null };
}

/**
 * Depth-first search over the sub-graph that still has incoming edges (i.e.
 * the part involved in / downstream of a cycle) and returns the first cycle as
 * a closed path.
 */
function findCycle(deps, indegree) {
  const ambiguous = new Set(
    [...deps.keys()].filter((n) => (indegree.get(n) || 0) > 0)
  );
  const state = new Map(); // 0 = unvisited, 1 = on stack, 2 = done
  const stack = [];

  function dfs(node) {
    state.set(node, 1);
    stack.push(node);
    for (const dep of deps.get(node) || []) {
      if (!ambiguous.has(dep)) continue;
      const s = state.get(dep) || 0;
      if (s === 1) {
        // Found a back edge: slice the path from the repeated node.
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (s === 0) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    state.set(node, 2);
    stack.pop();
    return null;
  }

  for (const node of ambiguous) {
    if ((state.get(node) || 0) === 0) {
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Every formula that directly or indirectly depends on `targetName`.
 */
function transitiveDependents(graph, targetName) {
  const { dependents } = graph;
  const seen = new Set();
  const queue = [...(dependents.get(targetName) || [])];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const next of dependents.get(name) || []) queue.push(next);
  }
  return [...seen];
}

function formatCycle(cycle) {
  return cycle ? cycle.join(' → ') : null;
}

module.exports = {
  buildGraph,
  findMissingInputs,
  topoSort,
  transitiveDependents,
  formatCycle,
};
