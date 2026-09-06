import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  CONTACT_TOPICS,
  MARKETING_SCREEN_KEYS,
  SINGLE_IMAGE_SLOTS,
  careerRoleQuerySchema,
  careerRoleSchema,
  contactSubmissionQuerySchema,
  createLegalConsentSchema,
  createLegalDocumentSchema,
  idParamSchema,
  includeInactiveQuerySchema,
  legalDocumentQuerySchema,
  marketingAssetQuerySchema,
  marketingFaqSchema,
  paginate,
  reorderSchema,
  sendOk,
  updateAppLinkSchema,
  updateCareerRoleSchema,
  updateContactSubmissionSchema,
  updateLegalConsentSchema,
  updateLegalDocumentSchema,
  updateMarketingAssetSchema,
  updateMarketingFaqSchema,
  upsertAppLinkSchema,
  upsertMarketingAssetSchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentAdmin, requireOversight } from '../middleware/auth.js';

/**
 * Marketing-site content, managed. Everything the public marketing endpoints
 * read is editable here — images, FAQs, open roles, store badges and the
 * sign-up consent line — plus the inbox for what the contact form collects.
 *
 * Reads are open to any admin; writes are oversight-only, matching how the
 * rest of the site content behaves. The one exception is the contact inbox:
 * answering messages is support work, so any admin can triage it, and only
 * oversight can delete.
 */

export const marketingAssetsRouter = Router();
export const marketingFaqsRouter = Router();
export const careerRolesRouter = Router();
export const appLinksRouter = Router();
export const legalConsentRouter = Router();
export const legalDocumentsRouter = Router();
export const contactSubmissionsRouter = Router();

const slugify = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

// ===========================================================================
// 1. Marketing assets — /admin/v1/marketing-assets
// ===========================================================================

marketingAssetsRouter.get(
  '/',
  validate(marketingAssetQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { slot, includeInactive } = req.query as unknown as {
      slot?: Prisma.MarketingAssetWhereInput['slot'];
      includeInactive: 'true' | 'false';
    };

    const assets = await prisma.marketingAsset.findMany({
      where: {
        ...(slot ? { slot } : {}),
        ...(includeInactive === 'true' ? {} : { active: true }),
      },
      orderBy: [{ slot: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    sendOk(res, {
      assets,
      // So the console can render "these slots exist and are still empty"
      // without hard-coding the contract a second time.
      screenKeys: MARKETING_SCREEN_KEYS,
      unfilled: assets.filter((a) => !a.imageUrl).map((a) => ({ id: a.id, slot: a.slot, key: a.key })),
    });
  }),
);

/**
 * Upsert on (slot, key). Filling a slot is one operation whether or not a row
 * exists yet, so the console never has to look one up first — and a slot can
 * never end up with two competing rows.
 */
marketingAssetsRouter.put(
  '/',
  requireOversight,
  validate(upsertMarketingAssetSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { slot, label, ...rest } = req.body as {
      slot: 'HERO_PREVIEW' | 'SCREEN' | 'BEND_PRIMARY' | 'BEND_DETAIL' | 'TESTIMONIAL_PORTRAIT' | 'ABOUT_HERO' | 'TEAM_PORTRAIT';
      key?: string;
      label?: string | null;
      imageUrl?: string | null;
      alt?: string | null;
      sortOrder?: number;
      active?: boolean;
    };

    // Single-image slots are keyed `main` so the unique constraint keeps them
    // singular; portraits fall back to a slug of the person's name.
    const key = SINGLE_IMAGE_SLOTS.includes(slot as never)
      ? 'main'
      : rest.key ?? (label ? slugify(label) : '');
    if (!key) throw AppError.badRequest('Could not derive a key for this asset');

    const { key: _ignored, ...data } = rest;

    const asset = await prisma.marketingAsset.upsert({
      where: { slot_key: { slot, key } },
      update: { ...data, ...(label === undefined ? {} : { label }), updatedByAdminId: me.id },
      create: { slot, key, label: label ?? null, ...data, updatedByAdminId: me.id },
    });

    sendOk(res, { asset });
  }),
);

marketingAssetsRouter.patch(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  validate(updateMarketingAssetSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const asset = await prisma.marketingAsset.update({
      where: { id: req.params.id },
      data: { ...req.body, updatedByAdminId: me.id },
    });
    sendOk(res, { asset });
  }),
);

/**
 * Clearing an image is not the same as deleting the slot: the slot still
 * exists on the page and still needs its placeholder, so this empties the row
 * rather than removing it.
 */
marketingAssetsRouter.delete(
  '/:id/image',
  requireOversight,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const asset = await prisma.marketingAsset.update({
      where: { id: req.params.id },
      data: { imageUrl: null, updatedByAdminId: me.id },
    });
    sendOk(res, { asset, cleared: true });
  }),
);

