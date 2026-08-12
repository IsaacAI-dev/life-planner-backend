import { z } from 'zod';
import { dateString } from './common.js';


export const foodCatalogQuerySchema = z.object({
  country: z.string().length(2).toUpperCase(),
  categoryKey: z.string().trim().max(40).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Admin-side catalog browsing: country is optional so an admin can list everything. */
export const adminFoodCatalogQuerySchema = foodCatalogQuerySchema.extend({
  country: z.string().length(2).toUpperCase().optional(),
});

export const replaceInventorySchema = z.object({
  foodItemIds: z.array(z.string().min(1)).max(200),
});

export const mealPlanRangeQuerySchema = z
  .object({ from: dateString, to: dateString })
  .refine((v) => v.to >= v.from, { message: '`to` must be on or after `from`', path: ['to'] });

export type FoodCatalogQuery = z.infer<typeof foodCatalogQuerySchema>;
export type ReplaceInventoryInput = z.infer<typeof replaceInventorySchema>;
