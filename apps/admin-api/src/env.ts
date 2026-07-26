import { z } from 'zod';

/**
 * admin-api env. Shares DATABASE_URL/REDIS_URL with user-api (same DB + same
 * Redis so socket rooms bridge). Uses ADMIN_JWT_SECRET for its own tokens and
 * its own CORS origin (the admin console is a separate frontend).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ADMIN_API_PORT: z.coerce.number().int().default(4001),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  CORS_ORIGIN_ADMIN: z.string().min(1).default('http://localhost:3001'),

  ADMIN_JWT_SECRET: z.string().min(16, 'ADMIN_JWT_SECRET must be at least 16 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  ADMIN_REFRESH_TTL: z.string().default('7d'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;

export const corsOrigins = env.CORS_ORIGIN_ADMIN.split(',').map((s) => s.trim());