marketingAssetsRouter.delete(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await prisma.marketingAsset.delete({ where: { id: req.params.id } });
    sendOk(res, { deleted: true });
  }),
);

// ===========================================================================
// 2. FAQs — /admin/v1/faqs
// ===========================================================================

marketingFaqsRouter.get(
  '/',
  validate(includeInactiveQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { includeInactive } = req.query as unknown as { includeInactive: 'true' | 'false' };
    const faqs = await prisma.marketingFaq.findMany({
      where: includeInactive === 'true' ? {} : { active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const legacy = await prisma.siteContent.findUnique({
      where: { id: 'singleton' },
      select: { faqs: true },
    });

    sendOk(res, {
      faqs,
      // Surfaced rather than hidden: while this list is empty the public
      // endpoint is still serving the old JSON blob, and the console should
      // say so instead of showing an empty table that looks live.
      servingLegacyJson: faqs.length === 0,
      legacyFaqs: faqs.length === 0 ? ((legacy?.faqs as unknown[] | null) ?? []) : [],
    });
  }),
);

marketingFaqsRouter.post(
  '/',
  requireOversight,
  validate(marketingFaqSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const faq = await prisma.marketingFaq.create({
      data: { ...req.body, updatedByAdminId: me.id },
    });
    sendOk(res, { faq }, 201);
  }),
);

marketingFaqsRouter.patch(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  validate(updateMarketingFaqSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const faq = await prisma.marketingFaq.update({
      where: { id: req.params.id },
      data: { ...req.body, updatedByAdminId: me.id },
    });
    sendOk(res, { faq });
  }),
);

/** Drag-and-drop ordering: the console sends the whole order, once. */
marketingFaqsRouter.put(
  '/order',
  requireOversight,
  validate(reorderSchema),
  asyncHandler(async (req, res) => {
    const { ids } = req.body as { ids: string[] };
    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.marketingFaq.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    sendOk(res, { reordered: ids.length });
  }),
);

marketingFaqsRouter.delete(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await prisma.marketingFaq.delete({ where: { id: req.params.id } });
    sendOk(res, { deleted: true });
  }),
);

// ===========================================================================
// 4. Career roles — /admin/v1/careers/roles
// ===========================================================================

careerRolesRouter.get(
  '/',
  validate(careerRoleQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      q?: string;
      department?: string;
      published?: 'true' | 'false';
      page: number;
      pageSize: number;
    };

    const where: Prisma.CareerRoleWhereInput = {
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' } },
              { body: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(q.department ? { department: { equals: q.department, mode: 'insensitive' } } : {}),
      ...(q.published ? { published: q.published === 'true' } : {}),
    };

    const [items, total, publishedCount] = await Promise.all([
      prisma.careerRole.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.careerRole.count({ where }),
      prisma.careerRole.count({ where: { published: true } }),
    ]);

    // The public headline counts published roles, so the console shows the
    // same number rather than the number of rows in front of the editor.
    sendOk(res, { ...paginate(items, q.page, q.pageSize, total), publishedCount });
  }),
);

careerRolesRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const role = await prisma.careerRole.findUnique({ where: { id: req.params.id } });
    if (!role) throw AppError.notFound('That role does not exist');
    sendOk(res, { role });
  }),
);

/**
 * Generates a unique slug from a title. Checks for existing slugs with the
 * same base and appends a numeric suffix when needed, so two "Senior Engineer"
 * roles both get their own stable URL rather than colliding.
 */
