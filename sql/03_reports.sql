-- ============================================================================
-- Edgenroots Formula Engine - Reports
-- ============================================================================
-- All reports read from the current-formula view / insert-only tables. None of
-- them mutate anything.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Full version history of one formula, oldest first, with a version number.
--    (Replace the literal with the target uuid, or bind it as a placeholder.)
-- ----------------------------------------------------------------------------
SELECT
  f.uuid,
  f.version,
  f.name,
  f.formula,
  f.status,
  f.created_by,
  f.updated_by,
  f.first_created_at,
  f.inserted_at
FROM formula f
WHERE f.uuid = '00000000-0000-0000-0000-000000000000'
ORDER BY f.version ASC;


-- ----------------------------------------------------------------------------
-- 2. All active formulas, in the order they would be executed.
--    The engine's real execution order is a topological sort computed in the
--    application. This query reproduces that level-by-level order in pure SQL:
--    it extracts every EXTERNAL_VAR.<name> read from each formula's text,
--    keeps the refs that point at another active formula (an edge), then walks
--    the edges with a recursive CTE to assign each formula its dependency
--    level. Formulas only compare within a level, so ordering by level then
--    name is a valid execution order.
-- ----------------------------------------------------------------------------
WITH RECURSIVE
numbers AS (
  SELECT 1 AS n
  UNION ALL
  SELECT n + 1 FROM numbers WHERE n < 50           -- support up to 50 refs/formula
),
active_formulas AS (
  SELECT * FROM view_formula_current WHERE status = 'ACTIVE'
),
refs AS (
  SELECT
    a.uuid,
    a.name AS node,
    REGEXP_REPLACE(
      REGEXP_SUBSTR(
        a.formula,
        'EXTERNAL_VAR\\s*(\\?\\.|\\.)\\s*(CODE\\s*(\\?\\.|\\.)\\s*)?[A-Za-z_$][A-Za-z0-9_$]*',
        1, numbers.n
      ),
      '^.*[.]', ''
    ) AS ref_name
  FROM active_formulas a
  JOIN numbers
  WHERE REGEXP_SUBSTR(
          a.formula,
          'EXTERNAL_VAR\\s*(\\?\\.|\\.)\\s*(CODE\\s*(\\?\\.|\\.)\\s*)?[A-Za-z_$][A-Za-z0-9_$]*',
          1, numbers.n
        ) IS NOT NULL
),
edges AS (
  SELECT DISTINCT r.node, r.ref_name AS dep
  FROM refs r
  JOIN active_formulas b ON b.name = r.ref_name
  WHERE r.ref_name <> r.node
),
levels AS (
  SELECT a.name AS name, 0 AS level
  FROM active_formulas a
  WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.node = a.name)
  UNION ALL
  SELECT e.node, l.level + 1
  FROM levels l
  JOIN edges e ON e.dep = l.name
  WHERE l.level < 100                              -- safety guard against cycles
)
SELECT
  a.name,
  a.uuid,
  a.version,
  MAX(l.level) AS dependency_level
FROM active_formulas a
LEFT JOIN levels l ON l.name = a.name
GROUP BY a.uuid, a.name, a.version
ORDER BY dependency_level ASC, a.name ASC;


-- ----------------------------------------------------------------------------
-- 3. Number of versions per formula.
-- ----------------------------------------------------------------------------
SELECT
  f.uuid,
  (SELECT c.name FROM view_formula_current c WHERE c.uuid = f.uuid) AS name,
  COUNT(*)                AS version_count,
  MIN(f.inserted_at)      AS first_version_at,
  MAX(f.inserted_at)      AS last_version_at
FROM formula f
GROUP BY f.uuid
ORDER BY version_count DESC, name ASC;


-- ----------------------------------------------------------------------------
-- 4. For the last 7 days, per formula: total runs, failures, failure %.
-- ----------------------------------------------------------------------------
SELECT
  formula_name,
  COUNT(*)                                              AS total_runs,
  SUM(status = 'FAILED')                                AS failures,
  SUM(status = 'SKIPPED')                               AS skipped,
  ROUND(100 * SUM(status = 'FAILED') / COUNT(*), 2)     AS failure_percentage
FROM formula_run_log
WHERE created_at >= (NOW() - INTERVAL 7 DAY)
GROUP BY formula_name
ORDER BY failure_percentage DESC, total_runs DESC;


-- ----------------------------------------------------------------------------
-- 5. Top 5 most-failing formulas with their most recent error message.
-- ----------------------------------------------------------------------------
SELECT
  f.formula_name,
  f.failures,
  (
    SELECT r.error
    FROM formula_run_log r
    WHERE r.formula_name = f.formula_name
      AND r.status = 'FAILED'
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 1
  ) AS most_recent_error
FROM (
  SELECT formula_name, COUNT(*) AS failures
  FROM formula_run_log
  WHERE status = 'FAILED'
  GROUP BY formula_name
) f
ORDER BY f.failures DESC
LIMIT 5;


-- ----------------------------------------------------------------------------
-- 6. Formulas that were deactivated and never reactivated.
--    The current row is the newest row for a uuid, so "currently INACTIVE" plus
--    "no ACTIVE row newer than it" means it is deactivated and has stayed that
--    way. (The NOT EXISTS is kept explicit for readability.)
-- ----------------------------------------------------------------------------
SELECT
  c.uuid,
  c.name,
  c.version,
  c.inserted_at AS deactivated_at
FROM view_formula_current c
WHERE c.status = 'INACTIVE'
  AND NOT EXISTS (
    SELECT 1
    FROM formula f
    WHERE f.uuid = c.uuid
      AND f.status = 'ACTIVE'
      AND f.id > c.id
  );


-- ----------------------------------------------------------------------------
-- 7a. Time between consecutive versions of each formula.
-- ----------------------------------------------------------------------------
WITH gaps AS (
  SELECT
    f.id,
    f.uuid,
    f.name,
    f.version,
    f.inserted_at,
    LAG(f.inserted_at) OVER (PARTITION BY f.uuid ORDER BY f.id) AS prev_inserted_at,
    TIMESTAMPDIFF(
      SECOND,
      LAG(f.inserted_at) OVER (PARTITION BY f.uuid ORDER BY f.id),
      f.inserted_at
    ) AS seconds_since_prev
  FROM formula f
)
SELECT uuid, name, version, inserted_at, prev_inserted_at, seconds_since_prev
FROM gaps
ORDER BY uuid, id;


-- ----------------------------------------------------------------------------
-- 7b. Average time between changes, per formula.
-- ----------------------------------------------------------------------------
WITH gaps AS (
  SELECT
    f.uuid,
    f.name,
    TIMESTAMPDIFF(
      SECOND,
      LAG(f.inserted_at) OVER (PARTITION BY f.uuid ORDER BY f.id),
      f.inserted_at
    ) AS seconds_since_prev
  FROM formula f
)
SELECT
  uuid,
  MAX(name)                          AS name,
  COUNT(seconds_since_prev)          AS change_count,
  AVG(seconds_since_prev)            AS avg_seconds_between_versions
FROM gaps
WHERE seconds_since_prev IS NOT NULL
GROUP BY uuid
ORDER BY avg_seconds_between_versions ASC;
