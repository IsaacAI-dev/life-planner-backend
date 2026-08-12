import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  adminContentQuerySchema,
  adminMealPlanQuerySchema,
  adminPlanQuerySchema,
  paginate,
  sendOk,
  toDateOnlyString,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { requireOversight } from '../middleware/auth.js';

/**
 * The console's read-only content tables: activities, goals, flexible tasks,
 * budgets, meal plans and the plan catalog.
 *
 * Oversight-only. These cross every user boundary at once — including private
 * activities — so they are not something a coach should be able to browse.
 * Everything is paginated; none of these tables can be loaded whole.
 */
export const consoleRouter = Router();

consoleRouter.use(requireOversight);

type ContentQuery = {
  q?: string;
  userEmail?: string;
  country?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
};

/** Shared user filter for every content table. */
const userFilter = (q: ContentQuery): Prisma.UserWhereInput | undefined => {
  const filter: Prisma.UserWhereInput = {
    ...(q.userEmail ? { email: { contains: q.userEmail, mode: 'insensitive' } } : {}),
    ...(q.country ? { country: q.country } : {}),
  };
  return Object.keys(filter).length ? filter : undefined;
};

const dateRange = (from?: string, to?: string) =>
  from || to
    ? {
        ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
        ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
      }
    : undefined;

const ownerSelect = {
  select: { id: true, name: true, email: true, country: true },
};

// --- Activities -------------------------------------------------------------

consoleRouter.get(
  '/activities',
  validate(adminContentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ContentQuery;
    const range = dateRange(q.from, q.to);

    const where: Prisma.ActivityWhereInput = {
      deletedAt: null,
      // A dated activity, not a flexible one — those have their own table.
      date: range ? range : { not: null },
      ...(q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}),
      ...(userFilter(q) ? { user: userFilter(q) } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        select: {
          id: true,
          title: true,
          date: true,
          startTime: true,
          endTime: true,
          isDone: true,
          isPrivate: true,
          createdAt: true,
          category: { select: { name: true, color: true } },
          user: ownerSelect,
        },
        orderBy: { date: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.activity.count({ where }),
    ]);

    sendOk(
      res,
      paginate(
        items.map((a) => ({
          ...a,
          date: a.date ? toDateOnlyString(a.date) : null,
          // The title of a private activity is withheld even here: oversight
          // needs to see that it exists, not what it says.
          title: a.isPrivate ? null : a.title,
        })),
        q.page,
        q.pageSize,
        total,
      ),
    );
  }),
);

// --- Flexible tasks ---------------------------------------------------------

consoleRouter.get(
  '/flexible-tasks',
  validate(adminContentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ContentQuery;

    const where: Prisma.ActivityWhereInput = {
      deletedAt: null,
      date: null,
      ...(q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}),
      ...(userFilter(q) ? { user: userFilter(q) } : {}),
      ...(q.from ? { windowEnd: { gte: new Date(`${q.from}T00:00:00.000Z`) } } : {}),
      ...(q.to ? { windowStart: { lte: new Date(`${q.to}T23:59:59.999Z`) } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        select: {
          id: true,
          title: true,
          windowStart: true,
          windowEnd: true,
          targetCount: true,
          completedCount: true,
          isPrivate: true,
          user: ownerSelect,
        },
        orderBy: { windowStart: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.activity.count({ where }),
    ]);

    sendOk(
      res,
      paginate(
        items.map((a) => ({
          ...a,
          title: a.isPrivate ? null : a.title,
          windowStart: a.windowStart ? toDateOnlyString(a.windowStart) : null,
          windowEnd: a.windowEnd ? toDateOnlyString(a.windowEnd) : null,
          progress: `${a.completedCount}/${a.targetCount}`,
        })),
        q.page,
        q.pageSize,
        total,
      ),
    );
  }),
);

// --- Goals ------------------------------------------------------------------

