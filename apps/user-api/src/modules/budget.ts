import { Router } from 'express';
import { z } from 'zod';
import { Prisma, prisma } from '@lifeplanner/database';
import {
  AppError,
  BUDGET_CATEGORY_COLORS,
  BUDGET_CATEGORY_ORDER,
  budgetCategoryQuerySchema,
  budgetMonthParamsSchema,
  copyMonthSchema,
  createBudgetExpenseSchema,
  createIncomeSchema,
  incomeQuerySchema,
  ledgerQuerySchema,
  recentMonthsQuerySchema,
  markExpensePaidSchema,
  markIncomeArrivedSchema,
  rollIncomeSchema,
  updateIncomeSchema,
  endOfMonth,
  idParamSchema,
  parseDateOnly,
  sendOk,
  startOfMonth,
  toDateOnlyString,
  updateBudgetExpenseSchema,
  upsertBudgetMonthSchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { serializeBudgetMonth, serializeExpense } from '../lib/serializers.js';

export const budgetRouter = Router();

type BudgetCategory = 'MANDATORY' | 'SECONDARY' | 'OPTIONAL';

const monthParams = (req: { params: Record<string, string> }) => ({
  year: Number(req.params.year),
  month: Number(req.params.month),
});

const findMonthOr404 = async (userId: string, year: number, month: number) => {
  const budgetMonth = await prisma.budgetMonth.findUnique({
    where: { userId_year_month: { userId, year, month } },
  });
  if (!budgetMonth) {
    throw AppError.notFound(
      `No budget set for ${year}-${String(month).padStart(2, '0')} yet — create the month first`,
    );
  }
  return budgetMonth;
};

/**
 * How far ahead a recurring income materialises. Three months keeps the ledger
 * useful without letting it run away; the person is not told about the cap
 * because it renews silently whenever they touch the series.
 */
const RECURRING_HORIZON_MONTHS = 3;

/**
 * The budget is single-currency: everything in it is denominated in the money
 * of the country the person is in. Mixing currencies properly would mean
 * storing FX rates per row and picking a reporting currency, which is a much
 * bigger promise than "what landed this month".
 *
 * The code comes from CountryConfig so ops can add a market without a deploy,
 * and falls back to the billing default when the country is unknown.
 */
async function resolveCurrency(country: string | null | undefined): Promise<string> {
  if (country) {
    const config = await prisma.countryConfig.findUnique({
      where: { code: country.toUpperCase() },
      select: { currency: true },
    });
    if (config) return config.currency;
  }
  return env.BILLING_DEFAULT_CURRENCY;
}

const incomeParamsSchema = budgetMonthParamsSchema.extend({ id: z.string().min(1) });

const findIncomeOr404 = async (userId: string, year: number, month: number, id: string) => {
  const income = await prisma.budgetIncome.findFirst({
    where: { id, budgetMonth: { userId, year, month } },
  });
  if (!income) throw AppError.notFound('Income not found');
  return income;
};

/** Expense dates, when given, must fall inside the month they belong to. */
const assertDateInMonth = (date: string | undefined | null, year: number, month: number) => {
  if (!date) return null;
  const parsed = parseDateOnly(date);
  if (parsed < startOfMonth(year, month) || parsed > endOfMonth(year, month)) {
    throw AppError.badRequest('Expense date must fall within the budget month');
  }
  return parsed;
};

// ---------------------------------------------------------------------------
// Month
// ---------------------------------------------------------------------------

budgetRouter.get(
  '/:year/:month',
  validate(budgetMonthParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);

    const budgetMonth = await prisma.budgetMonth.findUnique({
      where: { userId_year_month: { userId: me.id, year, month } },
      include: { expenses: { orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] } },
    });
    if (!budgetMonth) {
      throw AppError.notFound(
        `No budget set for ${year}-${String(month).padStart(2, '0')} yet — set the estimated income first`,
      );
    }

    sendOk(res, { budgetMonth: serializeBudgetMonth(budgetMonth) });
  }),
);

