import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Walks up from the process cwd looking for a .env, so the service starts the
 * same way whether it is launched from the repo root or from its own directory.
 * Real environment variables always win over the file.
 */
function loadEnvFile(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadEnvFile();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  USER_API_PORT: z.coerce.number().int().min(1).default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(10),
  JWT_REFRESH_SECRET: z.string().min(10),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),
  /// Where the frontend lives — used to build seat-invitation links.
  PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
  RECURRING_HORIZON_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  ENABLE_JOBS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.string().default('info'),
  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('Life Planner <no-reply@lifeplanner.local>'),

  // --- Free-tier quotas (Addendum 3). Tunable without a deploy. ---
  FREE_MAX_ACTIVITIES_PER_WEEK: z.coerce.number().int().min(0).default(5),
  FREE_MAX_GOALS: z.coerce.number().int().min(0).default(3),

  // --- Voice notes ---
  VOICE_NOTE_MAX_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  VOICE_NOTE_MAX_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
  AVATAR_MAX_BYTES: z.coerce.number().int().min(1024).default(5 * 1024 * 1024),

  // --- Cloudflare R2 (S3-compatible) ---
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default('lifeplanner'),
  R2_PUBLIC_BASE_URL: z.string().default(''),
  /** With no R2 credentials the storage layer writes to ./storage and serves
   *  from /media — so the whole upload flow is testable locally. */
  STORAGE_DRIVER: z.enum(['r2', 'local']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),

  // --- Payments ---
  PADDLE_API_KEY: z.string().default(''),
  PADDLE_WEBHOOK_SECRET: z.string().default(''),
  PADDLE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PAYSTACK_SECRET_KEY: z.string().default(''),
  PAYSTACK_CALLBACK_URL: z.string().default('http://localhost:3000/plan/callback'),
  APPLE_SHARED_SECRET: z.string().default(''),
  APPLE_BUNDLE_ID: z.string().default('app.lifeplanner'),
  GOOGLE_PACKAGE_NAME: z.string().default('app.lifeplanner'),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default(''),
  /// Shared token on the Pub/Sub push URL. The real guard is that every
  /// notification is re-verified against the Play API before it grants anything.
  GOOGLE_PUBSUB_TOKEN: z.string().default(''),
  /// Base64 DER of Apple's Root CA - G3, pinned as the root of the x5c chain.
  /// Empty disables the pin (development only).
  APPLE_ROOT_CA_G3: z.string().default(''),
  BILLING_DEFAULT_CURRENCY: z.string().length(3).default('NGN'),
  /** Set false in dev to accept store receipts without contacting Apple/Google. */
  VERIFY_STORE_RECEIPTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === 'production',
};
