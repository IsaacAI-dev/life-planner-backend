import { dateOnly, type UpsertDayNoteInput } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

export function getDayNote(userId: string, date: string) {
  return prisma.dayNote.findFirst({ where: { userId, date: dateOnly(date), deletedAt: null } });
}

export function upsertDayNote(userId: string, date: string, input: UpsertDayNoteInput) {
  const d = dateOnly(date);
  return prisma.dayNote.upsert({
    where: { userId_date: { userId, date: d } },
    create: { userId, date: d, content: input.content, mood: input.mood ?? null, deletedAt: null },
    update: { content: input.content, mood: input.mood ?? null, deletedAt: null },
  });
}

export async function deleteDayNote(userId: string, date: string) {
  await prisma.dayNote.updateMany({
    where: { userId, date: dateOnly(date), deletedAt: null },
    data: { deletedAt: new Date() },
  });
}
