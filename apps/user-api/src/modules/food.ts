import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  ErrorCode,
  dateParamSchema,
  foodQuerySchema,
  mealPlanRangeQuerySchema,
  paginate,
  parseDateOnly,
  replaceInventorySchema,
  sendOk,
  toDateOnlyString,
  updateUserMealPlanSchema,
  upsertUserMealPlanSchema,
} from '@lifeplanner/shared-utils';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import {
  assertFoodsExist,
  assertMealPlansEnabled,
  foodSelect,
  mealPlanInclude,
  nutritionCapabilities,
  replaceMeals,
  serializePlan,
} from '../lib/mealPlans.js';

export const foodCatalogRouter = Router();
export const foodInventoryRouter = Router();
export const mealPlansRouter = Router();

const foodItemParamsSchema = z.object({ foodItemId: z.string().min(1) });

// ---------------------------------------------------------------------------
// Catalog — country-scoped, admin-managed, multi-category
// ---------------------------------------------------------------------------

foodCatalogRouter.get(
  '/',
  validate(foodQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { country, categoryKey, q, activeOnly, inventoryOnly, page, pageSize } =
      req.query as unknown as {
        country?: string;
        categoryKey?: string;
        q?: string;
        activeOnly: boolean;
        inventoryOnly?: boolean;
        page: number;
        pageSize: number;
      };

    // Falls back to the person's own country so the client need not pass it.
    const resolvedCountry = country ?? me.country ?? undefined;

    /**
     * Addendum 5 §3 — "Foods I have" is a checklist, so the catalog has to say
     * which rows are already ticked. The whole inventory is read up front: it
     * is one small row per food and it makes the flag correct on every page of
     * results, not just the page that happens to contain a selected item.
     */
    const inventory = await prisma.userFoodInventory.findMany({
      where: { userId: me.id },
      select: { foodItemId: true },
    });
    const selectedIds = new Set(inventory.map((i) => i.foodItemId));

    const where: Prisma.FoodCatalogItemWhereInput = {
      ...(resolvedCountry ? { country: resolvedCountry } : {}),
      ...(activeOnly ? { active: true } : {}),
      ...(categoryKey ? { categories: { some: { key: categoryKey } } } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      ...(inventoryOnly ? { id: { in: [...selectedIds] } } : {}),
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

    const flagged = items.map((item) => ({ ...item, inInventory: selectedIds.has(item.id) }));

    sendOk(res, {
      ...paginate(flagged, page, pageSize, total),
      country: resolvedCountry ?? null,
      // The full set, so a checkbox on page 4 still renders correctly.
      selectedFoodItemIds: [...selectedIds],
      selectedCount: selectedIds.size,
    });
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

const inventoryPayload = async (userId: string) => {
  const inventory = await prisma.userFoodInventory.findMany({
    where: { userId },
    include: { foodItem: { select: foodSelect } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    inventory,
    foodItems: inventory.map((i) => ({ ...i.foodItem, inInventory: true })),
    // The id list the catalog checkboxes bind to.
    foodItemIds: inventory.map((i) => i.foodItemId),
    count: inventory.length,
  };
};

foodInventoryRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    sendOk(res, await inventoryPayload(currentUser(req).id));
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

    sendOk(res, await inventoryPayload(me.id));
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
    sendOk(res, { entry, ...(await inventoryPayload(me.id)) }, 201);
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
    sendOk(res, { removed: true, ...(await inventoryPayload(me.id)) });
  }),
);

// ---------------------------------------------------------------------------
// Meal plans
//
// A person sees every PUBLISHED plan plus any draft of their own — a coach's
// draft is still invisible until it is published.
// ---------------------------------------------------------------------------

const visibleToOwner = (userId: string): Prisma.MealPlanWhereInput => ({
  userId,
  OR: [{ status: 'PUBLISHED' }, { source: 'USER' }],
});

mealPlansRouter.get(
  '/',
  validate(mealPlanRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };

    const mealPlans = await prisma.mealPlan.findMany({
      where: {
        ...visibleToOwner(me.id),
        date: { gte: parseDateOnly(from), lte: parseDateOnly(to) },
      },
      include: mealPlanInclude,
      orderBy: { date: 'asc' },
    });

    sendOk(res, { mealPlans: mealPlans.map(serializePlan) });
  }),
);

/**
 * The nutrition page's day view. Always 200, because "no plan for this day" is
 * an ordinary state with its own empty-state card, not an error — and because
 * the same call has to tell the page whether the Request and Create buttons
 * should be live.
 *
 * Registered before /:date so the literal segment wins the match.
 */
mealPlansRouter.get(
  '/day/:date',
  validate(dateParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const date = parseDateOnly(req.params.date);

    const [mealPlan, request, capabilities] = await Promise.all([
      prisma.mealPlan.findFirst({
        where: { ...visibleToOwner(me.id), date },
        include: mealPlanInclude,
      }),
      prisma.mealPlanRequest.findUnique({
        where: { userId_date: { userId: me.id, date } },
      }),
      nutritionCapabilities(me.id),
    ]);

    sendOk(res, {
      date: req.params.date,
      mealPlan: mealPlan ? serializePlan(mealPlan) : null,
      // The request for this specific day, whatever its status.
      request: request ? { ...request, date: toDateOnlyString(request.date) } : null,
      ...capabilities,
    });
  }),
);

