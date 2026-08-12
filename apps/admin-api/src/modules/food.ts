import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  createFoodCategorySchema,
  createFoodSchema,
  dateParamSchema,
  foodQuerySchema,
  idParamSchema,
  paginate,
  parseDateOnly,
  respondMealRequestSchema,
  sendOk,
  toDateOnlyString,
  updateFoodSchema,
  upsertMealPlanV3Schema,
} from '@lifeplanner/shared-utils';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentAdmin, requireRoles } from '../middleware/auth.js';
import { publishRealtime, userRoom } from '../lib/realtime.js';

export const adminFoodCatalogRouter = Router();
export const adminUserFoodRouter = Router();
export const adminMealRequestsRouter = Router();

const userIdParamsSchema = z.object({ id: z.string().min(1) });
const userDateParamsSchema = z.object({ id: z.string().min(1), date: dateParamSchema.shape.date });

/** Nutrition work belongs to the fitness side; oversight can always step in. */
const nutritionRoles = requireRoles('FITNESS_ADMIN', 'MANAGER', 'SUPERADMIN');

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
  active: true,
  categories: { select: { key: true, label: true, color: true } },
} satisfies Prisma.FoodCatalogItemSelect;

const mealPlanInclude = {
  meals: {
    orderBy: { order: 'asc' },
    include: {
      items: { orderBy: { order: 'asc' }, include: { foodItem: { select: foodSelect } } },
    },
  },
} satisfies Prisma.MealPlanInclude;

const serializePlan = (plan: any) => ({ ...plan, date: toDateOnlyString(plan.date as Date) });

/** Resolves category keys to ids, rejecting unknown ones rather than silently dropping. */
async function connectCategories(keys: string[]) {
  const found = await prisma.foodCategoryTag.findMany({
    where: { key: { in: keys } },
    select: { id: true, key: true },
  });
  const missing = keys.filter((k) => !found.some((f) => f.key === k));
  if (missing.length) throw AppError.badRequest(`Unknown food categories: ${missing.join(', ')}`);
  return found.map((f) => ({ id: f.id }));
}

// --- Categories -------------------------------------------------------------

adminFoodCatalogRouter.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const categories = await prisma.foodCategoryTag.findMany({
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      include: { _count: { select: { foods: true } } },
    });
    sendOk(res, {
      categories: categories.map((c) => ({ ...c, foodCount: c._count.foods, _count: undefined })),
    });
  }),
);

adminFoodCatalogRouter.post(
  '/categories',
  nutritionRoles,
  validate(createFoodCategorySchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.foodCategoryTag.findUnique({ where: { key: req.body.key } });
    if (existing) throw AppError.conflict('That category key already exists');
    const category = await prisma.foodCategoryTag.create({ data: req.body });
    sendOk(res, { category }, 201);
  }),
);

adminFoodCatalogRouter.patch(
  '/categories/:id',
  nutritionRoles,
  validate(idParamSchema, 'params'),
  validate(createFoodCategorySchema.partial()),
  asyncHandler(async (req, res) => {
    const category = await prisma.foodCategoryTag.update({
      where: { id: req.params.id },
      data: req.body,
    });
    sendOk(res, { category });
  }),
);

adminFoodCatalogRouter.delete(
  '/categories/:id',
  nutritionRoles,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const inUse = await prisma.foodCatalogItem.count({ where: { categories: { some: { id: req.params.id } } } });
    if (inUse > 0) {
      throw AppError.conflict(`${inUse} food(s) still use this category; reassign them first`);
    }
    await prisma.foodCategoryTag.delete({ where: { id: req.params.id } });
    sendOk(res, { deleted: true });
  }),
);

// --- Foods ------------------------------------------------------------------

