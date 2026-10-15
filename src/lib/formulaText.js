'use strict';

/**
 * Utilities for reading and rewriting user-authored formula text.
 *
 * The formula-interpreter package expects inputs to live under
 * `EXTERNAL_VAR.CODE.<name>`, but the assignment's public contract (and the
 * natural way to write a rule) is `EXTERNAL_VAR.<name>`. We therefore accept
 * `EXTERNAL_VAR.<name>` and normalise it to `EXTERNAL_VAR.CODE.<name>` right
 * before evaluation. Any already-qualified `EXTERNAL_VAR.CODE.<name>` is left
 * alone (idempotent).
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// A reference is `EXTERNAL_VAR` followed by `.` or `?.`, an optional `CODE`
// segment, then the field name.
const REF_PATTERN =
  /EXTERNAL_VAR\s*(?:\?\.|\.)\s*(?:CODE\s*(?:\?\.|\.)\s*)?([A-Za-z_$][A-Za-z0-9_$]*)/g;

const NORMALIZE_PATTERN =
  /EXTERNAL_VAR\s*(?:\?\.|\.)\s*(?!CODE\b)([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
 * Valid result name: a JavaScript-style identifier.
 */
function isValidName(name) {
  return typeof name === 'string' && IDENTIFIER.test(name);
}

/**
 * Every distinct input name the formula reads, e.g. ['amount', 'rate'].
 * The `CODE` segment itself is never reported as a field.
 */
function extractRefs(formulaText) {
  const refs = new Set();
  if (typeof formulaText !== 'string') return [];
  const re = new RegExp(REF_PATTERN.source, 'g');
  let match;
  while ((match = re.exec(formulaText)) !== null) {
    if (match[1] !== 'CODE') refs.add(match[1]);
  }
  return [...refs];
}

/**
 * Rewrite `EXTERNAL_VAR.x` (and `EXTERNAL_VAR?.x`) to `EXTERNAL_VAR.CODE.x`.
 */
function normalizeExternalVars(formulaText) {
  if (typeof formulaText !== 'string') return formulaText;
  return formulaText.replace(NORMALIZE_PATTERN, 'EXTERNAL_VAR.CODE.$1');
}

/**
 * Turn a single-record formula into an expression that evaluates the *same*
 * rule over an array of rows in one interpreter call. Used by bulk preview so
 * that 500 records cost one isolated process instead of 500.
 *
 * `EXTERNAL_VAR.CODE.field` becomes `__row.field`; the whole body is wrapped in
 * a map. The rows are inlined as a JSON literal (rather than passed through
 * EXTERNAL_VAR) because the interpreter's calculation extractor blindly
 * substitutes top-level EXTERNAL_VAR keys into the return expression, which
 * would corrupt an array reference. With no top-level keys there is nothing to
 * corrupt and the evaluation is still fully isolated.
 */
function compileBatch(formulaText, rows) {
  const body = normalizeExternalVars(formulaText).replace(
    /EXTERNAL_VAR\.CODE\./g,
    '__row.'
  );
  const data = JSON.stringify(rows);
  return `return (${data}).map(function(__row){ ${body} });`;
}

module.exports = {
  isValidName,
  extractRefs,
  normalizeExternalVars,
  compileBatch,
};
