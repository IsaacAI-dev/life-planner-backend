import { z } from 'zod';
import { dateString } from './common.js';

const budgetCategoryEnum = z.enum(['MANDATORY', 'SECONDARY', 'OPTIONAL']);

export const budgetMonthParamsSchema = z.object({
  year: z.coerce.number().int().min(1970).max(3000),
  month: z.coerce.number().int().min(1).max(12),
});

/**
 * A month is now just a container — income lives in BudgetIncome rows, because
 * one figure cannot represent a salary plus three clients.
 */
export const upsertBudgetMonthSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
});

export const createBudgetExpenseSchema = z.object({
  status: z.enum(['COMMITTED', 'PAID']).default('COMMITTED'),
  title: z.string().trim().min(1).max(120),
  amount: z.number().positive().max(999_999_999.99),
  category: budgetCategoryEnum,
  date: dateString.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const updateBudgetExpenseSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    amount: z.number().positive().max(999_999_999.99).optional(),
    category: budgetCategoryEnum.optional(),
    date: dateString.optional().nullable(),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const budgetCategoryQuerySchema = z.object({
  category: budgetCategoryEnum.optional(),
});

export type UpsertBudgetMonthInput = z.infer<typeof upsertBudgetMonthSchema>;
export type CreateBudgetExpenseInput = z.infer<typeof createBudgetExpenseSchema>;

/** Backs the "copy from a recent month" chooser on the first-run screen. */
export const recentMonthsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(12).default(3),
});
