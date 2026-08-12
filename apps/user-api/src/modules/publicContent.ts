import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import { publicPlansQuerySchema, securityActionResponseSchema, sendOk } from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { resolveSecurityAction, respondToSecurityAction } from '../lib/security.js';
import { buildPlanCatalog, resolveVisitorCountry } from '../lib/planCatalog.js';

/** Landing-page content. Deliberately unauthenticated — it is public copy. */
export const publicContentRouter = Router();

publicContentRouter.get(
  '/content',
  asyncHandler(async (_req, res) => {
    const [content, staff] = await Promise.all([
      prisma.siteContent.findUnique({ where: { id: 'singleton' } }),
      prisma.staffMember.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          position: true,
          bio: true,
          imageUrl: true,
          linkedIn: true,
        },
      }),
    ]);

    sendOk(res, {
      contact: {
        email: content?.contactEmail ?? null,
        phone: content?.contactPhone ?? null,
        address: content?.contactAddress ?? null,
        supportEmail: content?.supportEmail ?? null,
      },
      hero: {
        headline: content?.heroHeadline ?? null,
        subhead: content?.heroSubhead ?? null,
        ctaLabel: content?.heroCtaLabel ?? null,
      },
      // Arrays rather than null, so the landing page maps over them without
      // guarding every section.
      features: (content?.features as unknown[] | null) ?? [],
      faqs: (content?.faqs as unknown[] | null) ?? [],
      about: {
        headline: content?.aboutHeadline ?? null,
        body: content?.aboutBody ?? null,
        staff,
      },
      socialLinks: content?.socialLinks ?? {},
      updatedAt: content?.updatedAt ?? null,
    });
  }),
);

/**
 * Public pricing for the landing page.
 *
 * This used to return only the fallback (USD) region and a stripped-down row,
 * so a Lagos visitor saw dollars and no shared-plan option until after signing
 * up — which hides the two- and three-seat plans at exactly the moment someone
 * is comparing us against a solo planner. It now returns the same rich shape as
 * the signed-in route, for the visitor's own region.
 */
publicContentRouter.get(
  '/plans',
  validate(publicPlansQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { country } = req.query as unknown as { country?: string };
    const resolved = resolveVisitorCountry(country, req.headers);

    const catalog = await buildPlanCatalog(resolved.country, 'WEB');

    sendOk(res, {
      ...catalog,
      // Tells the client whether to say "prices in NGN" confidently or offer a
      // country picker, instead of implying certainty we do not have.
      resolvedFrom: resolved.resolvedFrom,
    });
  }),
);

/** Cartoon avatars offered in the photo picker. */
publicContentRouter.get(
  '/avatar-presets',
  asyncHandler(async (_req, res) => {
    const presets = await prisma.avatarPreset.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      select: { id: true, key: true, label: true, url: true, category: true },
    });
    sendOk(res, { presets });
  }),
);

// ---------------------------------------------------------------------------
// "This wasn't me" — unauthenticated by design
// ---------------------------------------------------------------------------

/**
 * These endpoints are deliberately open: the person clicking may have no
 * account at all, and requiring a login to disown an action you never took
 * would be absurd. The one-time token is the credential, and it only ever
 * reaches the mailbox the notice was sent to.
 */
publicContentRouter.get(
  '/security/:token',
  asyncHandler(async (req, res) => {
    const action = await resolveSecurityAction(req.params.token);

    const summary = {
      SEAT_INVITE: action.seat
        ? `${action.seat.subscription.user.name} invited you to a shared Life Planner plan they pay for.`
        : 'Someone invited you to a shared Life Planner plan.',
      SIGNUP: 'A Life Planner account was created with this email address.',
      PASSWORD_RESET: 'Someone asked to reset the password on the account using this email.',
    }[action.type];

    sendOk(res, {
      type: action.type,
      email: action.email,
      summary,
      // Declining an invitation is not an accusation; the other two only
      // make sense as reports.
      canReject: action.type === 'SEAT_INVITE',
      expiresAt: action.expiresAt,
    });
  }),
);

publicContentRouter.post(
  '/security/:token',
  validate(securityActionResponseSchema),
  asyncHandler(async (req, res) => {
    const { consequences, action } = await respondToSecurityAction({
      token: req.params.token,
      outcome: req.body.action === 'REJECT' ? 'REJECTED' : 'REPORTED',
      note: req.body.note,
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });

    sendOk(res, {
      type: action.type,
      outcome: req.body.action === 'REJECT' ? 'REJECTED' : 'REPORTED',
      consequences,
      message:
        req.body.action === 'REJECT'
          ? 'Declined. The invitation has been cancelled and you will not be contacted about it again.'
          : 'Thank you — this has been reported to our team and we have secured the account.',
    });
  }),
);
