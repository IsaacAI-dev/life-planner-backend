import { z } from 'zod';

export const checkoutSchema = z.object({
  tier: z.literal('PRO'),
  interval: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL']).default('MONTHLY'),
  platform: z.enum(['WEB', 'IOS', 'ANDROID']).default('WEB'),
  /** Overrides the stored country for this checkout only (rarely needed). */
  country: z.string().length(2).toUpperCase().optional(),
  successUrl: z.string().url().max(500).optional(),
  cancelUrl: z.string().url().max(500).optional(),
});

/**
 * Mobile purchases are made in-app; the client posts the store receipt here and
 * the server verifies it with Apple/Google before granting entitlement. The
 * client is never trusted to declare its own tier.
 */
export const verifyStorePurchaseSchema = z.object({
  platform: z.enum(['IOS', 'ANDROID']),
  productId: z.string().min(1).max(200),
  /** Apple: signedTransactionInfo / receipt. Google: purchaseToken. */
  purchaseToken: z.string().min(1).max(6000),
  packageName: z.string().max(200).optional(),
});

export const cancelSubscriptionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  immediate: z.boolean().default(false),
});

export const planCatalogQuerySchema = z.object({
  country: z.string().length(2).toUpperCase().optional(),
  platform: z.enum(['WEB', 'IOS', 'ANDROID']).default('WEB'),
});

export const upsertPlanEntrySchema = z.object({
  tier: z.enum(['FREE', 'PRO']),
  interval: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL']),
  currency: z.string().length(3).toUpperCase(),
  amount: z.number().nonnegative().max(9_999_999),
  region: z.string().max(20).default(''),
  seats: z.number().int().min(1).max(3).default(1),
  name: z.string().trim().min(1).max(80),
  /// All customer-facing copy is database-driven so it changes without a deploy.
  description: z.string().trim().max(1000).optional(),
  privacyNote: z.string().trim().max(1000).optional(),
  features: z.array(z.string().trim().min(1).max(200)).max(20),
  highlight: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
  paddlePriceId: z.string().max(200).optional(),
  paystackPlanId: z.string().max(200).optional(),
  appleProductId: z.string().max(200).optional(),
  googleProductId: z.string().max(200).optional(),
});

export const transactionQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  provider: z.enum(['PADDLE', 'PAYSTACK', 'APPLE_APP_STORE', 'GOOGLE_PLAY']).optional(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'DISPUTED']).optional(),
  userId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const revenueReportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  groupBy: z.enum(['day', 'week', 'month', 'provider', 'country', 'currency']).default('month'),
});

/** Region detection — mobile reports the store front, web reports its own guess. */
export const setRegionSchema = z.object({
  country: z.string().length(2).toUpperCase(),
  source: z.enum(['APP_STORE', 'PLAY_STORE', 'WEB_GEO', 'IP', 'MANUAL']),
  /** Apple/Google storefront identifier, kept for audit. */
  storefront: z.string().max(40).optional(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type VerifyStorePurchaseInput = z.infer<typeof verifyStorePurchaseSchema>;
export type SetRegionInput = z.infer<typeof setRegionSchema>;

/**
 * Changing country after signup is destructive: the food catalog is per-country
 * so the selected meals no longer exist, and every amount in the app is
 * denominated in the country's currency. The client previews the consequences,
 * shows them, and only then sends `confirm: true`.
 */
export const changeCountrySchema = z.object({
  country: z.string().length(2).toUpperCase(),
  source: z.enum(['APP_STORE', 'PLAY_STORE', 'WEB_GEO', 'IP', 'MANUAL']).default('MANUAL'),
  confirm: z.boolean().default(false),
});

/** Landing-page pricing. `country` lets a visitor override what the edge guessed. */
export const publicPlansQuerySchema = z.object({
  country: z.string().length(2).toUpperCase().optional(),
});
