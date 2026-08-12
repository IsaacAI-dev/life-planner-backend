import { z } from 'zod';

const email = z.string().trim().email().toLowerCase().max(200);

/**
 * Called before checkout. The payer must name their beneficiaries up front so
 * we can refuse the sale rather than take money and fail to deliver a seat.
 */
export const validateBeneficiariesSchema = z.object({
  emails: z.array(email).min(1).max(2),
});

export const seatCheckoutSchema = z.object({
  tier: z.literal('PRO'),
  interval: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL']).default('MONTHLY'),
  platform: z.enum(['WEB', 'IOS', 'ANDROID']).default('WEB'),
  /// 1 = solo. Must match beneficiaryEmails.length + 1.
  seats: z.number().int().min(1).max(3).default(1),
  beneficiaryEmails: z.array(email).max(2).default([]),
  /**
   * The client sets this after showing the person which beneficiaries have no
   * account yet and will be emailed an invitation.
   */
  acknowledgeInvites: z.boolean().default(false),
  country: z.string().length(2).toUpperCase().optional(),
  successUrl: z.string().url().max(500).optional(),
  cancelUrl: z.string().url().max(500).optional(),
});

export const inviteSeatSchema = z.object({ email });

export const claimSeatSchema = z.object({
  token: z.string().min(16).max(200),
});

export const changeSeatsSchema = z.object({
  seats: z.number().int().min(1).max(3),
});

export const upsertCountryConfigSchema = z.object({
  code: z.string().length(2).toUpperCase(),
  name: z.string().trim().min(1).max(80),
  currency: z.string().length(3).toUpperCase(),
  defaultProvider: z
    .enum(['PADDLE', 'PAYSTACK', 'APPLE_APP_STORE', 'GOOGLE_PLAY'])
    .nullable()
    .optional(),
  taxRate: z.number().min(0).max(1).default(0),
  taxType: z.string().trim().max(20).nullable().optional(),
  taxInclusive: z.boolean().default(true),
  active: z.boolean().default(true),
});

export type SeatCheckoutInput = z.infer<typeof seatCheckoutSchema>;
export type ValidateBeneficiariesInput = z.infer<typeof validateBeneficiariesSchema>;
