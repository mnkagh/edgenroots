-- ============================================================================
-- Edgenroots Formula Engine - Current-formula views
-- ============================================================================
-- Both views expose exactly the same thing: for every logical formula (uuid)
-- the single row with the highest id (its current version). The rest of the
-- application reads from a view and never thinks about versioning.
--
-- They are written two different ways on purpose (assignment requirement).
-- The application uses `view_formula_current`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Version A - aggregate subquery + self join
-- ---------------------------------------------------------------------------
-- Computes MAX(id) per uuid first (an index-friendly loose-index-scan on
-- ix_formula_uuid_id), then joins back to the base table on the primary key.
-- The join is a single-row primary-key lookup per uuid.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW view_formula_current AS
SELECT f.*
FROM formula f
JOIN (
  SELECT uuid, MAX(id) AS max_id
  FROM formula
  GROUP BY uuid
) latest
  ON latest.uuid = f.uuid
 AND latest.max_id = f.id;

-- ---------------------------------------------------------------------------
-- Version B - window function (ROW_NUMBER)
-- ---------------------------------------------------------------------------
-- Numbers every row within a uuid partition newest-first and keeps #1.
-- With the (uuid, id) index this is a streaming scan; without it MySQL has to
-- sort the whole table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW view_formula_current_window AS
SELECT cols.*
FROM (
  SELECT
    f.*,
    ROW_NUMBER() OVER (PARTITION BY f.uuid ORDER BY f.id DESC) AS rn
  FROM formula f
) cols
WHERE cols.rn = 1;