async function generateUniqueSlug(title: string, excludeId?: string): Promise<string> {
  const base = slugify(title);
  const pattern = `^${base}(-[0-9]+)?$`;

  const existing = await prisma.careerRole.findMany({
    where: {
      slug: { contains: base },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { slug: true },
  });

  const taken = new Set(existing.map((r) => r.slug));
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

careerRolesRouter.post(
  '/',
  requireOversight,
  validate(careerRoleSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const slug = await generateUniqueSlug(req.body.title as string);
    const role = await prisma.careerRole.create({
      data: { ...req.body, slug, updatedByAdminId: me.id },
    });
    sendOk(res, { role }, 201);
  }),
);

careerRolesRouter.patch(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  validate(updateCareerRoleSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const role = await prisma.careerRole.update({
      where: { id: req.params.id },
      data: { ...req.body, updatedByAdminId: me.id },
    });
    sendOk(res, { role });
  }),
);

careerRolesRouter.put(
  '/order',
  requireOversight,
  validate(reorderSchema),
  asyncHandler(async (req, res) => {
    const { ids } = req.body as { ids: string[] };
    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.careerRole.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    sendOk(res, { reordered: ids.length });
  }),
);

/**
 * A filled role is deleted, not hidden. Unlike a price or a market, there is
 * no history worth keeping here — and an unpublished advert lingering in the
 * table invites someone to republish it by accident months later.
 */
careerRolesRouter.delete(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await prisma.careerRole.delete({ where: { id: req.params.id } });
    sendOk(res, { deleted: true });
  }),
);

// ===========================================================================
// 5. App links — /admin/v1/app-links
// ===========================================================================

appLinksRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const links = await prisma.appStoreLink.findMany({ orderBy: { platform: 'asc' } });
    sendOk(res, {
      links,
      // The footer row disappears entirely in this state, which is correct
      // while neither native app exists — worth stating so it does not read
      // like a bug in the console.
      badgeRowHidden: links.filter((l) => l.active).length === 0,
    });
  }),
);

appLinksRouter.put(
  '/',
  requireOversight,
  validate(upsertAppLinkSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { platform, ...rest } = req.body as {
      platform: 'APP_STORE' | 'PLAY_STORE';
      url: string;
      badgeImageUrl: string;
      active: boolean;
    };
    const link = await prisma.appStoreLink.upsert({
      where: { platform },
      update: { ...rest, updatedByAdminId: me.id },
      create: { platform, ...rest, updatedByAdminId: me.id },
    });
    sendOk(res, { link });
  }),
);

appLinksRouter.patch(
  '/:platform',
  requireOversight,
  validate(updateAppLinkSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const platform = req.params.platform.toUpperCase();
    if (platform !== 'APP_STORE' && platform !== 'PLAY_STORE') {
      throw AppError.badRequest('Platform must be APP_STORE or PLAY_STORE');
    }
    const link = await prisma.appStoreLink.update({
      where: { platform },
      data: { ...req.body, updatedByAdminId: me.id },
    });
    sendOk(res, { link });
  }),
);

appLinksRouter.delete(
  '/:platform',
  requireOversight,
  asyncHandler(async (req, res) => {
    const platform = req.params.platform.toUpperCase();
    if (platform !== 'APP_STORE' && platform !== 'PLAY_STORE') {
      throw AppError.badRequest('Platform must be APP_STORE or PLAY_STORE');
    }
    await prisma.appStoreLink.delete({ where: { platform } });
    sendOk(res, { deleted: true });
  }),
);

// ===========================================================================
// 6. Legal consent — /admin/v1/legal/consent
// ===========================================================================

legalConsentRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const versions = await prisma.legalConsent.findMany({
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const current = versions.find((v) => v.publishedAt !== null) ?? null;
    sendOk(res, { versions, current });
  }),
);

/**
 * New versions rather than edits in place. Someone signed up under a specific
 * wording, and rewriting the row they agreed to would quietly erase that.
 */
legalConsentRouter.post(
  '/',
  requireOversight,
  validate(createLegalConsentSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { version, summary, publish } = req.body as {
      version: string;
      summary: string;
      publish: boolean;
    };

    const existing = await prisma.legalConsent.findUnique({ where: { version } });
    if (existing) throw AppError.conflict(`Version "${version}" already exists`);

    const consent = await prisma.legalConsent.create({
      data: {
        version,
        summary,
        publishedAt: publish ? new Date() : null,
        updatedByAdminId: me.id,
      },
    });
    sendOk(res, { consent }, 201);
  }),
);

