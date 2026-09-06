import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const rows = await p.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`,
  );
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await p.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  console.log('truncated', rows.length, 'tables');
}
main().finally(() => p.$disconnect());
