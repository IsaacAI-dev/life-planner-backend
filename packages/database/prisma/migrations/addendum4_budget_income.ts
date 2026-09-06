/**
 * Addendum 4 — budget income migration.
 *
 * `BudgetMonth.estimatedIncome` was a single number per month. It becomes one
 * PROJECTED `BudgetIncome` row titled "Monthly income": the column was called
 * *estimated*, so PROJECTED is the truthful mapping — claiming the money had
 * arrived would be inventing history.
 *
 * ── Why two phases ────────────────────────────────────────────────────────
 * `prisma db push` creates `BudgetIncome` and drops `estimatedIncome` in the
 * same operation, so there is no moment when both exist. The old values must
 * therefore be read out to disk BEFORE the push and written back after it.
 *
 *   pnpm tsx prisma/migrations/addendum4_budget_income.ts export
 *   pnpm db:push
 *   pnpm tsx prisma/migrations/addendum4_budget_income.ts import
 *
 * Both phases are idempotent. `import` skips any month that already has income
 * rows, and refuses to run if the export file is missing rather than quietly
 * doing nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DUMP_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '.legacy-estimated-income.json',
);

interface LegacyRow {
  id: string;
  estimatedIncome: string | number | null;
}

async function exportPhase() {
  console.log('💰 [export] Reading legacy estimatedIncome values…');

  let legacy: LegacyRow[];
  try {
    legacy = await prisma.$queryRawUnsafe<LegacyRow[]>(
      'SELECT id, "estimatedIncome" FROM "BudgetMonth"',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only a genuinely absent column means "already migrated". A dead database
    // or bad credentials must fail loudly — reporting "nothing to migrate"
    // when we simply could not reach Postgres would invite someone to drop the
    // column and lose the data.
    if (/does not exist/i.test(message) && /estimatedIncome|BudgetMonth/i.test(message)) {
      console.log('   Column already removed — nothing to export.');
      return;
    }
    console.error('❌ Could not read the legacy column. NOT safe to push the schema yet.');
    throw err;
  }

  const rows = legacy
    .map((r) => ({ id: r.id, amount: Number(r.estimatedIncome ?? 0) }))
    // A zero estimate carries no information worth preserving as a row.
    .filter((r) => r.amount > 0);

  fs.writeFileSync(DUMP_PATH, JSON.stringify(rows, null, 2));
  console.log(`✅ Wrote ${rows.length} value(s) to ${path.basename(DUMP_PATH)}.`);
  console.log('   Now run `pnpm db:push`, then this script with `import`.');
}

async function importPhase() {
  console.log('💰 [import] Restoring legacy income as BudgetIncome rows…');

  if (!fs.existsSync(DUMP_PATH)) {
    throw new Error(
      `No export file at ${DUMP_PATH}. Run the \`export\` phase before pushing the schema — ` +
        'without it the old amounts are gone and cannot be recovered from the database.',
    );
  }

  const rows = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8')) as { id: string; amount: number }[];

  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    // The month may have been deleted between the two phases.
    const month = await prisma.budgetMonth.findUnique({
      where: { id: row.id },
      select: { id: true },
    });
    if (!month) {
      skipped += 1;
      continue;
    }

    const existing = await prisma.budgetIncome.count({ where: { budgetMonthId: row.id } });
    if (existing > 0) {
      skipped += 1;
      continue;
    }

    await prisma.budgetIncome.create({
      data: {
        budgetMonthId: row.id,
        title: 'Monthly income',
        description: 'Migrated from the previous single-figure monthly estimate.',
        amount: row.amount,
        status: 'PROJECTED',
      },
    });
    created += 1;
  }

  console.log(`✅ Done. ${created} income row(s) created, ${skipped} skipped.`);
  console.log(`   You can delete ${path.basename(DUMP_PATH)} once you are happy with the result.`);
}

const phase = process.argv[2];

if (phase !== 'export' && phase !== 'import') {
  console.error('Usage: addendum4_budget_income.ts <export|import>');
  console.error('  export  — run BEFORE `prisma db push`');
  console.error('  import  — run AFTER `prisma db push`');
  process.exit(1);
}

(phase === 'export' ? exportPhase() : importPhase())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