budgetRouter.put(
  '/:year/:month',
  validate(budgetMonthParamsSchema, 'params'),
  validate(upsertBudgetMonthSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const budgetMonth = await prisma.budgetMonth.upsert({
      where: { userId_year_month: { userId: me.id, year, month } },
      update: { notes: req.body.notes ?? undefined },
      create: { userId: me.id, year, month, notes: req.body.notes ?? null },
    });

    sendOk(res, { budgetMonth: serializeBudgetMonth(budgetMonth) });
  }),
);

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

budgetRouter.get(
  '/:year/:month/expenses',
  validate(budgetMonthParamsSchema, 'params'),
  validate(budgetCategoryQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const { category } = req.query as unknown as { category?: BudgetCategory };

    const budgetMonth = await findMonthOr404(me.id, year, month);
    const expenses = await prisma.budgetExpense.findMany({
      where: { budgetMonthId: budgetMonth.id, ...(category ? { category } : {}) },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });

    sendOk(res, {
      expenses: expenses.map((e) => ({
        ...serializeExpense(e),
        color: BUDGET_CATEGORY_COLORS[e.category],
      })),
    });
  }),
);

budgetRouter.post(
  '/:year/:month/expenses',
  validate(budgetMonthParamsSchema, 'params'),
  validate(createBudgetExpenseSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const budgetMonth = await findMonthOr404(me.id, year, month);

    const expense = await prisma.budgetExpense.create({
      data: {
        budgetMonthId: budgetMonth.id,
        title: req.body.title,
        amount: new Prisma.Decimal(req.body.amount),
        category: req.body.category,
        date: assertDateInMonth(req.body.date, year, month),
        notes: req.body.notes ?? null,
      },
    });

    sendOk(
      res,
      { expense: { ...serializeExpense(expense), color: BUDGET_CATEGORY_COLORS[expense.category] } },
      201,
    );
  }),
);

/**
 * Expenses are addressable both ways:
 *   PATCH /budget/expenses/:id            (original)
 *   PATCH /budget/:year/:month/expenses/:id   (matches income, and /paid)
 *
 * Income routes all carry :year/:month, and so do /paid and /unpaid, so the
 * unscoped pair read as an inconsistency to anyone meeting the API cold. Both
 * are kept: the id is unique and ownership-scoped, so the month segment is
 * decorative for lookup — it exists to make the surface uniform.
 */
budgetRouter.patch(
  ['/expenses/:id', '/:year/:month/expenses/:id'],
  validate(idParamSchema, 'params'),
  validate(updateBudgetExpenseSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await prisma.budgetExpense.findFirst({
      where: { id: req.params.id, budgetMonth: { userId: me.id } },
      include: { budgetMonth: { select: { year: true, month: true } } },
    });
    if (!existing) throw AppError.notFound('Expense not found');

    const { amount, date, ...rest } = req.body;
    const expense = await prisma.budgetExpense.update({
      where: { id: existing.id },
      data: {
        ...rest,
        ...(amount === undefined ? {} : { amount: new Prisma.Decimal(amount) }),
        ...(date === undefined
          ? {}
          : { date: assertDateInMonth(date, existing.budgetMonth.year, existing.budgetMonth.month) }),
      },
    });

    sendOk(res, {
      expense: { ...serializeExpense(expense), color: BUDGET_CATEGORY_COLORS[expense.category] },
    });
  }),
);

budgetRouter.delete(
  ['/expenses/:id', '/:year/:month/expenses/:id'],
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await prisma.budgetExpense.findFirst({
      where: { id: req.params.id, budgetMonth: { userId: me.id } },
      select: { id: true },
    });
    if (!existing) throw AppError.notFound('Expense not found');

    await prisma.budgetExpense.delete({ where: { id: existing.id } });
    sendOk(res, { deleted: true });
  }),
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Without ?category=, totalExpenses/estimatedBalance cover everything and
 * byCategory shows all three subtotals. With ?category=X, the totals reflect
 * only X — answering "what's my balance if I only count mandatory spending" —
 * while byCategory still lists all three for context.
 */
