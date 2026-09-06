import cron from 'node-cron';
// `rrule` ships as CommonJS; a named ESM import fails at runtime under NodeNext.
import rrulePkg, { type RRule as RRuleType } from 'rrule';

const { RRule } = rrulePkg;
import { prisma } from '@lifeplanner/database';
import { addDays, parseDateOnly, toDateOnlyString } from '@lifeplanner/shared-utils';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

interface TemplateLike {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  rrule: string;
  startTime: string | null;
  endTime: string | null;
  categoryId: string | null;
  isPrivate: boolean;
  active: boolean;
}

/**
 * Expands a template's RRULE up to RECURRING_HORIZON_DAYS and creates any
 * missing concrete activities. Idempotent: existing dates are skipped, so the
 * hourly job can run as often as it likes.
 */
export async function materializeTemplate(template: TemplateLike): Promise<number> {
  if (!template.active) return 0;

  const today = parseDateOnly(new Date());
  const horizon = addDays(today, env.RECURRING_HORIZON_DAYS);

  let rule: RRuleType;
  try {
    rule = RRule.fromString(
      template.rrule.startsWith('RRULE:') ? template.rrule : `RRULE:${template.rrule}`,
    );
  } catch (err) {
    logger.warn({ err, templateId: template.id }, 'Skipping template with invalid rrule');
    return 0;
  }

  const occurrences = rule
    .between(today, horizon, true)
    .map((d: Date) => parseDateOnly(toDateOnlyString(d)));
  if (occurrences.length === 0) return 0;

  const existing = await prisma.activity.findMany({
    where: {
      recurringTemplateId: template.id,
      date: { gte: today, lte: horizon },
    },
    select: { date: true },
  });
  const seen = new Set(existing.map((a) => toDateOnlyString(a.date as Date)));

  const toCreate = occurrences.filter((d: Date) => !seen.has(toDateOnlyString(d)));
  if (toCreate.length === 0) return 0;

  await prisma.activity.createMany({
    data: toCreate.map((date: Date) => ({
      userId: template.userId,
      title: template.title,
      description: template.description,
      date,
      startTime: template.startTime,
      endTime: template.endTime,
      categoryId: template.categoryId,
      isPrivate: template.isPrivate,
      recurringTemplateId: template.id,
    })),
  });

  await prisma.recurringTemplate.update({
    where: { id: template.id },
    data: { lastMaterializedAt: new Date(), horizonEnd: horizon },
  });

  return toCreate.length;
}

export async function materializeAll(): Promise<number> {
  const templates = await prisma.recurringTemplate.findMany({ where: { active: true } });
  let created = 0;
  for (const template of templates) {
    created += await materializeTemplate(template);
  }
  if (created > 0) logger.info({ created, templates: templates.length }, 'Recurring activities materialized');
  return created;
}

/** Hourly, on the hour. */
export const startRecurringJob = () =>
  cron.schedule('0 * * * *', () => {
    void materializeAll().catch((err) => logger.error({ err }, 'Recurring materializer failed'));
  });
