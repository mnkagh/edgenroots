'use strict';

const config = require('../config');
const { getPool, closePool } = require('../data/pool');
const { buildContainer } = require('../container');

/**
 * Insert the worked-example formulas. Deliberately created OUT of dependency
 * order (total first) to show the engine resolves order on its own.
 */
async function main() {
  const container = buildContainer({ pool: getPool(), config });
  const { formulaService } = container;

  const specs = [
    { name: 'total', formula: 'return EXTERNAL_VAR.commission + EXTERNAL_VAR.tax;' },
    { name: 'tax', formula: 'return EXTERNAL_VAR.commission * 0.18;' },
    { name: 'commission', formula: 'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;' },
  ];

  for (const spec of specs) {
    const saved = await formulaService.createOrChange({
      name: spec.name,
      formula: spec.formula,
      createdBy: 'seed',
      description: `Worked example: ${spec.name}`,
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded ${saved.name} (v${saved.version}) uuid=${saved.uuid}`);
  }

  await closePool();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err.message);
  process.exit(1);
});