budgetRouter.get(
  '/:year/:month/summary',
  validate(budgetMonthParamsSchema, 'params'),
  validate(budgetCategoryQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const { category } = req.query as unknown as { category?: BudgetCategory };

    const budgetMonth = await findMonthOr404(me.id, year, month);

    const grouped = await prisma.budgetExpense.groupBy({
      by: ['category'],
      where: { budgetMonthId: budgetMonth.id },
      _sum: { amount: true },
    });

    const totals = new Map<string, number>(
      grouped.map((g) => [g.category, Number(g._sum.amount ?? 0)]),
    );

    const byCategory = BUDGET_CATEGORY_ORDER.map((c) => ({
      category: c,
      color: BUDGET_CATEGORY_COLORS[c],
      total: totals.get(c) ?? 0,
    }));

    // Income is the sum of its rows now. `estimatedIncome` is kept in the
    // response as an alias of projected + arrived so existing clients do not
    // break on the day they upgrade; /ledger is the endpoint to move to.
    const incomeRows = await prisma.budgetIncome.findMany({
      where: { budgetMonthId: budgetMonth.id, status: { in: ['PROJECTED', 'ARRIVED'] } },
      select: { amount: true, status: true },
    });
    const arrivedIncome =
      Math.round(
        incomeRows
          .filter((i) => i.status === 'ARRIVED')
          .reduce((t, i) => t + Number(i.amount), 0) * 100,
      ) / 100;
    const totalIncome =
      Math.round(incomeRows.reduce((t, i) => t + Number(i.amount), 0) * 100) / 100;

    const totalExpenses = category
      ? (totals.get(category) ?? 0)
      : byCategory.reduce((sum, row) => sum + row.total, 0);

    sendOk(res, {
      year,
      month,
      currency: await resolveCurrency(me.country),
      filteredBy: category ?? null,
      arrivedIncome,
      totalIncome,
      /** @deprecated alias of totalIncome — use GET /ledger. */
      estimatedIncome: totalIncome,
      totalExpenses,
      availableNow: Math.round((arrivedIncome - totalExpenses) * 100) / 100,
      estimatedBalance: Math.round((totalIncome - totalExpenses) * 100) / 100,
      byCategory,
    });
  }),
);

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

const serializeIncome = (income: {
  id: string;
  title: string;
  description: string | null;
  source: string | null;
  amount: Prisma.Decimal;
  status: string;
  expectedDate: Date | null;
  receivedAt: Date | null;
  rolledFromId: string | null;
  recurring: boolean;
  recurrenceKey: string | null;
  createdAt: Date;
}) => ({
  id: income.id,
  title: income.title,
  description: income.description,
  source: income.source,
  amount: Number(income.amount),
  status: income.status,
  expectedDate: income.expectedDate ? toDateOnlyString(income.expectedDate) : null,
  receivedAt: income.receivedAt,
  /// Lets the UI badge a row as "rolled over from last month", and link back
  /// to the month it slipped from.
  rolledOver: income.rolledFromId !== null,
  rolledFromId: income.rolledFromId,
  recurring: income.recurring,
  recurrenceKey: income.recurrenceKey,
  createdAt: income.createdAt,
});

/** Creates the month on demand — nobody should have to "open" a month first. */
const ensureMonth = async (userId: string, year: number, month: number) =>
  prisma.budgetMonth.upsert({
    where: { userId_year_month: { userId, year, month } },
    update: {},
    create: { userId, year, month },
  });

const shiftMonth = (year: number, month: number, by: number) => {
  const zero = year * 12 + (month - 1) + by;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
};

budgetRouter.get(
  '/:year/:month/incomes',
  validate(budgetMonthParamsSchema, 'params'),
  validate(incomeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const { status, arrivedOnly } = req.query as unknown as {
      status?: string;
      arrivedOnly: boolean;
    };
    const budgetMonth = await findMonthOr404(me.id, year, month);

    const incomes = await prisma.budgetIncome.findMany({
      where: {
        budgetMonthId: budgetMonth.id,
        ...(arrivedOnly ? { status: 'ARRIVED' } : status ? { status: status as never } : {}),
      },
      orderBy: [{ status: 'asc' }, { expectedDate: 'asc' }, { createdAt: 'asc' }],
    });

    sendOk(res, { year, month, incomes: incomes.map(serializeIncome) });
  }),
);

