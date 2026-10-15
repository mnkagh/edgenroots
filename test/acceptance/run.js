'use strict';

// Choose an isolated database before any module reads the config.
process.env.DB_NAME = process.env.DB_NAME || 'edgenroots_acceptance';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../../src/config');
const { createApp } = require('../../src/app');

const SQL_DIR = path.resolve(__dirname, '../../sql');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootstrapPool() {
  const admin = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${config.db.database}\``);
  await admin.query(`CREATE DATABASE \`${config.db.database}\` CHARACTER SET utf8mb4`);
  await admin.query(`USE \`${config.db.database}\``);
  for (const file of ['01_schema.sql', '02_views.sql']) {
    await admin.query(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'));
  }
  await admin.end();

  return mysql.createPool({ ...config.db, connectionLimit: 5 });
}

async function main() {
  const pool = await bootstrapPool();
  const app = createApp({ pool, config });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  const byName = (rows, name) => rows.find((f) => f.name === name);
  const results = [];
  async function scenario(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  PASS  ${name}`);
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  const { strict: assert } = require('node:assert');

  // --- setup -----------------------------------------------------------------
  const create = (name, formula) => api('POST', '/formulas', { name, formula, createdBy: 'acceptance' });
  await create('total', 'return EXTERNAL_VAR.commission + EXTERNAL_VAR.tax;');
  await create('tax', 'return EXTERNAL_VAR.commission * 0.18;');
  await create('commission', 'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;');
  await sleep(20);

  await scenario('Create total, tax, commission then preview the worked example', async () => {
    const listed = (await api('GET', '/formulas')).body.data;
    assert.equal(listed.length, 3, 'three active formulas');

    const out = (await api('POST', '/formulas/preview', { record: { amount: 2000, rate: 10 } })).body.data;
    const r = Object.fromEntries(out.results.map((x) => [x.name, x]));
    assert.equal(r.commission.result, 200);
    assert.equal(r.tax.result, 36);
    assert.equal(r.total.result, 236);
    assert.deepEqual(out.order, ['commission', 'tax', 'total'], 'dependency order');
  });

  const taxV1 = byName((await api('GET', '/formulas')).body.data, 'tax');
  const beforeChange = new Date().toISOString();
  await sleep(20);

  await scenario('Change tax to commission * 0.12, then list formulas', async () => {
    const changed = await api('POST', '/formulas', {
      uuid: taxV1.uuid,
      version: taxV1.version,
      name: 'tax',
      formula: 'return EXTERNAL_VAR.commission * 0.12;',
      createdBy: 'acceptance',
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.version, 2);

    const listed = (await api('GET', '/formulas')).body.data;
    assert.match(byName(listed, 'tax').formula, /0\.12/);

    const history = (await api('GET', `/formulas/${taxV1.uuid}/history`)).body.data;
    assert.equal(history.length, 2);
  });

  // The tax change is now committed; `beforeChange` predates it.

  await scenario('Preview with an as-of time before the change uses the old tax (total 236)', async () => {
    const out = (
      await api('POST', '/formulas/preview', {
        record: { amount: 2000, rate: 10 },
        asOf: beforeChange,
      })
    ).body.data;
    const r = Object.fromEntries(out.results.map((x) => [x.name, x]));
    assert.equal(r.tax.result, 36, 'old tax 18%');
    assert.equal(r.total.result, 236);
  });

  const taxCurrent = byName((await api('GET', '/formulas')).body.data, 'tax');

  await scenario('Roll back tax to version 1 (new version 3 copies v1 values)', async () => {
    const rolled = await api('POST', `/formulas/${taxV1.uuid}/rollback`, {
      toVersion: 1,
      version: taxCurrent.version,
      createdBy: 'acceptance',
    });
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.data.version, 3);
    assert.match(rolled.body.data.formula, /0\.18/);
  });

  await scenario('Two simultaneous changes on the same base version: one wins, one 409', async () => {
    const cur = byName((await api('GET', '/formulas')).body.data, 'tax');
    const payload = (formula) => ({
      uuid: taxV1.uuid,
      version: cur.version,
      name: 'tax',
      formula,
      createdBy: 'acceptance',
    });
    const [a, b] = await Promise.all([
      api('POST', '/formulas', payload('return EXTERNAL_VAR.commission * 0.20;')),
      api('POST', '/formulas', payload('return EXTERNAL_VAR.commission * 0.25;')),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 409], `expected one 200 and one 409, got ${codes}`);
    const conflict = a.status === 409 ? a : b;
    assert.ok(conflict.body.error.details.current.version, 'conflict carries the current version');
  });

  await scenario('Deactivate tax without force is rejected and lists total as impacted', async () => {
    const cur = byName((await api('GET', '/formulas')).body.data, 'tax');
    const res = await api('POST', `/formulas/${taxV1.uuid}/deactivate`, {
      version: cur.version,
      createdBy: 'acceptance',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'DEPENDENTS_EXIST');
    assert.ok(res.body.error.details.impacted.some((f) => f.name === 'total'));
  });

  await scenario('Loop a -> b -> c -> a is rejected with the full path', async () => {
    await create('loopa', 'return EXTERNAL_VAR.loopb + 1;');
    await create('loopb', 'return EXTERNAL_VAR.loopc + 1;');
    const res = await create('loopc', 'return EXTERNAL_VAR.loopa + 1;');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'DEPENDENCY_CYCLE');
    assert.match(res.body.error.message, /loopa → loopb → loopc → loopa/);
  });

  await scenario('A formula with a syntax error returns 400 and inserts nothing', async () => {
    const res = await create('broken', 'return EXTERNAL_VAR.amount *;');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'FORMULA_INVALID');
    const listed = (await api('GET', '/formulas')).body.data;
    assert.ok(!byName(listed, 'broken'), 'not saved');
  });

  await scenario('A non-terminating formula FAILs at timeout, dependents SKIP, others succeed', async () => {
    const loop = (await create('forever', 'while (true) {} return 1;')).body.data;
    const dep = (await create('dependsOnForever', 'return EXTERNAL_VAR.forever + 1;')).body.data;
    const indep = (await create('independent', 'return EXTERNAL_VAR.amount * 2;')).body.data;

    const out = (
      await api('POST', '/formulas/preview', {
        record: { amount: 10 },
        formulaUuids: [loop.uuid, dep.uuid, indep.uuid],
      })
    ).body.data;
    const r = Object.fromEntries(out.results.map((x) => [x.name, x]));
    assert.equal(r.forever.status, 'FAILED');
    assert.match(r.forever.error, /Timed out/i);
    assert.equal(r.dependsOnForever.status, 'SKIPPED');
    assert.equal(r.independent.status, 'SUCCESS');
    assert.equal(r.independent.result, 20);
  });

  await scenario('Bulk preview of 500 records completes within 30s', async () => {
    const listed = (await api('GET', '/formulas')).body.data;
    const worked = ['commission', 'tax', 'total'].map((n) => byName(listed, n).uuid);
    const records = Array.from({ length: 500 }, (_, i) => ({ amount: 1000 + i, rate: 10 }));
    const t0 = Date.now();
    const out = (
      await api('POST', '/formulas/preview/bulk', { records, formulaUuids: worked })
    ).body.data;
    const elapsed = Date.now() - t0;
    assert.equal(out.summary.records, 500);
    assert.equal(out.summary.formulas, 3);
    assert.equal(out.summary.failures, 0, 'no failures');
    assert.ok(elapsed < 30000, `took ${elapsed}ms`);
    assert.equal(out.results[0].record.commission, 100);
    console.log(`        bulk 500 records x ${out.summary.formulas} formulas in ${elapsed}ms (server ${out.summary.totalMs}ms)`);
  });

  await scenario('Source contains no UPDATE or DELETE against business tables', async () => {
    const srcDir = path.resolve(__dirname, '../../src');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const text = fs
            .readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
          if (/\b(UPDATE|DELETE)\b/i.test(text)) offenders.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, [], `found UPDATE/DELETE in: ${offenders.join(', ')}`);
  });

  server.close();
  await pool.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Acceptance run failed:', err);
  process.exit(1);
});