legalConsentRouter.patch(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  validate(updateLegalConsentSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { publish, ...rest } = req.body as {
      publish?: boolean;
      version?: string;
      summary?: string;
    };
    const consent = await prisma.legalConsent.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        ...(publish === undefined ? {} : { publishedAt: publish ? new Date() : null }),
        updatedByAdminId: me.id,
      },
    });
    sendOk(res, { consent });
  }),
);

legalConsentRouter.delete(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const consent = await prisma.legalConsent.findUnique({ where: { id: req.params.id } });
    if (!consent) throw AppError.notFound('That consent version does not exist');
    if (consent.publishedAt) {
      // Deleting what is currently live would drop the sign-up label back to
      // its generic fallback without anyone deciding that.
      throw AppError.conflict('Unpublish this version before deleting it');
    }
    await prisma.legalConsent.delete({ where: { id: consent.id } });
    sendOk(res, { deleted: true });
  }),
);

// ===========================================================================
// 7. Contact submissions — /admin/v1/contact-submissions
// ===========================================================================

contactSubmissionsRouter.get(
  '/',
  validate(contactSubmissionQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      q?: string;
      status?: 'NEW' | 'READ' | 'REPLIED' | 'ARCHIVED' | 'SPAM';
      topic?: string;
      from?: string;
      to?: string;
      page: number;
      pageSize: number;
    };

    const where: Prisma.ContactSubmissionWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.topic ? { topic: q.topic } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { email: { contains: q.q, mode: 'insensitive' } },
              { message: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(`${q.from}T00:00:00.000Z`) } : {}),
              ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    };

    const [items, total, newCount] = await Promise.all([
      prisma.contactSubmission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          name: true,
          email: true,
          topic: true,
          message: true,
          status: true,
          internalNote: true,
          handledByAdminId: true,
          handledAt: true,
          createdAt: true,
        },
      }),
      prisma.contactSubmission.count({ where }),
      prisma.contactSubmission.count({ where: { status: 'NEW' } }),
    ]);

    // Who handled it, by name — an id in a queue tells nobody anything.
    const adminIds = [...new Set(items.map((i) => i.handledByAdminId).filter(Boolean))] as string[];
    const admins = adminIds.length
      ? await prisma.admin.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(admins.map((a) => [a.id, a.name]));

    sendOk(res, {
      ...paginate(
        items.map((i) => ({
          ...i,
          handledByName: i.handledByAdminId ? (nameById.get(i.handledByAdminId) ?? null) : null,
        })),
        q.page,
        q.pageSize,
        total,
      ),
      // Drives the unread badge, and is deliberately unfiltered: it is the
      // size of the queue, not the size of the current view.
      newCount,
      topics: CONTACT_TOPICS,
    });
  }),
);

contactSubmissionsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const submission = await prisma.contactSubmission.findUnique({ where: { id: req.params.id } });
    if (!submission) throw AppError.notFound('That submission does not exist');
    sendOk(res, { submission });
  }),
);

/**
 * Status and internal notes. Marking something REPLIED records who did it and
 * when, so "did anyone get back to this person" has an answer that does not
 * depend on someone remembering.
 */
contactSubmissionsRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateContactSubmissionSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { status, internalNote } = req.body as {
      status?: 'NEW' | 'READ' | 'REPLIED' | 'ARCHIVED' | 'SPAM';
      internalNote?: string | null;
    };

    const submission = await prisma.contactSubmission.update({
      where: { id: req.params.id },
      data: {
        ...(status ? { status } : {}),
        ...(internalNote === undefined ? {} : { internalNote }),
        ...(status && status !== 'NEW'
          ? { handledByAdminId: me.id, handledAt: new Date() }
          : {}),
        // Moving something back to NEW puts it back in the queue as if
        // untouched, rather than leaving a handler's name on it.
        ...(status === 'NEW' ? { handledByAdminId: null, handledAt: null } : {}),
      },
    });

    sendOk(res, { submission });
  }),
);

contactSubmissionsRouter.delete(
  '/:id',
  requireOversight,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await prisma.contactSubmission.delete({ where: { id: req.params.id } });
    sendOk(res, { deleted: true });
  }),
);

// ===========================================================================
// /terms and /privacy legal documents — /admin/v1/legal/documents
// ===========================================================================

