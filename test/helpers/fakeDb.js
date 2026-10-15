'use strict';

/**
 * Minimal in-memory stand-in for a mysql2 pool, good enough to unit-test
 * saveRecord() without a database. It understands exactly the statement shapes
 * saveRecord emits (information_schema lookup, current-row select, multi-row
 * insert) and enforces a UNIQUE(uuid, version) constraint like InnoDB would.
 */
function createFakeDb(schemaMap) {
  const tables = {};
  const nextId = {};
  const queryLog = [];

  function columnMeta(table) {
    return (schemaMap[table] || []).map((c) => ({
      COLUMN_NAME: c.name,
      DATA_TYPE: c.dataType || 'varchar',
      IS_NULLABLE: c.nullable === false ? 'NO' : 'YES',
      COLUMN_DEFAULT: c.default ?? null,
      EXTRA: c.extra || '',
    }));
  }

  async function query(sql, params = []) {
    queryLog.push({ sql, params });
    const s = sql.trim().replace(/\s+/g, ' ');
    let m;

    if (/FROM information_schema\.COLUMNS/i.test(s)) {
      return [columnMeta(params[0])];
    }

    m = s.match(/^SELECT \* FROM `(\w+)` WHERE `(\w+)` = \? ORDER BY `(\w+)` DESC LIMIT 1/i);
    if (m) {
      const [, table, uuidCol, idCol] = m;
      const rows = (tables[table] || []).filter((r) => r[uuidCol] === params[0]);
      rows.sort((a, b) => b[idCol] - a[idCol]);
      return [rows.slice(0, 1)];
    }

    m = s.match(/^INSERT INTO `(\w+)` \(([^)]*)\) VALUES /i);
    if (m) {
      const table = m[1];
      const cols = m[2].split(',').map((c) => c.trim().replace(/`/g, ''));
      const groups = params.length / cols.length;
      const inserted = [];
      tables[table] = tables[table] || [];
      nextId[table] = nextId[table] || 1;
      for (let g = 0; g < groups; g += 1) {
        const row = {};
        cols.forEach((c, i) => {
          row[c] = params[g * cols.length + i];
        });
        const dup = tables[table].some(
          (r) => r.uuid === row.uuid && r.version != null && r.version === row.version
        );
        if (dup) {
          const err = new Error('ER_DUP_ENTRY');
          err.code = 'ER_DUP_ENTRY';
          throw err;
        }
        row.id = nextId[table];
        nextId[table] += 1;
        tables[table].push(row);
        inserted.push(row);
      }
      return [{ insertId: inserted[0] ? inserted[0].id : 0, affectedRows: inserted.length, rows: inserted }];
    }

    throw new Error(`FakeDb cannot handle SQL: ${s.slice(0, 100)}`);
  }

  return {
    query,
    getConnection: async () => ({ query, release() {} }),
    tables,
    queryLog,
    seed(table, rows) {
      tables[table] = rows.map((r) => ({ ...r }));
      nextId[table] = Math.max(0, ...rows.map((r) => r.id || 0)) + 1;
    },
  };
}

const formulaSchema = [
  { name: 'id', dataType: 'bigint', extra: 'auto_increment' },
  { name: 'uuid', dataType: 'char' },
  { name: 'version', dataType: 'int' },
  { name: 'name', dataType: 'varchar' },
  { name: 'formula', dataType: 'text' },
  { name: 'status', dataType: 'varchar' },
  { name: 'description', dataType: 'varchar' },
  { name: 'created_by', dataType: 'varchar' },
  { name: 'updated_by', dataType: 'varchar' },
  { name: 'first_created_at', dataType: 'datetime' },
  { name: 'inserted_at', dataType: 'datetime' },
];

const runLogSchema = [
  { name: 'id', dataType: 'bigint', extra: 'auto_increment' },
  { name: 'uuid', dataType: 'char' },
  { name: 'run_uuid', dataType: 'char' },
  { name: 'record_index', dataType: 'int' },
  { name: 'formula_uuid', dataType: 'char' },
  { name: 'formula_name', dataType: 'varchar' },
  { name: 'formula_version', dataType: 'int' },
  { name: 'input', dataType: 'json' },
  { name: 'result', dataType: 'json' },
  { name: 'calculation', dataType: 'text' },
  { name: 'status', dataType: 'varchar' },
  { name: 'error', dataType: 'text' },
  { name: 'duration_ms', dataType: 'int' },
  { name: 'as_of', dataType: 'datetime' },
  { name: 'created_at', dataType: 'datetime' },
];

module.exports = { createFakeDb, formulaSchema, runLogSchema };