adminFoodCatalogRouter.get(
  '/',
  validate(foodQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { country, categoryKey, q, activeOnly, page, pageSize } = req.query as unknown as {
      country?: string;
      categoryKey?: string;
      q?: string;
      activeOnly: boolean;
      page: number;
      pageSize: number;
    };

    const where: Prisma.FoodCatalogItemWhereInput = {
      ...(country ? { country } : {}),
      ...(activeOnly ? { active: true } : {}),
      ...(categoryKey ? { categories: { some: { key: categoryKey } } } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.foodCatalogItem.findMany({
        where,
        select: foodSelect,
        orderBy: [{ country: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.foodCatalogItem.count({ where }),
    ]);

    sendOk(res, paginate(items, page, pageSize, total));
  }),
);

adminFoodCatalogRouter.post(
  '/',
  nutritionRoles,
  validate(createFoodSchema),
  asyncHandler(async (req, res) => {
    const { categoryKeys, ...rest } = req.body;
    const categories = await connectCategories(categoryKeys);

    const existing = await prisma.foodCatalogItem.findUnique({
      where: { country_name: { country: rest.country, name: rest.name } },
    });
    if (existing) throw AppError.conflict('That food already exists for this country');

    const item = await prisma.foodCatalogItem.create({
      data: { ...rest, categories: { connect: categories } },
      select: foodSelect,
    });
    sendOk(res, { item }, 201);
  }),
);

adminFoodCatalogRouter.patch(
  '/:id',
  nutritionRoles,
  validate(idParamSchema, 'params'),
  validate(updateFoodSchema),
  asyncHandler(async (req, res) => {
    const { categoryKeys, ...rest } = req.body;
    const item = await prisma.foodCatalogItem.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        // `set` replaces the whole list, so removing a category works.
        ...(categoryKeys ? { categories: { set: await connectCategories(categoryKeys) } } : {}),
      },
      select: foodSelect,
    });
    sendOk(res, { item });
  }),
);

adminFoodCatalogRouter.delete(
  '/:id',
  nutritionRoles,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const inUse = await prisma.mealItem.count({ where: { foodItemId: req.params.id } });
    if (inUse > 0) {
      // Deactivating keeps historic meal plans intact.
      const item = await prisma.foodCatalogItem.update({
        where: { id: req.params.id },
        data: { active: false },
        select: foodSelect,
      });
      sendOk(res, { item, deactivated: true, reason: 'Food is referenced by existing meal plans' });
      return;
    }
    await prisma.foodCatalogItem.delete({ where: { id: req.params.id } });
    sendOk(res, { deleted: true });
  }),
);

// --- Meal plans for a user --------------------------------------------------

adminUserFoodRouter.get(
  '/:id/food-inventory',
  validate(userIdParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const inventory = await prisma.userFoodInventory.findMany({
      where: { userId: req.params.id },
      include: { foodItem: { select: foodSelect } },
    });
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      // Height and year of birth are the calorie/fitness context a coach needs.
      select: { id: true, name: true, country: true, heightCm: true, yearOfBirth: true, gender: true },
    });
    if (!user) throw AppError.notFound('User not found');
    sendOk(res, { user, inventory, foodItems: inventory.map((i) => i.foodItem) });
  }),
);

adminUserFoodRouter.get(
  '/:id/meal-plans',
  validate(userIdParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const mealPlans = await prisma.mealPlan.findMany({
      where: { userId: req.params.id },
      include: mealPlanInclude,
      orderBy: { date: 'desc' },
      take: 60,
    });
    sendOk(res, { mealPlans: mealPlans.map(serializePlan) });
  }),
);

/**
 * Authoring a plan replaces its meals wholesale — simpler and safer than
 * diffing, and a plan is small enough that the write cost is irrelevant.
 */
