import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  dateParamSchema,
  foodQuerySchema,
  mealPlanRangeQuerySchema,
  paginate,
  parseDateOnly,
  replaceInventorySchema,
  sendOk,
  toDateOnlyString,
} from '@lifeplanner/shared-utils';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';

export const foodCatalogRouter = Router();
export const foodInventoryRouter = Router();
export const mealPlansRouter = Router();

const foodItemParamsSchema = z.object({ foodItemId: z.string().min(1) });

const foodSelect = {
  id: true,
  country: true,
  name: true,
  caloriesPerServing: true,
  servingSize: true,
  proteinG: true,
  carbsG: true,
  fatG: true,
  imageUrl: true,
  categories: { select: { key: true, label: true, color: true } },
} satisfies Prisma.FoodCatalogItemSelect;

const mealPlanInclude = {
  meals: {
    orderBy: { order: 'asc' },
    include: {
      items: { orderBy: { order: 'asc' }, include: { foodItem: { select: foodSelect } } },
    },
  },
  createdByAdmin: { select: { id: true, name: true, avatarUrl: true } },
} satisfies Prisma.MealPlanInclude;

/** Calories fall back to the sum of the items when the coach didn't estimate. */
const mealCalories = (meal: { estimatedCalories: number | null; items: any[] }): number => {
  if (meal.estimatedCalories !== null) return meal.estimatedCalories;
  return Math.round(
    meal.items.reduce((sum, item) => {
      if (!item.foodItem) return sum;
      // Weight wins over servings when both are present.
      const factor =
        item.weightGrams !== null && item.weightGrams !== undefined
          ? item.weightGrams / 100
          : (item.servings ?? 1);
      return sum + item.foodItem.caloriesPerServing * factor;
    }, 0),
  );
};

const serializePlan = (plan: any) => ({
  ...plan,
  date: toDateOnlyString(plan.date as Date),
  meals: plan.meals?.map((m: any) => ({ ...m, calories: mealCalories(m) })),
  totalCalories: plan.meals?.reduce((sum: number, m: any) => sum + mealCalories(m), 0) ?? 0,
});

// ---------------------------------------------------------------------------
// Catalog — country-scoped, admin-managed, multi-category
// ---------------------------------------------------------------------------

foodCatalogRouter.get(
  '/',
  validate(foodQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { country, categoryKey, q, activeOnly, page, pageSize } = req.query as unknown as {
      country?: string;
      categoryKey?: string;
      q?: string;
      activeOnly: boolean;
      page: number;
      pageSize: number;
    };

    // Falls back to the person's own country so the client need not pass it.
    const resolvedCountry = country ?? me.country ?? undefined;

    const where: Prisma.FoodCatalogItemWhereInput = {
      ...(resolvedCountry ? { country: resolvedCountry } : {}),
      ...(activeOnly ? { active: true } : {}),
      ...(categoryKey ? { categories: { some: { key: categoryKey } } } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.foodCatalogItem.findMany({
        where,
        select: foodSelect,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.foodCatalogItem.count({ where }),
    ]);

    sendOk(res, { ...paginate(items, page, pageSize, total), country: resolvedCountry ?? null });
  }),
);

foodCatalogRouter.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const categories = await prisma.foodCategoryTag.findMany({
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
    sendOk(res, { categories });
  }),
);

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

foodInventoryRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const inventory = await prisma.userFoodInventory.findMany({
      where: { userId: me.id },
      include: { foodItem: { select: foodSelect } },
      orderBy: { createdAt: 'asc' },
    });
    sendOk(res, {
      inventory,
      foodItems: inventory.map((i) => i.foodItem),
      count: inventory.length,
    });
  }),
);

foodInventoryRouter.put(
  '/',
  validate(replaceInventorySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const ids: string[] = [...new Set<string>(req.body.foodItemIds)];

    if (ids.length) {
      const found = await prisma.foodCatalogItem.count({ where: { id: { in: ids } } });
      if (found !== ids.length) throw AppError.badRequest('One or more foodItemIds do not exist');
    }

    await prisma.$transaction([
      prisma.userFoodInventory.deleteMany({ where: { userId: me.id, foodItemId: { notIn: ids } } }),
      prisma.userFoodInventory.createMany({
        data: ids.map((foodItemId) => ({ userId: me.id, foodItemId })),
        skipDuplicates: true,
      }),
    ]);

    const inventory = await prisma.userFoodInventory.findMany({
      where: { userId: me.id },
      include: { foodItem: { select: foodSelect } },
    });
    sendOk(res, { inventory, count: inventory.length });
  }),
);

foodInventoryRouter.post(
  '/:foodItemId',
  validate(foodItemParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const item = await prisma.foodCatalogItem.findUnique({ where: { id: req.params.foodItemId } });
    if (!item) throw AppError.notFound('Food item not found');

    const entry = await prisma.userFoodInventory.upsert({
      where: { userId_foodItemId: { userId: me.id, foodItemId: item.id } },
      update: {},
      create: { userId: me.id, foodItemId: item.id },
      include: { foodItem: { select: foodSelect } },
    });
    sendOk(res, { entry }, 201);
  }),
);

foodInventoryRouter.delete(
  '/:foodItemId',
  validate(foodItemParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    await prisma.userFoodInventory.deleteMany({
      where: { userId: me.id, foodItemId: req.params.foodItemId },
    });
    sendOk(res, { removed: true });
  }),
);

// ---------------------------------------------------------------------------
// Meal plans — PUBLISHED only; a DRAFT never reaches the user
// ---------------------------------------------------------------------------

mealPlansRouter.get(
  '/',
  validate(mealPlanRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };

    const mealPlans = await prisma.mealPlan.findMany({
      where: {
        userId: me.id,
        status: 'PUBLISHED',
        date: { gte: parseDateOnly(from), lte: parseDateOnly(to) },
      },
      include: mealPlanInclude,
      orderBy: { date: 'asc' },
    });

    sendOk(res, { mealPlans: mealPlans.map(serializePlan) });
  }),
);

mealPlansRouter.get(
  '/:date',
  validate(dateParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const mealPlan = await prisma.mealPlan.findFirst({
      where: { userId: me.id, date: parseDateOnly(req.params.date), status: 'PUBLISHED' },
      include: mealPlanInclude,
    });
    if (!mealPlan) throw AppError.notFound('No published meal plan for that day');
    sendOk(res, { mealPlan: serializePlan(mealPlan) });
  }),
);
