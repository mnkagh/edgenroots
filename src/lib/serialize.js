'use strict';

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

/** DB row -> API shape for a formula. */
function serializeFormula(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    version: row.version,
    name: row.name,
    formula: row.formula,
    status: row.status,
    description: row.description,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    firstCreatedAt: toIso(row.first_created_at),
    insertedAt: toIso(row.inserted_at),
  };
}

module.exports = { serializeFormula, toIso };