adminUserFoodRouter.put(
  '/:id/meal-plans/:date',
  nutritionRoles,
  validate(userDateParamsSchema, 'params'),
  validate(upsertMealPlanV3Schema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { meals, status, targetCalories, notes } = req.body;
    const date = parseDateOnly(req.params.date);

    const user = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw AppError.notFound('User not found');

    // Every referenced food must exist, or the plan silently loses items.
    const foodIds = meals.flatMap((m: any) =>
      m.items.map((i: any) => i.foodItemId).filter(Boolean),
    ) as string[];
    if (foodIds.length) {
      const found = await prisma.foodCatalogItem.count({ where: { id: { in: [...new Set(foodIds)] } } });
      if (found !== new Set(foodIds).size) {
        throw AppError.badRequest('One or more foodItemIds do not exist');
      }
    }

    const plan = await prisma.$transaction(async (tx) => {
      const existing = await tx.mealPlan.findUnique({
        where: { userId_date: { userId: user.id, date } },
        select: { id: true, status: true, publishedAt: true },
      });

      const saved = existing
        ? await tx.mealPlan.update({
            where: { id: existing.id },
            data: {
              status,
              targetCalories: targetCalories ?? null,
              notes: notes ?? null,
              // Stamp on transition, and backfill a plan that was published
              // without one — PUBLISHED must never mean publishedAt: null.
              publishedAt:
                status === 'PUBLISHED' && (existing.status !== 'PUBLISHED' || !existing.publishedAt)
                  ? new Date()
                  : undefined,
            },
          })
        : await tx.mealPlan.create({
            data: {
              userId: user.id,
              createdByAdminId: me.id,
              date,
              status,
              targetCalories: targetCalories ?? null,
              notes: notes ?? null,
              publishedAt: status === 'PUBLISHED' ? new Date() : null,
            },
          });

      await tx.meal.deleteMany({ where: { mealPlanId: saved.id } });

      for (const [index, meal] of meals.entries()) {
        await tx.meal.create({
          data: {
            mealPlanId: saved.id,
            name: meal.name ?? null,
            mealTime: meal.mealTime ?? null,
            estimatedCalories: meal.estimatedCalories ?? null,
            notes: meal.notes ?? null,
            order: meal.order ?? index,
            items: {
              create: meal.items.map((item: any, i: number) => ({
                foodItemId: item.foodItemId ?? null,
                freeText: item.freeText ?? null,
                weightGrams: item.weightGrams ?? null,
                servings: item.servings ?? null,
                order: item.order ?? i,
              })),
            },
          },
        });
      }

      return tx.mealPlan.findUniqueOrThrow({ where: { id: saved.id }, include: mealPlanInclude });
    });

    if (status === 'PUBLISHED') {
      await prisma.notification.create({
        data: {
          userId: user.id,
          type: 'MEAL_PLAN_PUBLISHED',
          title: 'Your meal plan is ready',
          body: `A plan for ${req.params.date} has been published.`,
          href: '/nutrition',
        },
      });
      await publishRealtime(userRoom(user.id), 'mealplan:published', { date: req.params.date });
    }

    sendOk(res, { mealPlan: serializePlan(plan) });
  }),
);

adminUserFoodRouter.delete(
  '/:id/meal-plans/:date',
  nutritionRoles,
  validate(userDateParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    await prisma.mealPlan.deleteMany({
      where: { userId: req.params.id, date: parseDateOnly(req.params.date) },
    });
    sendOk(res, { deleted: true });
  }),
);

// --- Meal plan requests (P-18) ----------------------------------------------

adminMealRequestsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) ?? 'PENDING';
    const requests = await prisma.mealPlanRequest.findMany({
      where: { status: status as never },
      include: {
        user: { select: { id: true, name: true, email: true, country: true } },
        handledByAdmin: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    sendOk(res, { requests: requests.map((r) => ({ ...r, date: toDateOnlyString(r.date) })) });
  }),
);

adminMealRequestsRouter.post(
  '/:id/respond',
  nutritionRoles,
  validate(idParamSchema, 'params'),
  validate(respondMealRequestSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const existing = await prisma.mealPlanRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) throw AppError.notFound('Request not found');

    const request = await prisma.mealPlanRequest.update({
      where: { id: existing.id },
      data: {
        status: req.body.status,
        responseNote: req.body.responseNote ?? null,
        handledByAdminId: me.id,
        handledAt: new Date(),
      },
    });

    await prisma.notification.create({
      data: {
        userId: request.userId,
        type: 'MEAL_PLAN_REQUEST_UPDATE',
        title:
          req.body.status === 'FULFILLED'
            ? 'Your meal plan request is ready'
            : 'About your meal plan request',
        body: req.body.responseNote ?? null,
        href: '/nutrition',
      },
    });

    sendOk(res, { request: { ...request, date: toDateOnlyString(request.date) } });
  }),
);
