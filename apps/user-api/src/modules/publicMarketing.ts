import { Router } from 'express';
import { prisma, type MarketingAsset } from '@lifeplanner/database';
import {
  AppError,
  MARKETING_SCREEN_KEYS,
  createContactSubmissionSchema,
  sendOk,
} from '@lifeplanner/shared-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Finds the most recently published LegalDocument for a slug, or throws 404. */
async function currentLegalDoc(slug: string) {
  const doc = await prisma.legalDocument.findFirst({
    where: { slug, publishedAt: { not: null } },
    orderBy: { publishedAt: 'desc' },
    select: { id: true, slug: true, version: true, title: true, intro: true, sections: true, publishedAt: true, updatedAt: true },
  });
  if (!doc) throw AppError.notFound(`No published ${slug} page found`);
  return doc;
}
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { contactFormLimiter, publicMarketingLimiter } from '../middleware/rateLimit.js';
import { sendMail } from '../lib/mailer.js';
import { logger } from '../lib/logger.js';

/**
 * The marketing site's own endpoints — `/`, `/about`, `/careers` and the
 * sign-up consent line. Unauthenticated by design: this is public copy, read
 * by people who do not have an account yet and may never get one.
 *
 * Mounted alongside `publicContentRouter` on `/api/v1/public`.
 */
export const publicMarketingRouter = Router();

// These are hit on every landing-page view, by visitors, from anywhere. The
// general limiter only covers `/api/v1/*`, which this sits outside of.
publicMarketingRouter.use(publicMarketingLimiter);

/**
 * Sixty seconds of shared caching. Long enough to absorb a traffic spike,
 * short enough that someone editing copy in the console sees their change
 * while they are still looking at the page.
 */
const CACHE_SECONDS = 60;
const cacheable = (res: { set(field: string, value: string): unknown }) =>
  res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);

// ---------------------------------------------------------------------------
// 1. GET /public/marketing-assets
// ---------------------------------------------------------------------------

/**
 * Every image slot on the site in one call.
 *
 * `null` is a real answer here, not a failure: an unfilled slot keeps its
 * designed placeholder, which is honest, where a broken image is not. The five
 * screen keys are always present and always in order even if nobody has
 * created rows for them yet, so the carousel's shape never depends on how much
 * of the console has been filled in.
 */
publicMarketingRouter.get(
  '/marketing-assets',
  asyncHandler(async (_req, res) => {
    const assets = await prisma.marketingAsset.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const bySlot = (slot: MarketingAsset['slot']) => assets.filter((a) => a.slot === slot);
    const singleUrl = (slot: MarketingAsset['slot']) => bySlot(slot)[0]?.imageUrl ?? null;
    const portraits = (slot: MarketingAsset['slot']) =>
      bySlot(slot).map((a) => ({ name: a.label ?? a.key, imageUrl: a.imageUrl ?? null }));

    const screenRows = bySlot('SCREEN');
    const screens = [
      // The canonical five, in render order, present whether or not a row exists.
      ...MARKETING_SCREEN_KEYS.map((key) => ({
        key,
        imageUrl: screenRows.find((a) => a.key === key)?.imageUrl ?? null,
      })),
      // Anything added beyond them trails the fixed set rather than displacing it.
      ...screenRows
        .filter((a) => !MARKETING_SCREEN_KEYS.includes(a.key as never))
        .map((a) => ({ key: a.key, imageUrl: a.imageUrl ?? null })),
    ];

    cacheable(res);
    sendOk(res, {
      heroPreviewUrl: singleUrl('HERO_PREVIEW'),
      screens,
      bendPrimaryUrl: singleUrl('BEND_PRIMARY'),
      bendDetailUrl: singleUrl('BEND_DETAIL'),
      testimonialPortraits: portraits('TESTIMONIAL_PORTRAIT'),
      aboutHeroUrl: singleUrl('ABOUT_HERO'),
      teamPortraits: portraits('TEAM_PORTRAIT'),
    });
  }),
);

// ---------------------------------------------------------------------------
// 2. GET /public/faqs
// ---------------------------------------------------------------------------

/**
 * The FAQ accordion.
 *
 * Falls back to `SiteContent.faqs` when no rows exist, so the console's
 * existing JSON list keeps working and the section never goes blank during the
 * changeover. An empty response is a legitimate answer — the frontend then
 * shows its own static copy.
 */