budgetRouter.post(
  '/:year/:month/incomes',
  validate(budgetMonthParamsSchema, 'params'),
  validate(createIncomeSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const { recurring, status, expectedDate, receivedAt, ...rest } = req.body;

    const budgetMonth = await ensureMonth(me.id, year, month);
    const recurrenceKey = recurring ? `rec_${Date.now().toString(36)}_${budgetMonth.id.slice(-6)}` : null;

    const income = await prisma.budgetIncome.create({
      data: {
        ...rest,
        budgetMonthId: budgetMonth.id,
        status,
        expectedDate: assertDateInMonth(expectedDate, year, month),
        // Creating something already banked shouldn't need a second call.
        receivedAt: status === 'ARRIVED' ? (receivedAt ? parseDateOnly(receivedAt) : new Date()) : null,
        recurring,
        recurrenceKey,
      },
    });

    // Materialise the next few months as PROJECTED. Silent by design: the
    // person asked for a recurring salary, not a lecture about horizons.
    if (recurring) {
      for (let i = 1; i <= RECURRING_HORIZON_MONTHS; i += 1) {
        const target = shiftMonth(year, month, i);
        const targetMonth = await ensureMonth(me.id, target.year, target.month);
        const duplicate = await prisma.budgetIncome.findFirst({
          where: { budgetMonthId: targetMonth.id, recurrenceKey },
          select: { id: true },
        });
        if (duplicate) continue;

        await prisma.budgetIncome.create({
          data: {
            budgetMonthId: targetMonth.id,
            title: income.title,
            description: income.description,
            source: income.source,
            amount: income.amount,
            status: 'PROJECTED',
            recurring: true,
            recurrenceKey,
            // Keep the same day-of-month expectation where one was given.
            expectedDate: income.expectedDate
              ? new Date(
                  Date.UTC(
                    target.year,
                    target.month - 1,
                    Math.min(
                      income.expectedDate.getUTCDate(),
                      new Date(Date.UTC(target.year, target.month, 0)).getUTCDate(),
                    ),
                  ),
                )
              : null,
          },
        });
      }
    }

    sendOk(res, { income: serializeIncome(income) }, 201);
  }),
);

budgetRouter.patch(
  '/:year/:month/incomes/:id',
  validate(incomeParamsSchema, 'params'),
  validate(updateIncomeSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const existing = await findIncomeOr404(me.id, year, month, req.params.id);
    const { expectedDate, ...rest } = req.body;

    const income = await prisma.budgetIncome.update({
      where: { id: existing.id },
      data: {
        ...rest,
        ...(expectedDate !== undefined
          ? { expectedDate: expectedDate === null ? null : assertDateInMonth(expectedDate, year, month) }
          : {}),
      },
    });
    sendOk(res, { income: serializeIncome(income) });
  }),
);

/** The money landed. */
budgetRouter.post(
  '/:year/:month/incomes/:id/arrived',
  validate(incomeParamsSchema, 'params'),
  validate(markIncomeArrivedSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const existing = await findIncomeOr404(me.id, year, month, req.params.id);

    if (existing.status === 'ARRIVED') {
      throw AppError.badRequest('That income is already marked as arrived');
    }
    if (existing.status === 'DEFERRED') {
      throw AppError.badRequest(
        'That income was rolled into a later month — mark the rolled-over copy as arrived instead',
      );
    }

    const income = await prisma.budgetIncome.update({
      where: { id: existing.id },
      data: {
        status: 'ARRIVED',
        receivedAt: req.body.receivedAt ? parseDateOnly(req.body.receivedAt) : new Date(),
      },
    });
    sendOk(res, { income: serializeIncome(income) });
  }),
);

/** Marked arrived by mistake — reversible, because people mis-tap. */
budgetRouter.post(
  '/:year/:month/incomes/:id/unarrived',
  validate(incomeParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const existing = await findIncomeOr404(me.id, year, month, req.params.id);

    if (existing.status !== 'ARRIVED') {
      throw AppError.badRequest('That income is not marked as arrived');
    }

    const income = await prisma.budgetIncome.update({
      where: { id: existing.id },
      data: { status: 'PROJECTED', receivedAt: null },
    });
    sendOk(res, { income: serializeIncome(income) });
  }),
);

