# Edgenroots Formula Engine

A versioned **formula service**: business rules live in the database as data
(short JavaScript formulas ending in `return`), may depend on each other's
results, and every number the engine produces comes with a step-by-step
explanation.

Three properties drive the whole design:

- **Traceable** – business tables are insert-only. Every change is a new row.
- **Explainable** – every result carries inputs, formula, substituted values and
  the final result.
- **Resilient** – every formula runs in an isolated process with a timeout, so a
  broken rule fails on its own and never takes the service down.

---

## 1. Stack & layout

- Node.js (>= 18), Express, MySQL 8 (`mysql2`), `formula-interpreter`, `zod`.
- Tests use the built-in `node:test` runner.

```
queries.sql              the seven SQL reports
src/
  app.js                 express app factory
  server.js              process entry point
  container.js           dependency wiring (constructor injection)
  config/index.js        env configuration
  routes/                express routers
  controllers/           thin HTTP adapters
  validators/            zod schemas + validation middleware
  services/
    formulaService.js    create/change/deactivate/rollback + all write validation
    previewService.js    single + bulk evaluation, dependency order, run logging
  data/
    pool.js              mysql2 pool
    saveRecord.js        THE single generic insert-only writer
    formulaRepository.js all reads
    runLogRepository.js  run-log writes (also via saveRecord)
  lib/
    formulaText.js       reference extraction, EXTERNAL_VAR normalisation, batch compiler
    interpreter.js       wrapper around formula-interpreter
    graph.js             dependency graph, topological levels, cycle detection
    round.js             safe 2-decimal rounding
    concurrency.js       promise pool
    serialize.js         row -> API shape
  middleware/errorHandler.js   consistent error envelope
  db/migrate.js, db/seed.js    schema/views and worked-example seed
sql/
  01_schema.sql          tables
  02_views.sql           current-formula view, written two ways
test/
  unit/                  fast tests (no database)
  acceptance/run.js      end-to-end scenarios against MySQL
```

---

## 2. Setup

```bash
# 1. dependencies
npm install

# 2. configuration
copy .env.example .env          # Windows
# edit .env -> DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME

# 3. schema + views
npm run migrate

# 4. (optional) worked-example formulas: tax, commission, total
npm run seed

# 5. run
npm start                       # http://localhost:3000
```

Run the tests:

```bash
npm test            # 37 unit tests, no database required
npm run acceptance  # end-to-end scenarios against MySQL (drops/creates DB_NAME)
```

`npm run acceptance` uses its own database (`DB_NAME=edgenroots_acceptance` by
default) and recreates it on every run.

---

## 3. API

All success responses are `{ "data": ... }`; all errors are
`{ "error": { "code", "message", "details" } }`.

### `POST /formulas` — create or change

Create (no `uuid`): `201`. Change (`uuid` present, `version` required): `200`.
The change request **must** carry the version the client last saw.

```bash
curl -X POST localhost:3000/formulas -H 'content-type: application/json' -d '{
  "name": "commission",
  "formula": "return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;",
  "createdBy": "alice"
}'
```

```json
{
  "data": {
    "id": 1, "uuid": "6f1c...", "version": 1,
    "name": "commission",
    "formula": "return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;",
    "status": "ACTIVE", "description": null,
    "createdBy": "alice", "updatedBy": null,
    "firstCreatedAt": "2026-10-15T09:00:00.000Z",
    "insertedAt": "2026-10-15T09:00:00.000Z"
  }
}
```

Change (new row, same uuid):

```bash
curl -X POST localhost:3000/formulas -H 'content-type: application/json' -d '{
  "uuid": "6f1c...", "version": 1,
  "name": "commission",
  "formula": "return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;",
  "createdBy": "bob"
}'
```

A save is rejected with `400` (and inserted nothing) when the name is not a
valid identifier, the name is already active, the formula fails against sample
data, or the save would create a dependency loop. Renaming/deactivating
something that active formulas depend on is rejected unless `"force": true`.
Optional `"sampleData": {...}` overrides the auto-generated sample record used
to check the formula runs.

### `POST /formulas/:uuid/deactivate`

```bash
curl -X POST localhost:3000/formulas/6f1c.../deactivate \
  -H 'content-type: application/json' -d '{ "version": 2, "createdBy": "alice" }'
```

Rejected with `400 DEPENDENTS_EXIST` (listing the impacted formulas) if active
formulas depend on it and `force` is not set.

### `POST /formulas/:uuid/rollback`

Makes an older version current again as a **new** row (version = current + 1).