publicMarketingRouter.get(
  '/faqs',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.marketingFaq.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { question: true, answer: true },
    });

    if (rows.length > 0) {
      cacheable(res);
      sendOk(res, { faqs: rows });
      return;
    }

    const content = await prisma.siteContent.findUnique({
      where: { id: 'singleton' },
      select: { faqs: true },
    });

    cacheable(res);
    sendOk(res, { faqs: (content?.faqs as unknown[] | null) ?? [] });
  }),
);

// ---------------------------------------------------------------------------
// 3. GET /public/contact
// ---------------------------------------------------------------------------

/**
 * Contact details for the Contact section and the footer. Reads the existing
 * `SiteContent` singleton rather than introducing a second place where the
 * company's address lives.
 */
publicMarketingRouter.get(
  '/contact',
  asyncHandler(async (_req, res) => {
    const content = await prisma.siteContent.findUnique({
      where: { id: 'singleton' },
      select: {
        contactEmail: true,
        supportEmail: true,
        supportHours: true,
        contactAddress: true,
      },
    });

    cacheable(res);
    sendOk(res, {
      email: content?.contactEmail ?? content?.supportEmail ?? null,
      supportHours: content?.supportHours ?? null,
      // Null here is what hides the address row — for setups with no address
      // worth publishing, which is the case the original ask called out.
      officeAddress: content?.contactAddress ?? null,
    });
  }),
);

// ---------------------------------------------------------------------------
// 4. GET /public/careers/roles
// ---------------------------------------------------------------------------

/**
 * Open roles. Unpublished rows are excluded, and an empty list is returned as
 * an empty list — never padded, never cached from an older state. A stale job
 * advert costs someone an application; a missing photo costs nothing.
 */
publicMarketingRouter.get(
  '/careers/roles',
  asyncHandler(async (_req, res) => {
    const roles = await prisma.careerRole.findMany({
      where: { published: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        title: true,
        slug: true,
        department: true,
        body: true,
        location: true,
        employmentType: true,
        compensation: true,
        applyUrl: true,
      },
    });

    cacheable(res);
    sendOk(res, { roles });
  }),
);

// ---------------------------------------------------------------------------
// 5. GET /public/app-links
// ---------------------------------------------------------------------------

/**
 * Store badges. A platform reads as `null` unless it is active and has both a
 * destination and a badge image — half a badge is not something the footer can
 * render, and claiming an Android app exists before it does would send people
 * to a dead page.
 */
publicMarketingRouter.get(
  '/app-links',
  asyncHandler(async (_req, res) => {
    const links = await prisma.appStoreLink.findMany({ where: { active: true } });
    const forPlatform = (platform: 'APP_STORE' | 'PLAY_STORE') => {
      const row = links.find((l) => l.platform === platform);
      if (!row?.url || !row.badgeImageUrl) return null;
      return { url: row.url, badgeImageUrl: row.badgeImageUrl };
    };

    cacheable(res);
    sendOk(res, {
      appStore: forPlatform('APP_STORE'),
      playStore: forPlatform('PLAY_STORE'),
    });
  }),
);

// ---------------------------------------------------------------------------
// 6. GET /public/legal/consent
// ---------------------------------------------------------------------------

/**
 * The sign-up checkbox's label. Deliberately small — a lead-in fragment and a
 * version, not legal text. The full terms stay on `/terms` and `/privacy`.
 *
 * 404s when nothing is published, rather than inventing a summary. The
 * frontend's generic label is the right thing to show in that case, and the
 * checkbox works either way.
 */
publicMarketingRouter.get(
  '/legal/consent',
  asyncHandler(async (_req, res) => {
    const current = await prisma.legalConsent.findFirst({
      where: { publishedAt: { not: null } },
      orderBy: [{ publishedAt: 'desc' }],
      select: { version: true, summary: true, updatedAt: true },
    });

    if (!current) throw AppError.notFound('No consent summary has been published yet');

    cacheable(res);
    sendOk(res, {
      version: current.version,
      updatedAt: current.updatedAt,
      summary: current.summary,
    });
  }),
);

// ---------------------------------------------------------------------------
// 7. POST /public/contact-submissions
// ---------------------------------------------------------------------------

