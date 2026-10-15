'use strict';

/**
 * Safe rounding to 2 decimals.
 *
 * The naive `Math.round(n * 100) / 100` produces values like
 * 0.30000000000000004 because binary floating point cannot represent most
 * decimal fractions exactly. We avoid the intermediate rounding error by
 * shifting the decimal point through a *string* (`n + 'e2'`), which is parsed
 * directly into the correctly-rounded binary double, then shifting back.
 *
 * Non-finite / non-numeric values are returned untouched so callers can decide
 * what to do with nulls and NaN.
 */
function round2(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (Number.isInteger(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const shifted = Number(Math.abs(value) + 'e2');
  return sign * Number(Math.round(shifted) + 'e-2');
}

/**
 * Round every numeric leaf in an object/array (one level deep is enough for a
 * record made of scalars, but we recurse for safety).
 */
function roundDeep(value) {
  if (typeof value === 'number') return round2(value);
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = roundDeep(value[key]);
    return out;
  }
  return value;
}

module.exports = { round2, roundDeep };
