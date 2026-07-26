import { addDays, dateOnly, expandRRule, formatDate } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * Materializes concrete Activities from active RecurringTemplates out to
 * RECURRING_HORIZON_DAYS. Idempotent: skips dates that already have an activity
 * for the template, and advances `lastRunOn` to the horizon so subsequent runs
 * only fill the newly-exposed tail. The template's `createdAt` anchors DTSTART.
 */
export async function materializeRecurring(): Promise<{ created: number; templates: number }> {
  const today = dateOnly(new Date());
  const horizonEnd = addDays(today, env.RECURRING_HORIZON_DAYS);

  const templates = await prisma.recurringTemplate.findMany({
    where: { active: true },
  });

  let created = 0;
  for (const t of templates) {
    try {
      const anchor = dateOnly(t.createdAt);
      // Resume from the day after the last materialized date, but never before today.
      const fromCandidate = t.lastRunOn ? addDays(dateOnly(t.lastRunOn), 1) : today;
      const after = fromCandidate.getTime() < today.getTime() ? today : fromCandidate;
      if (after.getTime() > horizonEnd.getTime()) continue;

      const occurrences = expandRRule(t.rrule, anchor, after, horizonEnd);
      if (occurrences.length === 0) {
        await prisma.recurringTemplate.update({ where: { id: t.id }, data: { lastRunOn: horizonEnd } });
        continue;
      }

      // Which of these dates already exist for this template?
      const existing = await prisma.activity.findMany({
        where: { templateId: t.id, date: { in: occurrences } },
        select: { date: true },
      });
      const existingKeys = new Set(existing.map((e) => formatDate(e.date)));

      const toCreate = occurrences.filter((d) => !existingKeys.has(formatDate(d)));
      if (toCreate.length > 0) {
        await prisma.activity.createMany({
          data: toCreate.map((date) => ({
            userId: t.userId,
            categoryId: t.categoryId,
            templateId: t.id,
            title: t.title,
            description: t.description,
            date,
            startTime: t.startTime,
            endTime: t.endTime,
          })),
        });
        created += toCreate.length;
      }

      await prisma.recurringTemplate.update({
        where: { id: t.id },
        data: { lastRunOn: horizonEnd },
      });
    } catch (err) {
      logger.error({ err, templateId: t.id }, 'failed to materialize recurring template');
    }
  }

  if (created > 0) logger.info({ created, templates: templates.length }, 'recurring materialization complete');
  return { created, templates: templates.length };
}