budgetRouter.post(
  '/:year/:month/incomes/:id/cancel',
  validate(incomeParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const existing = await findIncomeOr404(me.id, year, month, req.params.id);

    const income = await prisma.budgetIncome.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED', receivedAt: null },
    });
    sendOk(res, { income: serializeIncome(income) });
  }),
);

/**
 * The client didn't pay this month. The original is marked DEFERRED and stays
 * put; a fresh PROJECTED copy appears in the target month pointing back at it.
 *
 * Moving the row instead would erase the fact that it was expected here and
 * slipped — which is exactly the information that makes the view realistic.
 */
budgetRouter.post(
  '/:year/:month/incomes/:id/roll',
  validate(incomeParamsSchema, 'params'),
  validate(rollIncomeSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const existing = await findIncomeOr404(me.id, year, month, req.params.id);

    if (existing.status === 'ARRIVED') {
      throw AppError.badRequest('That income has already arrived; there is nothing to roll forward');
    }
    if (existing.status === 'DEFERRED') {
      throw AppError.badRequest('That income has already been rolled forward');
    }

    const target = req.body as { year: number; month: number; expectedDate?: string };
    if (target.year * 12 + target.month <= year * 12 + month) {
      throw AppError.badRequest('Income can only be rolled into a later month');
    }

    const result = await prisma.$transaction(async (tx) => {
      const targetMonth = await tx.budgetMonth.upsert({
        where: { userId_year_month: { userId: me.id, year: target.year, month: target.month } },
        update: {},
        create: { userId: me.id, year: target.year, month: target.month },
      });

      const created = await tx.budgetIncome.create({
        data: {
          budgetMonthId: targetMonth.id,
          title: existing.title,
          description: existing.description,
          source: existing.source,
          amount: existing.amount,
          status: 'PROJECTED',
          rolledFromId: existing.id,
          expectedDate: target.expectedDate ? parseDateOnly(target.expectedDate) : null,
        },
      });

      const deferred = await tx.budgetIncome.update({
        where: { id: existing.id },
        data: { status: 'DEFERRED' },
      });

      return { created, deferred };
    });

    sendOk(
      res,
      {
        deferred: serializeIncome(result.deferred),
        created: serializeIncome(result.created),
        movedTo: { year: target.year, month: target.month },
      },
      201,
    );
  }),
);

budgetRouter.delete(
  '/:year/:month/incomes/:id',
  validate(incomeParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const existing = await findIncomeOr404(me.id, year, month, req.params.id);
    await prisma.budgetIncome.delete({ where: { id: existing.id } });
    sendOk(res, { deleted: true, id: existing.id });
  }),
);

// ---------------------------------------------------------------------------
// Expense payment status
// ---------------------------------------------------------------------------

budgetRouter.post(
  '/:year/:month/expenses/:id/paid',
  validate(incomeParamsSchema, 'params'),
  validate(markExpensePaidSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const budgetMonth = await findMonthOr404(me.id, year, month);

    const existing = await prisma.budgetExpense.findFirst({
      where: { id: req.params.id, budgetMonthId: budgetMonth.id },
      select: { id: true },
    });
    if (!existing) throw AppError.notFound('Expense not found');

    const expense = await prisma.budgetExpense.update({
      where: { id: existing.id },
      data: {
        status: 'PAID',
        paidAt: req.body.paidAt ? parseDateOnly(req.body.paidAt) : new Date(),
      },
    });
    sendOk(res, { expense: serializeExpense(expense) });
  }),
);

budgetRouter.post(
  '/:year/:month/expenses/:id/unpaid',
  validate(incomeParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const budgetMonth = await findMonthOr404(me.id, year, month);

    const existing = await prisma.budgetExpense.findFirst({
      where: { id: req.params.id, budgetMonthId: budgetMonth.id },
      select: { id: true },
    });
    if (!existing) throw AppError.notFound('Expense not found');

    const expense = await prisma.budgetExpense.update({
      where: { id: existing.id },
      data: { status: 'COMMITTED', paidAt: null },
    });
    sendOk(res, { expense: serializeExpense(expense) });
  }),
);

