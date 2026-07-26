import {
  AppError,
  isValidRRule,
  type CreateRecurringInput,
  type UpdateRecurringInput,
} from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

export function listRecurring(userId: string) {
  return prisma.recurringTemplate.findMany({
    where: { userId },
    include: { category: { select: { id: true, name: true, color: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export function createRecurring(userId: string, input: CreateRecurringInput) {
  if (!isValidRRule(input.rrule)) throw AppError.badRequest('Invalid RRULE');
  return prisma.recurringTemplate.create({
    data: {
      userId,
      title: input.title,
      description: input.description ?? null,
      categoryId: input.categoryId ?? null,
      rrule: input.rrule,
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
    },
  });
}

export async function updateRecurring(userId: string, id: string, input: UpdateRecurringInput) {
  const tpl = await prisma.recurringTemplate.findFirst({ where: { id, userId } });
  if (!tpl) throw AppError.notFound('Template not found');
  if (input.rrule !== undefined && !isValidRRule(input.rrule)) {
    throw AppError.badRequest('Invalid RRULE');
  }
  return prisma.recurringTemplate.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.rrule !== undefined ? { rrule: input.rrule } : {}),
      ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
}

/** Deactivating/deleting stops future materialization but keeps created activities. */
export async function deleteRecurring(userId: string, id: string) {
  const tpl = await prisma.recurringTemplate.findFirst({ where: { id, userId } });
  if (!tpl) throw AppError.notFound('Template not found');
  await prisma.recurringTemplate.update({ where: { id }, data: { active: false } });
}
