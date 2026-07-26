import { z } from 'zod';

/**
 * Validates process.env at boot and exposes a typed, frozen config object.
 * Fails fast (process exit) if required vars are missing/invalid.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  USER_API_PORT: z.coerce.number().int().default(4000),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  CORS_ORIGIN_USER: z.string().min(1).default('http://localhost:3000'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  ADMIN_JWT_SECRET: z.string().min(16).default('unused-in-user-api-but-kept-for-parity'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),

  MAIL_PROVIDER: z.enum(['smtp', 'resend', 'console']).default('console'),
  MAIL_FROM: z.string().default('Life Planner <no-reply@lifeplanner.local>'),
  SMTP_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),

  RECURRING_HORIZON_DAYS: z.coerce.number().int().min(1).max(365).default(60),

  // Public web app base URL, used to build links in transactional emails.
  WEB_APP_URL: z.string().min(1).default('http://localhost:3000'),
  // Free-tier daily assistant message cap; subscribers bypass it.
  FREE_DAILY_MESSAGE_LIMIT: z.coerce.number().int().min(1).default(10),
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

/** CORS allowlist for this service. */
export const corsOrigins = env.CORS_ORIGIN_USER.split(',').map((s) => s.trim());
