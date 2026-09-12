import { prisma, type Prisma } from '@lifeplanner/database';
import { AppError, ErrorCode, toDateOnlyString } from '@lifeplanner/shared-utils';
import { getEntitlements, PAYMENT_REQUIRED } from './entitlements.js';

/**
 * Everything the nutrition endpoints share. Both the day view and the request
 * queue need to answer "can this person do this, and is something already in
 * flight?", so those questions are asked in one place.
 */

export const foodSelect = {
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

export const mealPlanInclude = {
  meals: {
    orderBy: { order: 'asc' },
    include: {
      items: { orderBy: { order: 'asc' }, include: { foodItem: { select: foodSelect } } },
    },
  },
  createdByAdmin: { select: { id: true, name: true, avatarUrl: true } },
} satisfies Prisma.MealPlanInclude;

/** Calories fall back to the sum of the items when nobody estimated them. */
export const mealCalories = (meal: { estimatedCalories: number | null; items: any[] }): number => {
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

/**
 * `isEditable` is the flag the UI hangs its edit button off: a coach's plan is
 * read-only to the person it was written for unless they explicitly take it
 * over, and saying so here keeps that rule out of the frontend.
 */
export const serializePlan = (plan: any) => ({
  ...plan,
  date: toDateOnlyString(plan.date as Date),
  meals: plan.meals?.map((m: any) => ({ ...m, calories: mealCalories(m) })),
  totalCalories: plan.meals?.reduce((sum: number, m: any) => sum + mealCalories(m), 0) ?? 0,
  isEditable: plan.source === 'USER',
  createdBy:
    plan.source === 'USER'
      ? { kind: 'USER' as const, admin: null }
      : { kind: 'COACH' as const, admin: plan.createdByAdmin ?? null },
});

export const serializeRequest = (request: any) => ({
  ...request,
  date: toDateOnlyString(request.date as Date),
});

/**
 * Only one request may be open at a time. Returning the row rather than a
 * boolean lets the caller tell the person which day they already asked about.
 */
export async function findPendingRequest(userId: string) {
  return prisma.mealPlanRequest.findFirst({
    where: { userId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
}

export const MEAL_PLANS_PAYWALL_MESSAGE =
  'Meal plans are part of Life Planner Pro. Upgrade to ask a coach for a plan or build your own.';

/**
 * Both "Request a plan" and "Create own meal plan" sit behind the same
 * entitlement, so they share one gate and one message. 402 with
 * upgradeRequired is the shape the rest of the paywall already speaks.
 */
export async function assertMealPlansEnabled(userId: string) {
  const entitlements = await getEntitlements(userId);
  if (!entitlements.limits.mealPlansEnabled) {
    throw new AppError(
      PAYMENT_REQUIRED,
      ErrorCode.UPGRADE_REQUIRED,
      MEAL_PLANS_PAYWALL_MESSAGE,
      { upgradeRequired: true, feature: 'mealPlans' },
    );
  }
  return entitlements;
}

/** What the nutrition page may offer, before any day-specific rule applies. */
export async function nutritionCapabilities(userId: string) {
  const [entitlements, pending] = await Promise.all([
    getEntitlements(userId),
    findPendingRequest(userId),
  ]);
  const enabled = entitlements.limits.mealPlansEnabled;

  return {
    tier: entitlements.tier,
    mealPlansEnabled: enabled,
    upgradeRequired: !enabled,
    pendingRequest: pending ? serializeRequest(pending) : null,
    /** False while a request is still open — one at a time, by design. */
    canRequestPlan: enabled && pending === null,
    canCreateOwnPlan: enabled,
    requestBlockedReason: !enabled
      ? ('UPGRADE_REQUIRED' as const)
      : pending
        ? ('REQUEST_PENDING' as const)
        : null,
  };
}

/**
 * Writing a plan replaces its meals wholesale — simpler and safer than diffing,
 * and a plan is small enough that the write cost is irrelevant. Mirrors the
 * coach-side endpoint exactly so the two can never drift apart.
 */
export async function replaceMeals(
  tx: Prisma.TransactionClient,
  mealPlanId: string,
  meals: any[],
): Promise<void> {
  await tx.meal.deleteMany({ where: { mealPlanId } });
  for (const [index, meal] of meals.entries()) {
    await tx.meal.create({
      data: {
        mealPlanId,
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
}

/** Every referenced food must exist, or the plan silently loses items. */
export async function assertFoodsExist(meals: any[]): Promise<void> {
  const ids = [
    ...new Set(
      meals.flatMap((m) => m.items.map((i: any) => i.foodItemId).filter(Boolean)) as string[],
    ),
  ];
  if (ids.length === 0) return;
  const found = await prisma.foodCatalogItem.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw AppError.badRequest('One or more foodItemIds do not exist');
}