legalDocumentsRouter.get(
  '/',
  validate(legalDocumentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { slug?: string; page: number; pageSize: number };

    const where: Prisma.LegalDocumentWhereInput = q.slug ? { slug: q.slug } : {};

    const [items, total] = await Promise.all([
      prisma.legalDocument.findMany({
        where,
        orderBy: [{ slug: 'asc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.legalDocument.count({ where }),
    ]);

    // Surface the live version per slug so the console can show which one is
    // current without the caller having to work it out themselves.
    const slugs = [...new Set(items.map((d) => d.slug))];
    const currentBySlug: Record<string, string | null> = {};
    for (const slug of slugs) {
      const current = await prisma.legalDocument.findFirst({
        where: { slug, publishedAt: { not: null } },
        orderBy: { publishedAt: 'desc' },
        select: { id: true },
      });
      currentBySlug[slug] = current?.id ?? null;
    }

    sendOk(res, {
      ...paginate(items, q.page, q.pageSize, total),
      currentBySlug,
    });
  }),
);

legalDocumentsRouter.get(
  '/:id',
  validate({ parse: (p: unknown) => p } as never, 'params'),
  asyncHandler(async (req, res) => {
    const doc = await prisma.legalDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) throw AppError.notFound('That document version does not exist');
    sendOk(res, { doc });
  }),
);

/**
 * New versions rather than edits in place. What a user agreed to on sign-up
 * day must stay answerable. A draft (publish: false) is safe to create and
 * review before making it live.
 */
legalDocumentsRouter.post(
  '/',
  requireOversight,
  validate(createLegalDocumentSchema),
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const { slug, version, publish, ...rest } = req.body as {
      slug: string;
      version: string;
      title: string;
      intro: string;
      sections: Array<{ h: string; p: string }>;
      publish: boolean;
    };

    const existing = await prisma.legalDocument.findUnique({
      where: { slug_version: { slug, version } },
    });
    if (existing) {
      throw AppError.conflict(`A ${slug} document with version "${version}" already exists`);
    }

    const doc = await prisma.legalDocument.create({
      data: {
        slug,
        version,
        ...rest,
        publishedAt: publish ? new Date() : null,
        updatedByAdminId: me.id,
      },
    });
    sendOk(res, { doc }, 201);
  }),
);

/** Publish, unpublish, or correct a draft's content. Cannot edit a published row's content — create a new version for that. */
legalDocumentsRouter.patch(
  '/:id',
  requireOversight,
  asyncHandler(async (req, res) => {
    const me = currentAdmin(req);
    const existing = await prisma.legalDocument.findUnique({ where: { id: req.params.id } });
    if (!existing) throw AppError.notFound('That document version does not exist');

    const body = req.body as {
      version?: string;
      title?: string;
      intro?: string;
      sections?: Array<{ h: string; p: string }>;
      publish?: boolean;
    };

    // Guard against silently rewriting history: once published, content fields
    // are locked. Only publish/unpublish is allowed on a live row.
    const isPublished = existing.publishedAt !== null;
    const contentFields = ['version', 'title', 'intro', 'sections'] as const;
    if (isPublished && contentFields.some((f) => body[f] !== undefined)) {
      throw AppError.conflict(
        'This version is already published. Create a new version to change the content.',
      );
    }

    const doc = await prisma.legalDocument.update({
      where: { id: req.params.id },
      data: {
        ...(body.version !== undefined ? { version: body.version } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.intro !== undefined ? { intro: body.intro } : {}),
        ...(body.sections !== undefined ? { sections: body.sections } : {}),
        ...(body.publish !== undefined ? { publishedAt: body.publish ? new Date() : null } : {}),
        updatedByAdminId: me.id,
      },
    });
    sendOk(res, { doc });
  }),
);

/** Drafts only — published versions cannot be deleted. */
legalDocumentsRouter.delete(
  '/:id',
  requireOversight,
  asyncHandler(async (req, res) => {
    const doc = await prisma.legalDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) throw AppError.notFound('That document version does not exist');
    if (doc.publishedAt) {
      throw AppError.conflict('Unpublish this version before deleting it');
    }
    await prisma.legalDocument.delete({ where: { id: doc.id } });
    sendOk(res, { deleted: true });
  }),
);
