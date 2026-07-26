import {
  AppError,
  dateOnly,
  type CreateGoalInput,
  type CreateMilestoneInput,
  type UpdateGoalInput,
} from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

export function listGoals(userId: string) {
  return prisma.goal.findMany({
    where: { userId, deletedAt: null },
    include: { milestones: { orderBy: { order: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getGoal(userId: string, id: string) {
  const goal = await prisma.goal.findFirst({
    where: { id, userId, deletedAt: null },
    include: {
      milestones: { orderBy: { order: 'asc' } },
      activities: { where: { deletedAt: null }, select: { id: true, isDone: true } },
    },
  });
  if (!goal) throw AppError.notFound('Goal not found');

  // progress = done (milestones + activities) / total
  const msTotal = goal.milestones.length;
  const msDone = goal.milestones.filter((m) => m.done).length;
  const actTotal = goal.activities.length;
  const actDone = goal.activities.filter((a) => a.isDone).length;
  const total = msTotal + actTotal;
  const done = msDone + actDone;
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);

  return { ...goal, progress };
}

export function createGoal(userId: string, input: CreateGoalInput) {
  return prisma.goal.create({
    data: {
      userId,
      title: input.title,
      description: input.description ?? null,
      targetDate: input.targetDate ? dateOnly(input.targetDate) : null,
      status: input.status,
    },
  });
}

export async function updateGoal(userId: string, id: string, input: UpdateGoalInput) {
  const goal = await prisma.goal.findFirst({ where: { id, userId, deletedAt: null } });
  if (!goal) throw AppError.notFound('Goal not found');
  return prisma.goal.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.targetDate !== undefined
        ? { targetDate: input.targetDate ? dateOnly(input.targetDate) : null }
        : {}),
    },
  });
}

export async function deleteGoal(userId: string, id: string) {
  const goal = await prisma.goal.findFirst({ where: { id, userId, deletedAt: null } });
  if (!goal) throw AppError.notFound('Goal not found');
  await prisma.goal.update({ where: { id }, data: { deletedAt: new Date() } });
}

export async function addMilestone(userId: string, goalId: string, input: CreateMilestoneInput) {
  const goal = await prisma.goal.findFirst({ where: { id: goalId, userId, deletedAt: null } });
  if (!goal) throw AppError.notFound('Goal not found');
  return prisma.milestone.create({
    data: {
      goalId,
      title: input.title,
      dueDate: input.dueDate ? dateOnly(input.dueDate) : null,
      order: input.order,
    },
  });
}
