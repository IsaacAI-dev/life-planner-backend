import { z } from 'zod';
import { dateString } from './common.js';

/** Foods now carry multiple categories, so the payload takes an array of keys. */
export const createFoodSchema = z.object({
  country: z.string().length(2).toUpperCase(),
  name: z.string().trim().min(1).max(120),
  categoryKeys: z.array(z.string().trim().min(1).max(40)).min(1).max(6),
  caloriesPerServing: z.number().int().min(0).max(10000),
  servingSize: z.string().trim().max(80).optional(),
  proteinG: z.number().nonnegative().max(1000).optional(),
  carbsG: z.number().nonnegative().max(1000).optional(),
  fatG: z.number().nonnegative().max(1000).optional(),
  imageUrl: z.string().url().max(500).optional(),
  active: z.boolean().default(true),
});

export const updateFoodSchema = createFoodSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const foodQuerySchema = z.object({
  country: z.string().length(2).toUpperCase().optional(),
  categoryKey: z.string().trim().max(40).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  activeOnly: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const createFoodCategorySchema = z.object({
  key: z.string().trim().min(1).max(40).toUpperCase(),
  label: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).default('#64748B'),
  sortOrder: z.number().int().min(0).default(0),
});

/**
 * A meal is a food combo. Weight, calories and time of day are all optional
 * per the brief — a coach can jot "Dinner: rice and stew" and refine it later.
 */
const mealItemSchema = z
  .object({
    foodItemId: z.string().min(1).optional(),
    freeText: z.string().trim().max(200).optional(),
    weightGrams: z.number().positive().max(10000).optional(),
    servings: z.number().positive().max(50).optional(),
    order: z.number().int().min(0).default(0),
  })
  .refine((v) => Boolean(v.foodItemId) !== Boolean(v.freeText), {
    message: 'Provide exactly one of foodItemId or freeText',
  });

export const mealSchema = z.object({
  name: z.string().trim().max(120).optional(),
  mealTime: z
    .enum([
      'BREAKFAST',
      'MID_MORNING_SNACK',
      'LUNCH',
      'AFTERNOON_SNACK',
      'DINNER',
      'EVENING_SNACK',
      'OTHER',
    ])
    .optional(),
  estimatedCalories: z.number().int().min(0).max(20000).optional(),
  notes: z.string().trim().max(1000).optional(),
  order: z.number().int().min(0).default(0),
  items: z.array(mealItemSchema).min(1).max(30),
});

export const upsertMealPlanV3Schema = z.object({
  status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
  targetCalories: z.number().int().min(0).max(20000).optional(),
  notes: z.string().trim().max(2000).optional(),
  meals: z.array(mealSchema).max(12),
});

export const createMealSchema = mealSchema;

export const updateMealSchema = mealSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

/** P-18 */
export const requestMealPlanSchema = z.object({
  date: dateString,
  note: z.string().trim().max(1000).optional(),
});

export const respondMealRequestSchema = z.object({
  status: z.enum(['FULFILLED', 'DECLINED']),
  responseNote: z.string().trim().max(1000).optional(),
});

export type UpsertMealPlanV3Input = z.infer<typeof upsertMealPlanV3Schema>;
export type CreateFoodInput = z.infer<typeof createFoodSchema>;