```bash
curl -X POST localhost:3000/formulas/6f1c.../rollback \
  -H 'content-type: application/json' -d '{ "toVersion": 1, "version": 3, "createdBy": "alice" }'
```

### `GET /formulas` — current version of every formula (from the view)

```bash
curl localhost:3000/formulas
curl 'localhost:3000/formulas?status=ACTIVE'
```

### `GET /formulas/:uuid/history` — all versions, oldest first

### `GET /formulas/:uuid/impact` — every formula that (transitively) depends on it

```json
{ "data": [ { "name": "tax", "uuid": "..." }, { "name": "total", "uuid": "..." } ] }
```

### `POST /formulas/preview` — evaluate for one record

```bash
curl -X POST localhost:3000/formulas/preview -H 'content-type: application/json' -d '{
  "record": { "amount": 2000, "rate": 10 }
}'
```

Optional `formulaUuids` (default: all active) and `asOf` (ISO timestamp).

```json
{
  "data": {
    "runId": "0b1e...",
    "order": ["commission", "tax", "total"],
    "results": [
      {
        "name": "commission", "uuid": "6f1c...", "version": 1,
        "status": "SUCCESS", "result": 200, "error": null, "durationMs": 118,
        "calculation": {
          "inputs": { "amount": 2000, "rate": 10 },
          "formula": "return EXTERNAL_VAR.CODE.amount * EXTERNAL_VAR.CODE.rate / 100;",
          "substituted": ["2000 * 10 / 100;"],
          "result": "200",
          "steps": ["amount = 2000", "rate = 10", "return ...", "= 2000 * 10 / 100;", "= 200"]
        }
      },
      { "name": "tax", "status": "SUCCESS", "result": 36,  "...": "..." },
      { "name": "total", "status": "SUCCESS", "result": 236, "...": "..." }
    ],
    "record": { "amount": 2000, "rate": 10, "commission": 200, "tax": 36, "total": 236 }
  }
}
```

### `POST /formulas/preview/bulk` — up to 500 records

```bash
curl -X POST localhost:3000/formulas/preview/bulk -H 'content-type: application/json' -d '{
  "records": [ { "amount": 2000, "rate": 10 }, { "amount": 1000, "rate": 10 } ]
}'
```

```json
{
  "data": {
    "runId": "...",
    "order": ["commission", "tax", "total"],
    "summary": {
      "records": 2, "formulas": 3, "evaluations": 6,
      "totalMs": 214, "avgMsPerRecord": 107, "succeeded": 6, "failures": 0, "skipped": 0
    },
    "results": [ { "index": 0, "record": { "...": "..." }, "results": [ "..." ] } ]
  }
}
```

---

## 4. Data model and the insert-only rule

Two tables, both append-only:

- **`formula`** – one row per *version*. Columns: `id` (row identity),
  `uuid` (logical identity, never changes), `version`, `name`, `formula`,
  `status`, `created_by`, `updated_by`, `first_created_at` (logical birth,
  copied across versions), `inserted_at` (this row's write instant).
- **`formula_run_log`** – one row per formula evaluation in a preview, grouped
  by `run_uuid`, holding input, result, calculation, status and error.

Every operation maps to an insert:

| action | effect |
|--------|--------|
| create `tax` | new row, new uuid, version 1 |
| change `tax` | new row, same uuid, version n+1 |
| deactivate  | new row, same uuid, `status INACTIVE` |
| rollback    | new row, same uuid, copy of the target version's values |

`id` gives a total order and makes "the current version" simply "the row with
the highest id". No application code ever mutates or removes a row; see
`sql/01_schema.sql` and the `UPDATE`/`DELETE`-free `src/data/saveRecord.js`.

### The two current-formula views (`sql/02_views.sql`)

`view_formula_current` (aggregate subquery + self-join on `MAX(id)`):

```sql
SELECT f.* FROM formula f
JOIN (SELECT uuid, MAX(id) AS max_id FROM formula GROUP BY uuid) latest
  ON latest.uuid = f.uuid AND latest.max_id = f.id;
```

`view_formula_current_window` (window function):

```sql
SELECT cols.* FROM (
  SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.uuid ORDER BY f.id DESC) AS rn
  FROM formula f
) cols WHERE cols.rn = 1;
```

**We use the aggregate-subquery version.** With `KEY (uuid, id)` the
`MAX(id) GROUP BY uuid` can be satisfied by an index scan (MySQL's loose index
scan), and the join back is one primary-key lookup per uuid. The window version
is equally correct and reads nicely, but it must scan every row of the table and
sort each partition; without a perfectly aligned index it materialises the whole
table. For a table whose row count only ever grows, we prefer the plan that stays
index-driven. Both views are kept so the choice can be re-measured with `EXPLAIN`
against real data.

### Indexes (and why)

- `UNIQUE (uuid, version)` – the concurrency guard (see §6) and the key for
  history/rollback lookups.
- `(uuid, id)` – makes "current row of a uuid" (`ORDER BY id DESC LIMIT 1`) and
  the `MAX(id) GROUP BY uuid` in the view cheap.
- `(name)` – name-uniqueness checks and name → formula resolution.
- `(status)` / `(inserted_at)` – listing active formulas and as-of lookups.
- run-log: `(formula_name, status, created_at)` for the failure reports,
  `(run_uuid)` for grouping a preview, `(created_at)` for the 7-day window.

The seven reports are in `queries.sql` (repo root). Report 2 (active formulas in
execution order) reproduces the engine's topological level order in pure SQL: it
extracts each formula's `EXTERNAL_VAR.*` references with `REGEXP_SUBSTR`,
keeps the refs that point at another active formula, then walks the resulting
edges with a recursive CTE to assign each formula its dependency level.

---

## 5. The central save function (`src/data/saveRecord.js`)

`saveRecord(table, data, options)` is the only function that writes. It:

1. generates a uuid and stamps `first_created_at` when none is supplied;
2. when a uuid is supplied, reads the current row, keeps its original creation
   details and merges the new fields (unsent fields keep their previous value);
3. **always inserts** – there is no mutating statement in the file;
4. uses bound parameters exclusively;
5. accepts one object or an array and inserts an array in a **single** SQL
   statement;
6. works for any table: it reads the table's columns (and their defaults /
   auto-increment flags) from `information_schema`, so adding a table needs no
   code change – just the table name and its uuid column;