// ---------------------------------------------------------------------------
// Ledger — both sides in one call
// ---------------------------------------------------------------------------

/**
 * Everything the budget screen needs in a single request: income rows, expense
 * rows and the totals. The front end filters on status; the server owns the
 * arithmetic so two clients can never disagree about a balance.
 */
budgetRouter.get(
  '/:year/:month/ledger',
  validate(budgetMonthParamsSchema, 'params'),
  validate(ledgerQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const { status, expenseStatus, category } = req.query as unknown as {
      status?: string;
      expenseStatus?: string;
      category?: BudgetCategory;
    };
    /**
     * A ledger is a *view* of a month, not a resource that has to be created
     * first. A month nobody has touched yet is legitimately empty, so this
     * returns 200 with empty lists and zeroed totals rather than 404 — the
     * first-run screen should render an empty budget, not an error.
     */
    const budgetMonth = await prisma.budgetMonth.findUnique({
      where: { userId_year_month: { userId: me.id, year, month } },
      select: { id: true, notes: true },
    });

    if (!budgetMonth) {
      sendOk(res, {
        year,
        month,
        currency: await resolveCurrency(me.country),
        notes: null,
        incomes: [],
        expenses: [],
        totals: {
          arrivedIncome: 0,
          projectedIncome: 0,
          totalIncome: 0,
          deferredIncome: 0,
          totalExpenses: 0,
          paidExpenses: 0,
          outstandingExpenses: 0,
          availableNow: 0,
          projectedBalance: 0,
        },
        byCategory: [],
        counts: { incomes: 0, awaiting: 0, expenses: 0, unpaid: 0 },
        // Lets the client show "start a budget" without a second call.
        started: false,
      });
      return;
    }

    const [incomes, expenses] = await Promise.all([
      prisma.budgetIncome.findMany({
        where: { budgetMonthId: budgetMonth.id, ...(status ? { status: status as never } : {}) },
        orderBy: [{ expectedDate: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.budgetExpense.findMany({
        where: {
          budgetMonthId: budgetMonth.id,
          ...(expenseStatus ? { status: expenseStatus as never } : {}),
          ...(category ? { category } : {}),
        },
        orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    // Totals are computed from every row in the month, never from the filtered
    // list — a filter is a view, not a redefinition of the balance.
    const allIncomes = await prisma.budgetIncome.findMany({
      where: { budgetMonthId: budgetMonth.id },
      select: { amount: true, status: true },
    });
    const allExpenses = await prisma.budgetExpense.findMany({
      where: { budgetMonthId: budgetMonth.id },
      select: { amount: true, status: true, category: true },
    });

    const sum = (rows: { amount: Prisma.Decimal }[]) =>
      Math.round(rows.reduce((t, r) => t + Number(r.amount), 0) * 100) / 100;

    const arrived = allIncomes.filter((i) => i.status === 'ARRIVED');
    const projected = allIncomes.filter((i) => i.status === 'PROJECTED');
    // DEFERRED and CANCELLED are deliberately excluded from every total: the
    // money is not coming this month, and the rolled-forward copy counts in the
    // month it moved to.
    const paid = allExpenses.filter((e) => e.status === 'PAID');

    const arrivedIncome = sum(arrived);
    const projectedIncome = sum(projected);
    const totalExpenses = sum(allExpenses);
    const paidExpenses = sum(paid);

    const byCategory = BUDGET_CATEGORY_ORDER.map((c) => {
      const rows = allExpenses.filter((e) => e.category === c);
      return {
        category: c,
        color: BUDGET_CATEGORY_COLORS[c],
        total: sum(rows),
        paid: sum(rows.filter((r) => r.status === 'PAID')),
      };
    });

    sendOk(res, {
      year,
      month,
      currency: await resolveCurrency(me.country),
      notes: budgetMonth.notes,
      started: true,
      incomes: incomes.map(serializeIncome),
      expenses: expenses.map(serializeExpense),
      totals: {
        arrivedIncome,
        projectedIncome,
        totalIncome: Math.round((arrivedIncome + projectedIncome) * 100) / 100,
        deferredIncome: sum(allIncomes.filter((i) => i.status === 'DEFERRED')),
        totalExpenses,
        paidExpenses,
        outstandingExpenses: Math.round((totalExpenses - paidExpenses) * 100) / 100,
        /// What is actually in hand right now.
        availableNow: Math.round((arrivedIncome - paidExpenses) * 100) / 100,
        /// Where the month lands if everything expected turns up and is paid.
        projectedBalance: Math.round((arrivedIncome + projectedIncome - totalExpenses) * 100) / 100,
      },
      byCategory,
      counts: {
        incomes: allIncomes.length,
        awaiting: projected.length,
        expenses: allExpenses.length,
        unpaid: allExpenses.length - paid.length,
      },
    });
  }),
);

/**
 * Copy a previous month's lines into this one. Incomes land as PROJECTED and
 * expenses as COMMITTED — copying "paid" status forward would assert something
 * that has not happened.
 */
budgetRouter.post(
  '/:year/:month/copy-from',
  validate(budgetMonthParamsSchema, 'params'),
  validate(copyMonthSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { year, month } = monthParams(req);
    const { fromYear, fromMonth, includeIncomes, includeExpenses } = req.body;

    if (fromYear === year && fromMonth === month) {
      throw AppError.badRequest('Choose a different month to copy from');
    }

    const source = await prisma.budgetMonth.findUnique({
      where: { userId_year_month: { userId: me.id, year: fromYear, month: fromMonth } },
      include: { incomes: true, expenses: true },
    });
    if (!source) throw AppError.notFound('There is no budget for the month you are copying from');

    const target = await ensureMonth(me.id, year, month);

    const [incomes, expenses] = await prisma.$transaction([
      prisma.budgetIncome.createMany({
        data:
          includeIncomes
            ? source.incomes
                // A cancelled income was written off; do not resurrect it.
                .filter((i) => i.status !== 'CANCELLED')
                .map((i) => ({
                  budgetMonthId: target.id,
                  title: i.title,
                  description: i.description,
                  source: i.source,
                  amount: i.amount,
                  status: 'PROJECTED' as const,
                }))
            : [],
      }),
      prisma.budgetExpense.createMany({
        data: includeExpenses
          ? source.expenses.map((e) => ({
              budgetMonthId: target.id,
              title: e.title,
              amount: e.amount,
              category: e.category,
              status: 'COMMITTED' as const,
              notes: e.notes,
            }))
          : [],
      }),
    ]);

    sendOk(res, {
      copiedFrom: { year: fromYear, month: fromMonth },
      incomesCopied: incomes.count,
      expensesCopied: expenses.count,
    }, 201);
  }),
);

/**
 * Backs the "re-populate from a recent month" chooser on the first-run budget
 * screen. Without it the client fetches three full ledgers to show two numbers
 * each — three round trips returning far more than is displayed.
 *
 * `recurringIncomes` is what actually carries forward, so it is counted
 * separately from one-off income the person would not want copied blindly.
 */
budgetRouter.get(
  '/recent-months',
  validate(recentMonthsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { limit } = req.query as unknown as { limit: number };

    // Walk back from the current month so gaps still appear, with hasData
    // false — the chooser should show "June (empty)" rather than skipping it.
    const now = new Date();
    const wanted: { year: number; month: number }[] = [];
    for (let i = 1; i <= limit; i += 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      wanted.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
    }

    const months = await prisma.budgetMonth.findMany({
      where: { userId: me.id, OR: wanted },
      select: {
        year: true,
        month: true,
        _count: { select: { expenses: true } },
        incomes: { select: { recurring: true } },
      },
    });

    const byKey = new Map(months.map((m) => [`${m.year}-${m.month}`, m]));

    sendOk(res, {
      months: wanted.map(({ year, month }) => {
        const found = byKey.get(`${year}-${month}`);
        const recurringIncomes = found?.incomes.filter((i) => i.recurring).length ?? 0;
        const expenses = found?._count.expenses ?? 0;
        return {
          year,
          month,
          recurringIncomes,
          incomes: found?.incomes.length ?? 0,
          expenses,
          hasData: Boolean(found) && (found!.incomes.length > 0 || expenses > 0),
        };
      }),
    });
  }),
);
