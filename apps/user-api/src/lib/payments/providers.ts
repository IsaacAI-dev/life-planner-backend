import crypto from 'node:crypto';
import { AppError, merchantOfRecord, splitTaxInclusive } from '@lifeplanner/shared-utils';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

export type Provider = 'PADDLE' | 'PAYSTACK' | 'APPLE_APP_STORE' | 'GOOGLE_PLAY';
export type Platform = 'WEB' | 'IOS' | 'ANDROID';

export interface CheckoutRequest {
  userId: string;
  email: string;
  name: string;
  tier: 'PRO';
  interval: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  currency: string;
  amount: number;
  country: string | null;
  seats: number;
  providerPriceId: string | null;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CheckoutSession {
  checkoutUrl: string;
  reference: string;
  expiresAt: string | null;
}

/**
 * Normalised money breakdown. Every provider reports these differently; each
 * adapter maps into this one shape so the Transaction row is written in exactly
 * one place and VAT stays separable per jurisdiction.
 */
export interface MoneyBreakdown {
  currency: string;
  grossAmount: number;
  netAmount: number;
  taxAmount: number;
  taxRate: number;
  taxCountry: string | null;
  taxType: string | null;
  taxInclusive: boolean;
  merchantOfRecord: string;
  platformFee: number;
  providerFee: number;
  payoutAmount: number;
  settlementCurrency: string | null;
  settlementAmount: number | null;
  exchangeRate: number | null;
  billingCountry: string | null;
}

export const emptyBreakdown = (currency: string, gross: number, provider: Provider): MoneyBreakdown => ({
  currency,
  grossAmount: gross,
  netAmount: gross,
  taxAmount: 0,
  taxRate: 0,
  taxCountry: null,
  taxType: null,
  taxInclusive: true,
  merchantOfRecord: merchantOfRecord(provider),
  platformFee: 0,
  providerFee: 0,
  payoutAmount: gross,
  settlementCurrency: null,
  settlementAmount: null,
  exchangeRate: null,
  billingCountry: null,
});

const round = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Paddle — web, outside Africa. Paddle is merchant of record, so it registers
// for and remits VAT in every jurisdiction; our payout is net of both.
// ---------------------------------------------------------------------------

export const paddle = {
  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    if (!env.PADDLE_API_KEY) {
      throw AppError.internal('Paddle is not configured on this environment');
    }
    const base =
      env.PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';

    const response = await fetch(`${base}/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PADDLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ price_id: req.providerPriceId, quantity: 1 }],
        customer: { email: req.email, name: req.name },
        custom_data: { userId: req.userId, tier: req.tier, interval: req.interval, seats: req.seats },
        checkout: req.successUrl ? { url: req.successUrl } : undefined,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.error({ status: response.status, body: body.slice(0, 400) }, 'Paddle checkout failed');
      throw AppError.badRequest('Could not start the checkout, please try again');
    }

    const json = (await response.json()) as {
      data: { id: string; checkout?: { url?: string } };
    };
    return {
      checkoutUrl: json.data.checkout?.url ?? '',
      reference: json.data.id,
      expiresAt: null,
    };
  },

  /** Paddle-Signature: ts=…;h1=… over `${ts}:${rawBody}`. */
  verifySignature(rawBody: string, header: string | undefined): boolean {
    if (!env.PADDLE_WEBHOOK_SECRET) return false;
    if (!header) return false;
    const parts = Object.fromEntries(
      header.split(';').map((p) => p.split('=') as [string, string]),
    );
    if (!parts.ts || !parts.h1) return false;
    const expected = crypto
      .createHmac('sha256', env.PADDLE_WEBHOOK_SECRET)
      .update(`${parts.ts}:${rawBody}`)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.h1));
    } catch {
      return false;
    }
  },

  breakdown(details: Record<string, unknown>): MoneyBreakdown {
    const totals = (details.totals ?? {}) as Record<string, string>;
    const payout = (details.payout_totals ?? {}) as Record<string, string>;
    // Paddle reports minor units as strings.
    const minor = (v: string | undefined) => (v ? Number(v) / 100 : 0);
    const currency = (details.currency_code as string) ?? env.BILLING_DEFAULT_CURRENCY;

    const gross = minor(totals.total);
    const tax = minor(totals.tax);
    const fee = minor(totals.fee);
    return {
      currency,
      grossAmount: round(gross),
      netAmount: round(gross - tax),
      taxAmount: round(tax),
      taxRate: gross > tax && gross > 0 ? round((tax / (gross - tax)) * 10000) / 10000 : 0,
      taxCountry: (details.tax_country as string) ?? null,
      taxType: 'VAT',
      taxInclusive: true,
      merchantOfRecord: 'PADDLE',
      platformFee: 0,
      providerFee: round(fee),
      payoutAmount: round(minor(payout.total) || gross - tax - fee),
      settlementCurrency: (payout.currency_code as string) ?? null,
      settlementAmount: payout.total ? round(minor(payout.total)) : null,
      exchangeRate: null,
      billingCountry: (details.billing_country as string) ?? null,
    };
  },
};

// ---------------------------------------------------------------------------
// Paystack — web, inside Africa. We are merchant of record here, so any VAT is
// ours to remit and the fee is a plain processing charge.
// ---------------------------------------------------------------------------

export const paystack = {
  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    if (!env.PAYSTACK_SECRET_KEY) {
      throw AppError.internal('Paystack is not configured on this environment');
    }
    const reference = `lp_${crypto.randomBytes(12).toString('hex')}`;

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: req.email,
        // Paystack works in the minor unit (kobo/pesewas/cents).
        amount: Math.round(req.amount * 100),
        currency: req.currency,
        reference,
        plan: req.providerPriceId ?? undefined,
        callback_url: req.successUrl ?? env.PAYSTACK_CALLBACK_URL,
        metadata: { userId: req.userId, tier: req.tier, interval: req.interval, seats: req.seats },
      }),
    });

    const json = (await response.json()) as {
      status: boolean;
      message?: string;
      data?: { authorization_url: string; reference: string };
    };
    if (!response.ok || !json.status || !json.data) {
      logger.error({ status: response.status, message: json.message }, 'Paystack init failed');
      throw AppError.badRequest('Could not start the checkout, please try again');
    }

    return {
      checkoutUrl: json.data.authorization_url,
      reference: json.data.reference,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  },

  /** x-paystack-signature is HMAC-SHA512 of the raw body with the secret key. */
  verifySignature(rawBody: string, header: string | undefined): boolean {
    if (!env.PAYSTACK_SECRET_KEY || !header) return false;
    const expected = crypto
      .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
    } catch {
      return false;
    }
  },

  breakdown(data: Record<string, unknown>): MoneyBreakdown {
    const currency = (data.currency as string) ?? env.BILLING_DEFAULT_CURRENCY;
    const gross = Number(data.amount ?? 0) / 100;
    const fee = Number(data.fees ?? 0) / 100;
    // Nigerian VAT on digital services is 7.5% and is inclusive of the price.
    const taxRate = currency === 'NGN' ? 0.075 : 0;
    const { netAmount, taxAmount } = splitTaxInclusive(gross, taxRate);
    const authorization = (data.authorization ?? {}) as Record<string, string>;

    return {
      currency,
      grossAmount: round(gross),
      netAmount,
      taxAmount,
      taxRate,
      taxCountry: (authorization.country_code as string) ?? 'NG',
      taxType: taxRate > 0 ? 'VAT' : null,
      taxInclusive: true,
      merchantOfRecord: 'SELF',
      platformFee: 0,
      providerFee: round(fee),
      payoutAmount: round(gross - fee),
      settlementCurrency: currency,
      settlementAmount: round(gross - fee),
      exchangeRate: null,
      billingCountry: (authorization.country_code as string) ?? null,
    };
  },
};

// ---------------------------------------------------------------------------
// Apple / Google — mobile, worldwide. The store is merchant of record, collects
// and remits the tax, and keeps 15–30% commission, so `platformFee` is the
// commission and `payoutAmount` is proceeds.
// ---------------------------------------------------------------------------

export interface StoreVerification {
  valid: boolean;
  productId: string;
  originalTransactionId: string;
  transactionId: string;
  expiresAt: Date | null;
  purchaseDate: Date;
  currency: string | null;
  price: number | null;
  storefront: string | null;
  environment: string;
  raw: unknown;
}

export const appleStore = {
  /**
   * Uses the legacy verifyReceipt endpoint, which still works for auto-renewable
   * subscriptions and needs only the shared secret — App Store Server API would
   * require a signed JWT and a key file, which is a heavier operational setup.
   */
  async verify(receipt: string): Promise<StoreVerification> {
    if (!env.VERIFY_STORE_RECEIPTS) {
      return devVerification(receipt, 'APPLE');
    }
    if (!env.APPLE_SHARED_SECRET) {
      throw AppError.internal('Apple billing is not configured on this environment');
    }

    const call = async (url: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'receipt-data': receipt,
          password: env.APPLE_SHARED_SECRET,
          'exclude-old-transactions': true,
        }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);

    let json = await call('https://buy.itunes.apple.com/verifyReceipt');
    // 21007 = a sandbox receipt sent to production; Apple requires the retry.
    if (json.status === 21007) json = await call('https://sandbox.itunes.apple.com/verifyReceipt');

    if (json.status !== 0) {
      logger.warn({ status: json.status }, 'Apple receipt rejected');
      throw AppError.badRequest('That App Store receipt could not be verified');
    }

    const info = (json.latest_receipt_info as Record<string, string>[] | undefined)?.[0];
    if (!info) throw AppError.badRequest('No subscription found on that receipt');

    return {
      valid: true,
      productId: info.product_id,
      originalTransactionId: info.original_transaction_id,
      transactionId: info.transaction_id,
      expiresAt: info.expires_date_ms ? new Date(Number(info.expires_date_ms)) : null,
      purchaseDate: new Date(Number(info.purchase_date_ms ?? Date.now())),
      currency: null,
      price: null,
      storefront: null,
      environment: (json.environment as string) ?? 'Production',
      raw: json,
    };
  },

  breakdown(currency: string, gross: number, commissionRate: number, country: string | null): MoneyBreakdown {
    // Apple prices are tax-inclusive and Apple remits the tax, so the tax slice
    // is informational for us rather than a liability.
    const commission = round(gross * commissionRate);
    return {
      currency,
      grossAmount: round(gross),
      netAmount: round(gross),
      taxAmount: 0,
      taxRate: 0,
      taxCountry: country,
      taxType: 'REMITTED_BY_APPLE',
      taxInclusive: true,
      merchantOfRecord: 'APPLE',
      platformFee: commission,
      providerFee: 0,
      payoutAmount: round(gross - commission),
      settlementCurrency: currency,
      settlementAmount: round(gross - commission),
      exchangeRate: null,
      billingCountry: country,
    };
  },
};

export const googleStore = {
  async verify(purchaseToken: string, productId: string, packageName?: string): Promise<StoreVerification> {
    if (!env.VERIFY_STORE_RECEIPTS) {
      return devVerification(purchaseToken, 'GOOGLE', productId);
    }
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      throw AppError.internal('Google Play billing is not configured on this environment');
    }

    const accessToken = await googleAccessToken();
    const pkg = packageName ?? env.GOOGLE_PACKAGE_NAME;
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/purchases/subscriptions/${productId}/tokens/${purchaseToken}`;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Google purchase rejected');
      throw AppError.badRequest('That Play Store purchase could not be verified');
    }
    const json = (await response.json()) as Record<string, string>;

    return {
      valid: true,
      productId,
      originalTransactionId: json.orderId ?? purchaseToken,
      transactionId: json.orderId ?? purchaseToken,
      expiresAt: json.expiryTimeMillis ? new Date(Number(json.expiryTimeMillis)) : null,
      purchaseDate: new Date(Number(json.startTimeMillis ?? Date.now())),
      currency: json.priceCurrencyCode ?? null,
      price: json.priceAmountMicros ? Number(json.priceAmountMicros) / 1_000_000 : null,
      storefront: json.countryCode ?? null,
      environment: 'Production',
      raw: json,
    };
  },

