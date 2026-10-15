-- ============================================================================
-- Edgenroots Formula Engine - Schema
-- ============================================================================
-- Core rule: business tables are INSERT-ONLY. No UPDATE / DELETE ever runs
-- against them. Every logical record is identified by a permanent UUID; every
-- physical row has its own auto-increment id. A "change" is a new row with the
-- same UUID. The current version of a record is the row with the highest id.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- formula
-- ---------------------------------------------------------------------------
-- One row per *version* of a formula. The logical formula is identified by
-- `uuid` (never changes). `version` is a per-uuid counter used both for
-- ordering and as the optimistic-concurrency guard: UNIQUE (uuid, version)
-- makes it impossible for two writers to base a change on the same version
-- and both win (the second INSERT hits a duplicate-key error).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS formula (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid             CHAR(36)        NOT NULL,
  version          INT UNSIGNED    NOT NULL,
  name             VARCHAR(128)    NOT NULL,
  formula          TEXT            NOT NULL,
  status           ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  description      VARCHAR(500)    NULL,
  created_by       VARCHAR(128)    NOT NULL,
  updated_by       VARCHAR(128)    NULL,
  first_created_at DATETIME(3)     NOT NULL,
  inserted_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_formula_uuid_version (uuid, version),
  -- Fast "current row of a uuid" lookup: ORDER BY id DESC LIMIT 1.
  KEY ix_formula_uuid_id (uuid, id),
  -- Name lookups (uniqueness checks, name -> formula resolution).
  KEY ix_formula_name (name),
  -- Listing by status.
  KEY ix_formula_status (status),
  -- As-of queries filter on insertion instant.
  KEY ix_formula_inserted_at (inserted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- formula_run_log
-- ---------------------------------------------------------------------------
-- One row per formula evaluation performed during a preview. All rows produced
-- by a single preview share the same `run_uuid`. Also insert-only.
-- `uuid` is this row's own identity (so run-log writes can flow through the
-- same generic saveRecord() as every other table).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS formula_run_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid            CHAR(36)        NOT NULL,
  run_uuid        CHAR(36)        NOT NULL,
  record_index    INT             NULL,
  formula_uuid    CHAR(36)        NULL,
  formula_name    VARCHAR(128)    NOT NULL,
  formula_version INT UNSIGNED    NULL,
  input           JSON            NULL,
  result          JSON            NULL,
  calculation     TEXT            NULL,
  status          ENUM('SUCCESS','FAILED','SKIPPED') NOT NULL,
  error           TEXT            NULL,
  duration_ms     INT UNSIGNED    NULL,
  as_of           DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_runlog_uuid (uuid),
  KEY ix_runlog_run (run_uuid),
  -- Report 4/5: failures per formula over a time window.
  KEY ix_runlog_name_status_created (formula_name, status, created_at),
  KEY ix_runlog_created_at (created_at),
  KEY ix_runlog_formula_uuid (formula_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
