'use strict';

/**
 * All reads for formulas. Writes go exclusively through saveRecord().
 * Everything that means "the formula as it is now" reads from the current-view
 * so callers never deal with versions.
 */
function createFormulaRepository(pool) {
  async function getCurrentByUuid(uuid) {
    const [rows] = await pool.query(
      'SELECT * FROM view_formula_current WHERE uuid = ? LIMIT 1',
      [uuid]
    );
    return rows[0] || null;
  }

  async function getCurrentAll({ status = null } = {}) {
    if (status) {
      const [rows] = await pool.query(
        'SELECT * FROM view_formula_current WHERE status = ? ORDER BY name ASC',
        [status]
      );
      return rows;
    }
    const [rows] = await pool.query(
      'SELECT * FROM view_formula_current ORDER BY name ASC'
    );
    return rows;
  }

  async function getByUuids(uuids) {
    if (!uuids || !uuids.length) return [];
    const placeholders = uuids.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT * FROM view_formula_current WHERE uuid IN (${placeholders})`,
      uuids
    );
    return rows;
  }

  async function getHistory(uuid) {
    const [rows] = await pool.query(
      'SELECT * FROM formula WHERE uuid = ? ORDER BY version ASC',
      [uuid]
    );
    return rows;
  }

  async function getVersion(uuid, version) {
    const [rows] = await pool.query(
      'SELECT * FROM formula WHERE uuid = ? AND version = ? LIMIT 1',
      [uuid, version]
    );
    return rows[0] || null;
  }

  async function getActiveAsOf(asOf) {
    const [rows] = await pool.query(
      `SELECT f.*
         FROM formula f
         JOIN (
           SELECT uuid, MAX(id) AS max_id
             FROM formula
            WHERE inserted_at <= ?
            GROUP BY uuid
         ) latest ON latest.uuid = f.uuid AND latest.max_id = f.id
        WHERE f.status = 'ACTIVE'
        ORDER BY f.name ASC`,
      [asOf]
    );
    return rows;
  }

  async function findActiveByName(name, exceptUuid = null) {
    const [rows] = await pool.query(
      `SELECT * FROM view_formula_current
        WHERE name = ? AND status = 'ACTIVE' AND uuid <> ? LIMIT 1`,
      [name, exceptUuid || '']
    );
    return rows[0] || null;
  }

  async function existsUuid(uuid) {
    const [rows] = await pool.query(
      'SELECT 1 FROM formula WHERE uuid = ? LIMIT 1',
      [uuid]
    );
    return rows.length > 0;
  }

  return {
    getCurrentByUuid,
    getCurrentAll,
    getByUuids,
    getHistory,
    getVersion,
    getActiveAsOf,
    findActiveByName,
    existsUuid,
  };
}

module.exports = { createFormulaRepository };