  breakdown(currency: string, gross: number, commissionRate: number, country: string | null): MoneyBreakdown {
    const commission = round(gross * commissionRate);
    return {
      currency,
      grossAmount: round(gross),
      netAmount: round(gross),
      taxAmount: 0,
      taxRate: 0,
      taxCountry: country,
      taxType: 'REMITTED_BY_GOOGLE',
      taxInclusive: true,
      merchantOfRecord: 'GOOGLE',
      platformFee: commission,
      providerFee: 0,
      payoutAmount: round(gross - commission),
      settlementCurrency: currency,
      settlementAmount: round(gross - commission),
      exchangeRate: null,
      billingCountry: country,
    };
  },
};

/** Service-account JWT exchange for the Android Publisher API. */
async function googleAccessToken(): Promise<string> {
  const creds = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
    client_email: string;
    private_key: string;
  };
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  ).toString('base64url');

  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(creds.private_key.replace(/\\n/g, '\n'), 'base64url');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });

  if (!response.ok) throw AppError.internal('Could not authenticate with Google Play');
  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}

/** Dev-only shortcut so the mobile purchase flow is testable without store keys. */
function devVerification(token: string, vendor: string, productId = 'pro_monthly'): StoreVerification {
  logger.warn({ vendor }, 'VERIFY_STORE_RECEIPTS is false — accepting receipt without verification');
  const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  return {
    valid: true,
    productId,
    originalTransactionId: id,
    transactionId: id,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    purchaseDate: new Date(),
    currency: env.BILLING_DEFAULT_CURRENCY,
    price: null,
    storefront: null,
    environment: 'Sandbox',
    raw: { dev: true },
  };
}
