import {
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  hashPassword,
} from '@life-planner/shared-utils';
import { prisma } from '../src/index.js';

/**
 * Dev seed. Creates:
 *   - one SUPERADMIN admin
 *   - one demo user, with the default categories + settings (mirrors the
 *     per-user registration seed so local dev has something to look at)
 *
 * Idempotent via upserts; safe to run repeatedly.
 */
async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@lifeplanner.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin12345';

  const admin = await prisma.admin.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      name: 'Super Admin',
      role: 'SUPERADMIN',
    },
  });
  console.log(`✓ admin: ${admin.email} (SUPERADMIN)`);

  const userEmail = process.env.SEED_USER_EMAIL ?? 'demo@lifeplanner.local';
  const userPassword = process.env.SEED_USER_PASSWORD ?? 'demo12345';

  const user = await prisma.user.upsert({
    where: { email: userEmail },
    update: {},
    create: {
      email: userEmail,
      passwordHash: await hashPassword(userPassword),
      name: 'Demo User',
      timezone: 'UTC',
      categories: {
        create: DEFAULT_CATEGORIES.map((c) => ({
          name: c.name,
          color: c.color,
          icon: c.icon,
          isDefault: true,
        })),
      },
      settings: {
        create: { data: DEFAULT_SETTINGS },
      },
    },
    include: { categories: true },
  });
  console.log(`✓ user: ${user.email} (${user.categories.length} categories)`);
  console.log('\nSeed complete. Credentials:');
  console.log(`  admin → ${adminEmail} / ${adminPassword}`);
  console.log(`  user  → ${userEmail} / ${userPassword}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