mealPlansRouter.get(
  '/:date',
  validate(dateParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const mealPlan = await prisma.mealPlan.findFirst({
      where: { ...visibleToOwner(me.id), date: parseDateOnly(req.params.date) },
      include: mealPlanInclude,
    });
    if (!mealPlan) throw AppError.notFound('No meal plan for that day');
    sendOk(res, { mealPlan: serializePlan(mealPlan) });
  }),
);

// ---------------------------------------------------------------------------
// Building your own plan — Addendum 5 §3, Pro only
// ---------------------------------------------------------------------------

mealPlansRouter.put(
  '/:date',
  validate(dateParamSchema, 'params'),
  validate(upsertUserMealPlanSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    await assertMealPlansEnabled(me.id);

    const { meals, status, targetCalories, notes, takeOver } = req.body;
    const date = parseDateOnly(req.params.date);

    await assertFoodsExist(meals);

    const existing = await prisma.mealPlan.findUnique({
      where: { userId_date: { userId: me.id, date } },
      select: { id: true, source: true, status: true, publishedAt: true },
    });

    /**
     * A coach's plan is not silently overwritten. Taking it over is allowed —
     * it is the person's own nutrition — but only when they say so explicitly,
     * so a stray autosave can never wipe out work they asked for.
     */
    if (existing && existing.source === 'COACH' && !takeOver) {
      throw AppError.conflict(
        'A coach wrote the plan for this day. Send takeOver: true to make it yours, or pick another day.',
        ErrorCode.PLAN_NOT_EDITABLE,
        { source: 'COACH', date: req.params.date },
      );
    }

    const plan = await prisma.$transaction(async (tx) => {
      const saved = existing
        ? await tx.mealPlan.update({
            where: { id: existing.id },
            data: {
              source: 'USER',
              // Authorship moves with the plan once it has been taken over.
              createdByAdminId: null,
              status,
              targetCalories: targetCalories ?? null,
              notes: notes ?? null,
              publishedAt:
                status === 'PUBLISHED' && (existing.status !== 'PUBLISHED' || !existing.publishedAt)
                  ? new Date()
                  : undefined,
            },
          })
        : await tx.mealPlan.create({
            data: {
              userId: me.id,
              source: 'USER',
              createdByAdminId: null,
              date,
              status,
              targetCalories: targetCalories ?? null,
              notes: notes ?? null,
              publishedAt: status === 'PUBLISHED' ? new Date() : null,
            },
          });

      await replaceMeals(tx, saved.id, meals);
      return tx.mealPlan.findUniqueOrThrow({ where: { id: saved.id }, include: mealPlanInclude });
    });

    sendOk(res, { mealPlan: serializePlan(plan) }, existing ? 200 : 201);
  }),
);

/** Light edits — a note, a calorie target — without resending every meal. */
mealPlansRouter.patch(
  '/:date',
  validate(dateParamSchema, 'params'),
  validate(updateUserMealPlanSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    await assertMealPlansEnabled(me.id);

    const existing = await prisma.mealPlan.findUnique({
      where: { userId_date: { userId: me.id, date: parseDateOnly(req.params.date) } },
      select: { id: true, source: true, status: true, publishedAt: true },
    });
    if (!existing) throw AppError.notFound('No meal plan for that day');
    if (existing.source !== 'USER') {
      throw AppError.conflict(
        'This plan was written by a coach and cannot be edited directly.',
        ErrorCode.PLAN_NOT_EDITABLE,
        { source: existing.source },
      );
    }

    const { status, targetCalories, notes } = req.body;
    const plan = await prisma.mealPlan.update({
      where: { id: existing.id },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(targetCalories !== undefined ? { targetCalories } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(status === 'PUBLISHED' && !existing.publishedAt ? { publishedAt: new Date() } : {}),
      },
      include: mealPlanInclude,
    });

    sendOk(res, { mealPlan: serializePlan(plan) });
  }),
);

/** Only your own plans. Deleting a coach's plan is a conversation, not a button. */
mealPlansRouter.delete(
  '/:date',
  validate(dateParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    await assertMealPlansEnabled(me.id);

    const existing = await prisma.mealPlan.findUnique({
      where: { userId_date: { userId: me.id, date: parseDateOnly(req.params.date) } },
      select: { id: true, source: true },
    });
    if (!existing) throw AppError.notFound('No meal plan for that day');
    if (existing.source !== 'USER') {
      throw AppError.conflict(
        'This plan was written by a coach and cannot be deleted here.',
        ErrorCode.PLAN_NOT_EDITABLE,
        { source: existing.source },
      );
    }

    await prisma.mealPlan.delete({ where: { id: existing.id } });
    sendOk(res, { deleted: true });
  }),
);
