import {
  AppError,
  hashPassword,
  type CreateAdminInput,
  type ListUsersQuery,
  type PublicAdmin,
  type PublicSubscription,
  type SuspendUserInput,
} from '@life-planner/shared-utils';
import { prisma, type Prisma, type Subscription, type User } from '@life-planner/database';

type SuspensionWire = {
  suspended: boolean;
  suspendedAt: string | null;
  suspendedUntil: string | null;
  suspensionReason: string | null;
};

/** A subscription grants access while ACTIVE and within its paid period. */
function isLive(s: Pick<Subscription, 'status' | 'currentPeriodEnd'> | null | undefined): boolean {
  return !!s && s.status === 'ACTIVE' && s.currentPeriodEnd > new Date();
}

function toSubscriptionWire(s: Subscription | null | undefined): PublicSubscription | null {
  if (!s) return null;
  return {
    plan: s.plan,
    status: s.status,
    currentPeriodStart: s.currentPeriodStart.toISOString(),
    currentPeriodEnd: s.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    canceledAt: s.canceledAt ? s.canceledAt.toISOString() : null,
  };
}

function toSuspensionWire(
  u: Pick<User, 'suspendedAt' | 'suspendedUntil' | 'suspensionReason'>,
): SuspensionWire {
  const suspended = !!u.suspendedAt && (!u.suspendedUntil || u.suspendedUntil > new Date());
  return {
    suspended,
    suspendedAt: u.suspendedAt ? u.suspendedAt.toISOString() : null,
    suspendedUntil: u.suspendedUntil ? u.suspendedUntil.toISOString() : null,
    suspensionReason: u.suspensionReason,
  };
}

/** Detailed user profile + analytics for the admin console. No secrets exposed. */
export async function getUser(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      timezone: true,
      createdAt: true,
      suspendedAt: true,
      suspendedUntil: true,
      suspensionReason: true,
      subscription: true,
      _count: {
        select: {
          activities: true,
          goals: true,
          conversations: true,
        },
      },
    },
  });
  if (!user) throw AppError.notFound('User not found');

  const [messageCount, lastActivity] = await Promise.all([
    prisma.message.count({ where: { role: 'USER', conversation: { userId: id } } }),
    prisma.activity.findFirst({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    timezone: user.timezone,
    createdAt: user.createdAt.toISOString(),
    counts: { ...user._count, messages: messageCount },
    lastActivityAt: lastActivity ? lastActivity.createdAt.toISOString() : null,
    subscription: toSubscriptionWire(user.subscription),
    subscribed: isLive(user.subscription),
    ...toSuspensionWire(user),
  };
}

/** List/search users with filtering, sorting, and cursor pagination. */
export async function listUsers(q: ListUsersQuery) {
  const now = new Date();
  const and: Prisma.UserWhereInput[] = [];

  if (q.q) {
    and.push({
      OR: [
        { email: { contains: q.q, mode: 'insensitive' } },
        { name: { contains: q.q, mode: 'insensitive' } },
      ],
    });
  }
  if (q.suspended === true) {
    and.push({
      suspendedAt: { not: null },
      OR: [{ suspendedUntil: null }, { suspendedUntil: { gt: now } }],
    });
  } else if (q.suspended === false) {
    and.push({ OR: [{ suspendedAt: null }, { suspendedUntil: { lte: now } }] });
  }
  if (q.subscribed === true) {
    and.push({ subscription: { is: { status: 'ACTIVE', currentPeriodEnd: { gt: now } } } });
  } else if (q.subscribed === false) {
    and.push({
      OR: [
        { subscription: { is: null } },
        { subscription: { isNot: { status: 'ACTIVE', currentPeriodEnd: { gt: now } } } },
      ],
    });
  }
  if (q.createdFrom) and.push({ createdAt: { gte: new Date(q.createdFrom) } });
  if (q.createdTo) and.push({ createdAt: { lte: new Date(q.createdTo) } });

  const where: Prisma.UserWhereInput = and.length ? { AND: and } : {};

  const rows = await prisma.user.findMany({
    where,
    orderBy: [{ [q.sort]: q.order }, { id: q.order }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      email: true,
      name: true,
      timezone: true,
      createdAt: true,
      suspendedAt: true,
      suspendedUntil: true,
      suspensionReason: true,
      subscription: { select: { status: true, currentPeriodEnd: true, plan: true } },
      _count: { select: { activities: true, goals: true, conversations: true } },
    },
  });

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;

  return {
    items: page.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      timezone: u.timezone,
      createdAt: u.createdAt.toISOString(),
      counts: u._count,
      subscribed: isLive(u.subscription),
      plan: u.subscription?.plan ?? null,
      ...toSuspensionWire(u),
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Suspend a user; also revokes their refresh tokens to bound the access window. */
export async function suspendUser(id: string, input: SuspendUserInput) {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) throw AppError.notFound('User not found');

  await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: {
        suspendedAt: new Date(),
        suspendedUntil: input.until ? new Date(input.until) : null,
        suspensionReason: input.reason ?? null,
      },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
  return getUser(id);
}

/** Lift a suspension. */
export async function unsuspendUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) throw AppError.notFound('User not found');
  await prisma.user.update({
    where: { id },
    data: { suspendedAt: null, suspendedUntil: null, suspensionReason: null },
  });
  return getUser(id);
}

/** Permanently delete a user account (cascades to all related rows). */
export async function deleteUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) throw AppError.notFound('User not found');
  await prisma.user.delete({ where: { id } });
  return { deleted: true };
}

function toPublicAdmin(a: { id: string; email: string; name: string | null; role: 'SUPPORT' | 'SUPERADMIN' }): PublicAdmin {
  return { id: a.id, email: a.email, name: a.name, role: a.role };
}

export async function listAdmins(): Promise<PublicAdmin[]> {
  const admins = await prisma.admin.findMany({ orderBy: { createdAt: 'asc' } });
  return admins.map(toPublicAdmin);
}

export async function createAdmin(input: CreateAdminInput): Promise<PublicAdmin> {
  const existing = await prisma.admin.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw AppError.conflict('An admin with that email already exists');

  const passwordHash = await hashPassword(input.password);
  const admin = await prisma.admin.create({
    data: { email: input.email, passwordHash, name: input.name ?? null, role: input.role },
  });
  return toPublicAdmin(admin);
}