7. returns the saved rows including their new `id` and `uuid`.

The caller may pass the `version` explicitly; `saveRecord` only auto-increments
when it is not given. That is what lets the service pin a change to
`baseVersion + 1` (see below).

---

## 6. Concurrency

A change carries the `version` the client last saw. The service:

1. loads the current version; if it differs from the supplied version → `409`
   **immediately**, returning the current version in `error.details.current`;
2. otherwise pins the new row to `version = current + 1` (not "whatever is
   newest now").

The guarantee that two simultaneous requests can never both win against the same
base version comes from **`UNIQUE (uuid, version)` combined with insert-only
storage**. Both requests compute the same target version; the first insert
succeeds and the second violates the unique key. `saveRecord`/`formulaService`
translate that duplicate-key error into the same `409` (with the current
version). Because rows are never overwritten, there is no way around the unique
index, and no lost update is possible without a database error. No explicit
locking is required.

`npm run acceptance` proves it: two concurrent changes on the same base version
yield exactly one `200` and one `409`.

---

## 7. Dependency resolution (`src/lib/graph.js`)

- References are read straight from the formula text with a regex over
  `EXTERNAL_VAR.<name>` (and `?.` / `.CODE.` forms).
- A reference becomes a **graph edge** when the name is another formula in the
  set; otherwise it is a field of the input record. A name that is neither is
  reported as a **missing input before anything runs**.
- **Kahn's algorithm** produces *levels*; every formula in a level only depends
  on earlier levels, so a level is evaluated in parallel and levels run in order.
  Formulas may be created in any order (e.g. `total` first) – the order is
  derived, never declared.
- **Loops** are detected when not all nodes get processed; a DFS on the leftover
  sub-graph returns the full path, reported as `a → b → c → a`. A loop can never
  be saved (checked on every create/change/rollback).
- `GET /formulas/:uuid/impact` walks the reverse edges to list every direct and
  indirect dependent.

---

## 8. Failure handling

- Every evaluation has a timeout (`FORMULA_TIMEOUT_MS`, default 3 s). A formula
  that never returns is killed and marked `FAILED` (`Timed out`).
- A `FAILED` formula never hides the others: its dependents are marked
  `SKIPPED` with the reason `Dependency '<name>' did not succeed`, while
  independent formulas still run.
- Every preview writes one run-log row per formula, all sharing one `run_uuid`.
  For a single preview that is one multi-row insert; a bulk preview writes all
  of its rows in a single insert too.
- Results are rounded to 2 decimals with a string-exponent method
  (`src/lib/round.js`) so `0.1 + 0.2` becomes exactly `0.3`, never
  `0.30000000000000004`. Dependent formulas consume the rounded value, matching
  what an invoice would show.

---

## 9. Performance

A bulk preview of 500 records × 10 formulas must fit in 30 s. Spawning one
isolated process per (formula, record) does not: measured at ~20 ms/op it is
~100 s. So bulk uses a **batch compiler** (`compileBatch`):

- for each formula, `EXTERNAL_VAR.CODE.field` is rewritten to `row.field` and
  the body is wrapped so the formula evaluates once over the **whole array** of
  records in a single isolated process:
  `return (rows).map(function(row){ <body> })`;
- dependencies are still resolved level by level; each level's formula results
  are merged back into every record before the next level runs;
- 500 × 10 becomes **10 processes**, measured at ~1.2 s (≈0.2 s in-process after
  warm-up). Concurrency is capped (`BULK_CONCURRENCY`) so the machine is never
  flooded.

The single-record preview intentionally keeps the one-process-per-formula path
because that is what produces the interpreter's rich calculation text.

---

## 10. Notes on `formula-interpreter`

Part of the task is using the library correctly. Two facts we established by
experiment (Node 24, `formula-interpreter@2.1.0`):

1. **Inputs must be read as `EXTERNAL_VAR.CODE.<name>`.** A plain
   `EXTERNAL_VAR.<name>` causes the library's calculation extractor to fail
   (`Unexpected number`), returning `status: 0` even though the evaluation
   itself succeeded. To honour the assignment's `EXTERNAL_VAR.<name>` contract
   *and* get explanations, we **normalise** the formula
   (`EXTERNAL_VAR.x` → `EXTERNAL_VAR.CODE.x`) just before evaluation and pass the
   record under `{ CODE: record }`. `EXTERNAL_VAR.CODE.x` is left untouched
   (idempotent).
2. **The optional helper libraries (`IF`, `ROUND`, `SUM`, ...) are unusable with
   the calculation text in this version.** The extractor re-evaluates the
   library's injected `const X = require(...)` line inside a `new Function`,
   where `require` is undefined, so any library raises `require is not defined`
   and the whole result is discarded. We therefore do **not** request the helper
   libraries and implement rounding in the engine instead. Formulas may still
   use built-in JavaScript (`Math.round`, `Math.max`, ...).

The interpreter returns `{ status: 1, data, calculation }` on success and
`{ status: 0, error }` on failure/timeout, and it never rejects. Our wrapper
(`src/lib/interpreter.js`) normalises that into `SUCCESS`/`FAILED` and splits the
free-text `calculation` into structured `inputs`, `formula`, `substituted` and
`result`.

---

## 11. Assumptions

- Formula names are JavaScript identifiers; a name is unique among **active**
  formulas. Because old rows are kept forever, uniqueness is enforced in the
  service against the current view rather than by a database constraint (a
  constraint would conflict with superseded rows). Concurrent creates with the
  same brand-new name are an accepted, documented edge case.
- Precedence when a name is both a formula and a record field: the **formula**
  wins (its result is added to the record and read by dependents).
- When `formulaUuids` narrows a preview, dependencies outside that list must be
  provided in the record, otherwise they are reported as missing inputs.
- `createdBy` defaults to `"system"` when omitted.
- A rollback restores the target version's name, formula **and** status.
- Save-time validation rejects syntax/reference errors but **allows a timeout**:
  a formula that fails to finish against sample data has already parsed and
  begun executing, so its non-termination is a run-time concern that the
  engine handles as `FAILED` + `SKIPPED` dependents (this is what makes the
  "formula loops forever" scenario testable through the API).

---

## 12. Written answer — why new rows, what it costs, and staying fast

Storing every change as a new row buys three things that matter for money
numbers: a perfect audit trail (history is never lost), trivial concurrency
(nothing to lock or overwrite, so two admins cannot clobber each other), and
safe rollbacks (an old version still exists, so "undo" is just another insert).
The cost is unbounded growth: a formula edited ten times a day for years is
hundreds of rows, and every *current* lookup must ignore all superseded ones.
At millions of versions that scan hurts.

To keep it fast: (1) a covering index on `(uuid, id)` so "highest id per uuid"
is an index scan, and read only through the current view; (2) keep a small,
still insert-only "current pointer" table mapping uuid to latest id when the
view gets slow; (3) partition by time so old partitions stay cold; (4) archive
versions past the retention window to cheap storage while keeping the current
row. Indexes lead with `uuid`, so they stay small, and the high-volume run log
lives in its own table with time-based pruning. The app is unchanged: it only
inserts and reads the view.

---

## 13. Acceptance

`npm run acceptance` runs the scenarios from the brief (dependency-order
creation, as-of preview, rollback, concurrent 409, guarded deactivation, loop
path, syntax rejection, timeout/skip isolation, 500-record bulk under 30 s, and
a source scan proving no `UPDATE`/`DELETE` against business tables) and prints a
pass/fail line for each.
