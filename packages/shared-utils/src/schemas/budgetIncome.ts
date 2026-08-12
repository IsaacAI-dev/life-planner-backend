import { z } from 'zod';
import { dateString } from './common.js';

const money = z.number().positive().max(999_999_999).multipleOf(0.01);

export const createIncomeSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
    source: z.string().trim().max(120).optional(),
    amount: money,
    /**
     * Defaults to PROJECTED. Pass ARRIVED when logging money that has already
     * landed, so the person is not forced through a two-step create-then-mark.
     */
    status: z.enum(['PROJECTED', 'ARRIVED']).default('PROJECTED'),
    expectedDate: dateString.optional(),
    receivedAt: dateString.optional(),
    /** Materialises copies into the next few months as PROJECTED. */
    recurring: z.boolean().default(false),
  })
  .refine((v) => v.status !== 'ARRIVED' || v.amount > 0, {
    message: 'An arrived income must have an amount',
  });

export const updateIncomeSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    source: z.string().trim().max(120).nullable().optional(),
    amount: money.optional(),
    expectedDate: dateString.nullable().optional(),
    /** Status changes go through the dedicated endpoints, not a blind PATCH. */
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

/** Flip to ARRIVED, optionally back-dating when the money actually landed. */
export const markIncomeArrivedSchema = z.object({
  receivedAt: dateString.optional(),
});

/**
 * Roll a slipped income into a later month. The original is marked DEFERRED
 * rather than moved, so the month it missed still reads honestly.
 */
export const rollIncomeSchema = z
  .object({
    year: z.number().int().min(2000).max(2100),
    month: z.number().int().min(1).max(12),
    /** Optional new expectation for the target month. */
    expectedDate: dateString.optional(),
  })
  .strict();

export const incomeQuerySchema = z.object({
  status: z.enum(['PROJECTED', 'ARRIVED', 'DEFERRED', 'CANCELLED']).optional(),
  /** Convenience filter for the "what do I actually have?" view. */
  arrivedOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const ledgerQuerySchema = z.object({
  status: z.enum(['PROJECTED', 'ARRIVED', 'DEFERRED', 'CANCELLED']).optional(),
  expenseStatus: z.enum(['COMMITTED', 'PAID']).optional(),
  category: z.enum(['MANDATORY', 'SECONDARY', 'OPTIONAL']).optional(),
});

export const markExpensePaidSchema = z.object({
  paidAt: dateString.optional(),
});

/** Copy the previous month's recurring-ish lines into a fresh month. */
export const copyMonthSchema = z.object({
  fromYear: z.number().int().min(2000).max(2100),
  fromMonth: z.number().int().min(1).max(12),
  includeIncomes: z.boolean().default(true),
  includeExpenses: z.boolean().default(true),
  /** Copied incomes land as PROJECTED and expenses as COMMITTED, never paid. */
});

export type CreateIncomeInput = z.infer<typeof createIncomeSchema>;
export type RollIncomeInput = z.infer<typeof rollIncomeSchema>;
