import jwt, { type SignOptions } from 'jsonwebtoken';
import { createEvents, type EventAttributes } from 'ics';
import { AppError } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';
import { env } from '../../env.js';

/**
 * Calendar feed (§9). The feed URL embeds a long-lived, signed, stateless token
 * so calendar clients (Google/Apple) can poll it without a login. The token is
 * a JWT of type "ical" signed with the access secret. Rotating the access
 * secret invalidates all outstanding feeds (the intended kill-switch); for
 * per-user revocation, swap this for a stored feed-token model.
 */
const ICAL_TTL = '3650d';

interface IcalClaims {
  sub: string;
  type: 'ical';
}

export function signFeedToken(userId: string): string {
  const payload: IcalClaims = { sub: userId, type: 'ical' };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: ICAL_TTL } as SignOptions);
}

export function verifyFeedToken(token: string): string {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof decoded === 'string' || (decoded as IcalClaims).type !== 'ical') {
      throw new Error('bad type');
    }
    return (decoded as IcalClaims).sub;
  } catch {
    throw AppError.unauthorized('Invalid or expired calendar feed token');
  }
}

/** Builds the absolute feed URL from the incoming request's host. */
export function buildFeedUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/api/v1/ical/feed/${token}.ics`;
}

function toDateParts(date: Date): [number, number, number] {
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

function parseHhMm(value: string | null): [number, number] | null {
  if (!value) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** Renders the user's (non-deleted) activities as an .ics document string. */
export async function renderUserCalendar(userId: string): Promise<string> {
  const activities = await prisma.activity.findMany({
    where: { userId, deletedAt: null },
    orderBy: { date: 'asc' },
    select: {
      id: true,
      title: true,
      description: true,
      date: true,
      startTime: true,
      endTime: true,
      isDone: true,
      category: { select: { name: true } },
    },
  });

  const events: EventAttributes[] = activities.map((a) => {
    const [y, mo, d] = toDateParts(a.date);
    const start = parseHhMm(a.startTime);
    const end = parseHhMm(a.endTime);

    const base: EventAttributes = start
      ? { start: [y, mo, d, start[0], start[1]] }
      : { start: [y, mo, d], duration: { days: 1 } }; // all-day

    if (start && end) {
      base.end = [y, mo, d, end[0], end[1]];
    } else if (start) {
      base.duration = { hours: 1 };
    }

    base.uid = `${a.id}@lifeplanner`;
    base.title = a.title;
    const descLines = [a.description ?? '', a.category ? `Category: ${a.category.name}` : '']
      .filter(Boolean)
      .join('\n');
    if (descLines) base.description = descLines;
    base.status = a.isDone ? 'CONFIRMED' : 'TENTATIVE';
    base.productId = 'life-planner';
    base.calName = 'Life Planner';
    return base;
  });

  return new Promise<string>((resolve, reject) => {
    createEvents(events, (error, value) => {
      if (error) {
        reject(AppError.internal('Failed to render calendar feed'));
        return;
      }
      resolve(value ?? '');
    });
  });
}
