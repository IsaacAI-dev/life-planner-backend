import type { Prisma } from '@lifeplanner/database';
import { toDateOnlyString } from '@lifeplanner/shared-utils';

type AnyRecord = Record<string, unknown>;

/** Public shape of a user — never leaks passwordHash. */
export const publicUser = (user: AnyRecord) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  timezone: user.timezone,
  country: user.country ?? null,
  avatarUrl: user.avatarUrl ?? null,
  status: user.status,
  statusReason: user.statusReason ?? null,
  createdAt: user.createdAt,
});

/** Date-only columns come back as Date; the API always speaks "YYYY-MM-DD". */
export const serializeActivity = (activity: AnyRecord) => ({
  ...activity,
  date: activity.date ? toDateOnlyString(activity.date as Date) : null,
  windowStart: activity.windowStart ? toDateOnlyString(activity.windowStart as Date) : null,
  windowEnd: activity.windowEnd ? toDateOnlyString(activity.windowEnd as Date) : null,
  isFlexible: activity.date === null,
});

export const serializeGoal = (goal: AnyRecord) => ({
  ...goal,
  targetDate: goal.targetDate ? toDateOnlyString(goal.targetDate as Date) : null,
  milestones: Array.isArray(goal.milestones)
    ? (goal.milestones as AnyRecord[]).map((m) => ({
        ...m,
        dueDate: m.dueDate ? toDateOnlyString(m.dueDate as Date) : null,
      }))
    : undefined,
});

export const serializeDayNote = (note: AnyRecord) => ({
  ...note,
  date: toDateOnlyString(note.date as Date),
});

export const serializeMealPlan = (plan: AnyRecord) => ({
  ...plan,
  date: toDateOnlyString(plan.date as Date),
});

export const serializeExpense = (expense: AnyRecord) => ({
  ...expense,
  amount: Number(expense.amount as Prisma.Decimal),
  date: expense.date ? toDateOnlyString(expense.date as Date) : null,
});

export const serializeBudgetMonth = (month: AnyRecord) => ({
  ...month,
  // Income lives in BudgetIncome rows now; a month carries no figure of its own.
  expenses: Array.isArray(month.expenses)
    ? (month.expenses as AnyRecord[]).map(serializeExpense)
    : undefined,
  incomes: Array.isArray(month.incomes)
    ? (month.incomes as AnyRecord[]).map((i) => ({
        ...i,
        amount: Number(i.amount as Prisma.Decimal),
        expectedDate: i.expectedDate ? toDateOnlyString(i.expectedDate as Date) : null,
      }))
    : undefined,
});