consoleRouter.get(
  '/goals',
  validate(adminContentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ContentQuery;
    const range = dateRange(q.from, q.to);

    const where: Prisma.GoalWhereInput = {
      deletedAt: null,
      ...(q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}),
      ...(userFilter(q) ? { user: userFilter(q) } : {}),
      ...(range ? { createdAt: range } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.goal.findMany({
        where,
        select: {
          id: true,
          title: true,
          status: true,
          featured: true,
          targetDate: true,
          createdAt: true,
          user: ownerSelect,
          _count: { select: { milestones: true, activities: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.goal.count({ where }),
    ]);

    sendOk(
      res,
      paginate(
        items.map((g) => ({
          ...g,
          targetDate: g.targetDate ? toDateOnlyString(g.targetDate) : null,
          milestones: g._count.milestones,
          linkedActivities: g._count.activities,
          _count: undefined,
        })),
        q.page,
        q.pageSize,
        total,
      ),
    );
  }),
);

// --- Budgets ----------------------------------------------------------------

consoleRouter.get(
  '/budgets',
  validate(adminContentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ContentQuery;

    const where: Prisma.BudgetMonthWhereInput = {
      ...(userFilter(q) ? { user: userFilter(q) } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.budgetMonth.findMany({
        where,
        select: {
          id: true,
          year: true,
          month: true,
          createdAt: true,
          user: ownerSelect,
          incomes: { select: { amount: true, status: true } },
          expenses: { select: { amount: true, status: true } },
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.budgetMonth.count({ where }),
    ]);

    const sum = (rows: { amount: unknown }[]) =>
      Math.round(rows.reduce((t, r) => t + Number(r.amount), 0) * 100) / 100;

    sendOk(
      res,
      paginate(
        items.map((b) => ({
          id: b.id,
          year: b.year,
          month: b.month,
          user: b.user,
          arrivedIncome: sum(b.incomes.filter((i) => i.status === 'ARRIVED')),
          projectedIncome: sum(b.incomes.filter((i) => i.status === 'PROJECTED')),
          totalExpenses: sum(b.expenses),
          paidExpenses: sum(b.expenses.filter((e) => e.status === 'PAID')),
          incomeCount: b.incomes.length,
          expenseCount: b.expenses.length,
          createdAt: b.createdAt,
        })),
        q.page,
        q.pageSize,
        total,
      ),
    );
  }),
);

// --- Meal plans across every user ------------------------------------------

consoleRouter.get(
  '/meal-plans',
  validate(adminMealPlanQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ContentQuery;
    const range = dateRange(q.from, q.to);

    const where: Prisma.MealPlanWhereInput = {
      ...(range ? { date: range } : {}),
      ...(userFilter(q) ? { user: userFilter(q) } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.mealPlan.findMany({
        where,
        select: {
          id: true,
          date: true,
          status: true,
          targetCalories: true,
          user: ownerSelect,
          createdByAdmin: { select: { id: true, name: true } },
          meals: {
            select: {
              mealTime: true,
              estimatedCalories: true,
              items: { select: { servings: true, foodItem: { select: { caloriesPerServing: true } } } },
            },
          },
        },
        orderBy: { date: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.mealPlan.count({ where }),
    ]);

    const calories = (meals: (typeof items)[number]['meals']) =>
      meals.reduce(
        (total, meal) =>
          total +
          (meal.estimatedCalories ??
            meal.items.reduce(
              (t, i) => t + (i.foodItem?.caloriesPerServing ?? 0) * (i.servings ?? 1),
              0,
            )),
        0,
      );

    sendOk(
      res,
      paginate(
        items.map((p) => ({
          id: p.id,
          user: p.user,
          date: toDateOnlyString(p.date),
          // The console's table shows the weekday alongside the date.
          day: p.date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
          status: p.status,
          mealCount: p.meals.length,
          mealTimes: p.meals.map((m) => m.mealTime).filter(Boolean),
          totalCalories: Math.round(calories(p.meals)),
          createdBy: p.createdByAdmin,
        })),
        q.page,
        q.pageSize,
        total,
      ),
    );
  }),
);

// --- Plan catalog with subscriber counts -----------------------------------

consoleRouter.get(
  '/plans',
  validate(adminPlanQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { q, status, country, interval, createdFrom, createdTo, page, pageSize } =
      req.query as unknown as {
        q?: string;
        status?: 'ACTIVE' | 'EXPIRED';
        country?: string;
        interval?: string;
        createdFrom?: string;
        createdTo?: string;
        page: number;
        pageSize: number;
      };
    const range = dateRange(createdFrom, createdTo);

    const where: Prisma.PlanCatalogEntryWhereInput = {
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      // The console labels an inactive plan "Expired".
      ...(status ? { active: status === 'ACTIVE' } : {}),
      ...(country ? { region: country } : {}),
      ...(interval ? { interval: interval as never } : {}),
      ...(range ? { createdAt: range } : {}),
    };

    const [plans, total] = await Promise.all([
      prisma.planCatalogEntry.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.planCatalogEntry.count({ where }),
    ]);

    // Subscribers are counted per (currency, interval, amount) rather than by a
    // foreign key: a Subscription records what was charged, not which catalog
    // row it came from, so prices can change without rewriting history.
    const counts = await prisma.subscription.groupBy({
      by: ['currency', 'interval', 'amount'],
      _count: true,
      where: { tier: 'PRO' },
    });

    const subscribersFor = (currency: string, intervalValue: string, amount: unknown) =>
      counts
        .filter(
          (c) =>
            c.currency === currency &&
            c.interval === intervalValue &&
            Number(c.amount) === Number(amount),
        )
        .reduce((t, c) => t + c._count, 0);

    sendOk(
      res,
      paginate(
        plans.map((p) => ({
          id: p.id,
          name: p.name,
          tier: p.tier,
          interval: p.interval,
          seats: p.seats,
          region: p.region || null,
          currency: p.currency,
          amount: Number(p.amount),
          features: p.features,
          description: p.description,
          privacyNote: p.privacyNote,
          status: p.active ? 'ACTIVE' : 'EXPIRED',
          subscribers: subscribersFor(p.currency, p.interval, p.amount),
          createdAt: p.createdAt,
        })),
        page,
        pageSize,
        total,
      ),
    );
  }),
);