/** Where a submission notice goes when no support address is configured. */
const FALLBACK_NOTIFY_TO = 'support@lifeplanner.local';

/**
 * The contact form.
 *
 * The write to the database is what the response is based on: the notification
 * email is fire-and-forget, so a flaky mail transport cannot turn a message we
 * have safely stored into an error the sender sees. The row is the record; the
 * email is a convenience for whoever is on the desk.
 */
publicMarketingRouter.post(
  '/contact-submissions',
  contactFormLimiter,
  validate(createContactSubmissionSchema),
  asyncHandler(async (req, res) => {
    const { name, email, topic, message } = req.body as {
      name: string;
      email: string;
      topic: string;
      message: string;
    };

    // A double-clicked Send should not create two tickets, and should not look
    // like a failure either. Same person, same message, inside two minutes:
    // return the submission they already made.
    const recent = await prisma.contactSubmission.findFirst({
      where: {
        email,
        message,
        createdAt: { gte: new Date(Date.now() - 2 * 60_000) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });

    if (recent) {
      sendOk(res, { id: recent.id, receivedAt: recent.createdAt });
      return;
    }

    const submission = await prisma.contactSubmission.create({
      data: {
        name,
        email,
        topic,
        message,
        ip: req.ip ?? null,
        userAgent: req.header('user-agent')?.slice(0, 500) ?? null,
      },
      select: { id: true, createdAt: true },
    });

    const content = await prisma.siteContent
      .findUnique({ where: { id: 'singleton' }, select: { supportEmail: true, contactEmail: true } })
      .catch(() => null);

    void sendMail({
      to: content?.supportEmail ?? content?.contactEmail ?? FALLBACK_NOTIFY_TO,
      subject: `Contact form — ${topic}`,
      text: [
        `From: ${name} <${email}>`,
        `Topic: ${topic}`,
        `Submission: ${submission.id}`,
        '',
        message,
      ].join('\n'),
    }).catch((err: unknown) => {
      // Logged loudly: the message is safe in the database, but nobody has been
      // told about it, and that is worth noticing.
      logger.error({ err, submissionId: submission.id }, 'Contact submission stored but not emailed');
    });

    sendOk(res, { id: submission.id, receivedAt: submission.createdAt }, 201);
  }),
);

// ---------------------------------------------------------------------------
// 8. GET /public/about
// ---------------------------------------------------------------------------

/**
 * The About Us page's team section. Returns admins who have opted in to public
 * visibility — `isPublic: true`, not deleted, and status ACTIVE. Fields are
 * curated for public consumption; operational data (email, roles, etc.) is
 * never included.
 */
publicMarketingRouter.get(
  '/about',
  asyncHandler(async (_req, res) => {
    const staff = await prisma.admin.findMany({
      where: { isPublic: true, deletedAt: null, status: 'ACTIVE' },
      orderBy: [{ staffSortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        staffRole: true,
        bio: true,
        photoUrl: true,
        favQuote: true,
        linkedIn: true,
      },
    });

    const content = await prisma.siteContent.findUnique({
      where: { id: 'singleton' },
      select: { aboutHeadline: true, aboutBody: true },
    });

    cacheable(res);
    sendOk(res, {
      headline: content?.aboutHeadline ?? null,
      body: content?.aboutBody ?? null,
      staff,
    });
  }),
);

// ---------------------------------------------------------------------------
// 9. GET /public/terms
// ---------------------------------------------------------------------------

/**
 * The current Terms & Conditions page content. Serves the most recently
 * published version of the "terms" document. 404s when nothing is published
 * (the static handoff copy stays on the frontend as fallback).
 */
publicMarketingRouter.get(
  '/terms',
  asyncHandler(async (_req, res) => {
    const doc = await currentLegalDoc('terms');
    cacheable(res);
    sendOk(res, doc);
  }),
);

// ---------------------------------------------------------------------------
// 10. GET /public/privacy
// ---------------------------------------------------------------------------

/**
 * The current Privacy Policy page content. Same shape as /terms; versioned
 * independently so the two can change on their own schedules.
 */
publicMarketingRouter.get(
  '/privacy',
  asyncHandler(async (_req, res) => {
    const doc = await currentLegalDoc('privacy');
    cacheable(res);
    sendOk(res, doc);
  }),
);
