'use strict';

const { randomUUID } = require('crypto');
const AppError = require('../errors/AppError');

/**
 * The one and only function that writes to a business table.
 *
 * Guarantees (assignment 5.2):
 *  1. No uuid in the data            -> generate one + stamp first_created_at.
 *  2. Uuid present                   -> read the current row, keep its original
 *                                       creation details, merge the new fields
 *                                       (unsent fields keep their old value).
 *  3. It ONLY ever INSERTs. Nothing in this file overwrites or removes rows.
 *  4. Every value is a bound parameter (never string-concatenated).
 *  5. Accepts one object or an array; an array is inserted in ONE statement.
 *  6. Table-agnostic: it reads the table's columns from information_schema, so
 *     it works for any table given the table name and its uuid column.
 *  7. Returns the saved rows including their `id` and `uuid`.
 *
 * Concurrency: when the table has a `version` column the caller may supply the
 * next version explicitly. A UNIQUE(uuid, version) index then makes a stale
 * writer impossible - the losing writer gets a duplicate-key error.
 */
function createSaveRecord(pool) {
  const columnCache = new Map();

  async function getColumns(conn, table) {
    if (columnCache.has(table)) return columnCache.get(table);
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    if (!rows.length) {
      throw AppError.badRequest(`Unknown table: ${table}`, 'UNKNOWN_TABLE');
    }
    const map = new Map();
    for (const r of rows) map.set(r.COLUMN_NAME, r);
    columnCache.set(table, map);
    return map;
  }

  function isAutoIncrement(columns, key) {
    const col = columns.get(key);
    return Boolean(col && col.EXTRA && col.EXTRA.includes('auto_increment'));
  }

  function sanitize(data, columns) {
    const out = {};
    for (const key of Object.keys(data)) {
      if (key === 'id') continue; // never write the surrogate key by hand
      if (!columns.has(key)) continue;
      if (isAutoIncrement(columns, key)) continue;
      const value = data[key];
      if (value === undefined) continue;
      const type = columns.get(key).DATA_TYPE;
      if (value instanceof Date) {
        out[key] = value;
      } else if (type === 'json' || (value !== null && typeof value === 'object')) {
        out[key] = JSON.stringify(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  function assertTableName(table) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) {
      throw AppError.badRequest(`Invalid table name: ${table}`, 'INVALID_TABLE');
    }
  }

  async function loadCurrent(conn, table, uuidColumn, uuid, idColumn) {
    const [rows] = await conn.query(
      `SELECT * FROM \`${table}\` WHERE \`${uuidColumn}\` = ? ORDER BY \`${idColumn}\` DESC LIMIT 1`,
      [uuid]
    );
    return rows[0] || null;
  }

  async function saveRecord(table, data, options = {}) {
    assertTableName(table);
    const {
      uuidColumn = 'uuid',
      idColumn = 'id',
      immutableColumns = ['created_by', 'created_at', 'first_created_at'],
      versionColumn = 'version',
      connection = null,
      now = () => new Date(),
    } = options;

    const list = Array.isArray(data) ? data : [data];
    if (!list.length) return [];

    const run = async (conn) => {
      const columns = await getColumns(conn, table);
      const statements = [];

      for (const record of list) {
        const input = sanitize(record, columns);
        const uuid = input[uuidColumn];

        if (uuid && columns.has(uuidColumn)) {
          const current = await loadCurrent(conn, table, uuidColumn, uuid, idColumn);
          if (current) {
            const merged = { ...current };
            // overlay the new values, then force immutable creation details back
            for (const key of Object.keys(input)) merged[key] = input[key];
            for (const im of immutableColumns) {
              if (current[im] !== undefined && current[im] !== null) merged[im] = current[im];
            }
            if (columns.has(versionColumn) && merged[versionColumn] == null && current[versionColumn] != null) {
              merged[versionColumn] = Number(current[versionColumn]) + 1;
            }
            statements.push(finalize(merged, columns, now, uuidColumn));
          } else {
            statements.push(
              finalize({ ...input, [uuidColumn]: uuid }, columns, now, uuidColumn)
            );
          }
        } else {
          const created = { ...input };
          if (columns.has(uuidColumn)) created[uuidColumn] = randomUUID();
          if (columns.has(versionColumn) && created[versionColumn] == null) created[versionColumn] = 1;
          if (columns.has('first_created_at') && created.first_created_at == null) {
            created.first_created_at = now();
          }
          statements.push(finalize(created, columns, now, uuidColumn));
        }
      }

      return insertMany(conn, table, statements);
    };

    if (connection) return run(connection);
    const conn = await pool.getConnection();
    try {
      return await run(conn);
    } finally {
      conn.release();
    }
  }

  function finalize(row, columns, now, uuidColumn) {
    const out = {};
    for (const key of Object.keys(row)) {
      if (!columns.has(key)) continue;
      if (key === uuidColumn) continue; // handled below
      if (key === 'id' || isAutoIncrement(columns, key)) continue;
      const value = row[key];
      if (value === undefined) continue;
      const type = columns.get(key).DATA_TYPE;
      if (value instanceof Date) out[key] = value;
      else if (type === 'json' || (value !== null && typeof value === 'object')) out[key] = JSON.stringify(value);
      else out[key] = value;
    }
    if (columns.has('inserted_at')) out.inserted_at = now();
    out[uuidColumn] = row[uuidColumn];
    return out;
  }

  async function insertMany(conn, table, rows) {
    const columnSet = new Set();
    for (const row of rows) for (const key of Object.keys(row)) columnSet.add(key);
    const cols = [...columnSet];

    const colSql = cols.map((c) => `\`${c}\``).join(', ');
    const rowSql = rows
      .map(() => `(${cols.map(() => '?').join(', ')})`)
      .join(', ');
    const values = [];
    for (const row of rows) {
      for (const col of cols) values.push(row[col] === undefined ? null : row[col]);
    }

    const [result] = await conn.query(
      `INSERT INTO \`${table}\` (${colSql}) VALUES ${rowSql}`,
      values
    );

    const firstId = result.insertId;
    return rows.map((row, index) => ({ ...row, id: firstId + index }));
  }

  return { saveRecord, clearCache: () => columnCache.clear() };
}

module.exports = { createSaveRecord };
