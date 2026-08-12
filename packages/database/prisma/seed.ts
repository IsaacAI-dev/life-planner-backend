import argon2 from 'argon2';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';


const prisma = new PrismaClient();

const hash = (plain: string) =>
  argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

const dateOnly = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const addDays = (date: Date, days: number) => {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
};

const today = (() => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
})();

const DEFAULT_CATEGORIES = [
  { name: 'Work', color: '#2563EB', icon: 'briefcase', order: 0 },
  { name: 'Health', color: '#16A34A', icon: 'heart', order: 1 },
  { name: 'Personal', color: '#DB2777', icon: 'user', order: 2 },
  { name: 'Learning', color: '#7C3AED', icon: 'book', order: 3 },
  { name: 'Errands', color: '#EA580C', icon: 'shopping-bag', order: 4 },
];

/**
 * Mirrors DEFAULT_FOOD_CATEGORIES in shared-utils. Inlined deliberately: the
 * database package has no dependency on shared-utils and adding one for a
 * single fixture list would invert the layering.
 */
const DEFAULT_FOOD_CATEGORIES = [
  { key: 'PROTEIN', label: 'Protein', color: '#DC2626', sortOrder: 0 },
  { key: 'CARBOHYDRATE', label: 'Carbohydrate', color: '#D97706', sortOrder: 1 },
  { key: 'VEGETABLE', label: 'Vegetable', color: '#16A34A', sortOrder: 2 },
  { key: 'FRUIT', label: 'Fruit', color: '#EA580C', sortOrder: 3 },
  { key: 'DAIRY', label: 'Dairy', color: '#0EA5E9', sortOrder: 4 },
  { key: 'FAT_OIL', label: 'Fats & oils', color: '#CA8A04', sortOrder: 5 },
  { key: 'BEVERAGE', label: 'Beverage', color: '#0891B2', sortOrder: 6 },
  { key: 'SNACK', label: 'Snack', color: '#7C3AED', sortOrder: 7 },
  { key: 'LEGUME', label: 'Legume', color: '#65A30D', sortOrder: 8 },
  { key: 'GRAIN', label: 'Grain', color: '#A16207', sortOrder: 9 },
  { key: 'OTHER', label: 'Other', color: '#64748B', sortOrder: 10 },
];

interface SeedFood {
  name: string;
  /** A food can sit in several categories — egusi is protein, veg and fat. */
  categories: string[];
  caloriesPerServing: number;
  servingSize: string;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
}

/** Addendum 2 §22.1 — starter catalog slice for country NG. */
const NG_FOODS: SeedFood[] = [
  { name: 'Jollof rice', categories: ['CARBOHYDRATE'], caloriesPerServing: 220, servingSize: '1 cup (160g)', proteinG: 4, carbsG: 42, fatG: 6 },
  { name: 'Boiled yam', categories: ['CARBOHYDRATE'], caloriesPerServing: 120, servingSize: '100g', proteinG: 1.5, carbsG: 28, fatG: 0.2 },
  { name: 'Grilled tilapia', categories: ['PROTEIN'], caloriesPerServing: 180, servingSize: '1 fillet (120g)', proteinG: 34, carbsG: 0, fatG: 4.5 },
  { name: 'Moin moin (bean pudding)', categories: ['PROTEIN', 'LEGUME'], caloriesPerServing: 210, servingSize: '1 wrap (150g)', proteinG: 11, carbsG: 24, fatG: 8 },
  { name: 'Efo riro (vegetable soup)', categories: ['VEGETABLE'], caloriesPerServing: 140, servingSize: '1 cup', proteinG: 7, carbsG: 8, fatG: 9 },
  { name: 'Fried plantain (dodo)', categories: ['CARBOHYDRATE'], caloriesPerServing: 250, servingSize: '6 slices', proteinG: 1.5, carbsG: 40, fatG: 10 },
  { name: 'Watermelon', categories: ['FRUIT'], caloriesPerServing: 45, servingSize: '1 cup, diced', proteinG: 0.9, carbsG: 11, fatG: 0.2 },
  { name: 'Zobo drink (unsweetened)', categories: ['BEVERAGE'], caloriesPerServing: 35, servingSize: '1 cup', proteinG: 0, carbsG: 8, fatG: 0 },
  { name: 'Groundnuts (roasted)', categories: ['FAT_OIL', 'PROTEIN', 'SNACK'], caloriesPerServing: 160, servingSize: '30g', proteinG: 7, carbsG: 5, fatG: 14 },
  { name: 'Akara (bean cakes)', categories: ['PROTEIN', 'LEGUME'], caloriesPerServing: 130, servingSize: '2 pieces', proteinG: 6, carbsG: 12, fatG: 6 },
  { name: 'Ogi / pap', categories: ['CARBOHYDRATE', 'GRAIN'], caloriesPerServing: 90, servingSize: '1 cup', proteinG: 2, carbsG: 20, fatG: 0.5 },
  { name: 'Egusi soup', categories: ['PROTEIN', 'VEGETABLE', 'FAT_OIL'], caloriesPerServing: 300, servingSize: '1 cup', proteinG: 14, carbsG: 10, fatG: 24 },
  { name: 'Suya (beef skewer)', categories: ['PROTEIN'], caloriesPerServing: 240, servingSize: '2 skewers', proteinG: 26, carbsG: 3, fatG: 14 },
  { name: 'Ugu (fluted pumpkin leaves)', categories: ['VEGETABLE'], caloriesPerServing: 30, servingSize: '1 cup', proteinG: 3, carbsG: 4, fatG: 0.4 },
  { name: 'Pawpaw (papaya)', categories: ['FRUIT'], caloriesPerServing: 60, servingSize: '1 cup, diced', proteinG: 0.7, carbsG: 15, fatG: 0.2 },
  { name: 'Yoghurt (plain)', categories: ['DAIRY', 'PROTEIN'], caloriesPerServing: 100, servingSize: '150g', proteinG: 8, carbsG: 9, fatG: 3 },
  { name: 'Chin chin', categories: ['SNACK'], caloriesPerServing: 190, servingSize: '40g', proteinG: 3, carbsG: 26, fatG: 8 },
  { name: 'Palm oil', categories: ['FAT_OIL'], caloriesPerServing: 120, servingSize: '1 tbsp', proteinG: 0, carbsG: 0, fatG: 14 },
];

const US_FOODS: SeedFood[] = [
  { name: 'Grilled chicken breast', categories: ['PROTEIN'], caloriesPerServing: 165, servingSize: '100g' },
  { name: 'Brown rice', categories: ['CARBOHYDRATE'], caloriesPerServing: 215, servingSize: '1 cup cooked' },
  { name: 'Broccoli', categories: ['VEGETABLE'], caloriesPerServing: 55, servingSize: '1 cup' },
  { name: 'Greek yoghurt', categories: ['DAIRY'], caloriesPerServing: 100, servingSize: '170g' },
  { name: 'Apple', categories: ['FRUIT'], caloriesPerServing: 95, servingSize: '1 medium' },
  { name: 'Olive oil', categories: ['FAT_OIL'], caloriesPerServing: 119, servingSize: '1 tbsp' },
];

async function main() {
  console.log('🌱 Seeding Life Planner…');

  // --- Admins -------------------------------------------------------------
  const admin = await prisma.admin.upsert({
    where: { email: process.env.SEED_ADMIN_EMAIL ?? 'admin@lifeplanner.local' },
    update: {},
    create: {
      email: process.env.SEED_ADMIN_EMAIL ?? 'admin@lifeplanner.local',
      name: 'Super Admin',
      roles: ['SUPERADMIN'],
      passwordHash: await hash(process.env.SEED_ADMIN_PASSWORD ?? 'admin12345'),
    },
  });

  await prisma.admin.upsert({
    where: { email: 'support@lifeplanner.local' },
    update: {},
    create: {
      email: 'support@lifeplanner.local',
      name: 'Support Agent',
      roles: ['SUPPORT_ADMIN'],
      passwordHash: await hash('support12345'),
    },
  });

  // An admin who staffs two desks at once — the whole point of multi-role.
  const coach = await prisma.admin.upsert({
    where: { email: 'coach@lifeplanner.local' },
    update: {},
    create: {
      email: 'coach@lifeplanner.local',
      name: 'Maya Okafor',
      roles: ['LIFE_COACH_ADMIN', 'FITNESS_ADMIN'],
      bio: 'Life coach and fitness assistant. Ten years in behaviour change.',
      maxClients: 40,
      passwordHash: await hash('coach12345'),
    },
  });

  await prisma.admin.upsert({
    where: { email: 'manager@lifeplanner.local' },
    update: {},
    create: {
      email: 'manager@lifeplanner.local',
      name: 'Team Manager',
      roles: ['MANAGER'],
      passwordHash: await hash('manager12345'),
    },
  });

  // --- Food categories ----------------------------------------------------
  for (const category of DEFAULT_FOOD_CATEGORIES) {
    await prisma.foodCategoryTag.upsert({
      where: { key: category.key },
      update: {},
      create: category,
    });
  }

  const categoryIdByKey = new Map(
    (await prisma.foodCategoryTag.findMany({ select: { id: true, key: true } })).map((c) => [
      c.key,
      c.id,
    ]),
  );

  // --- Food catalog -------------------------------------------------------
  const seedFoods = async (country: string, foods: SeedFood[]) => {
    for (const { categories, ...food } of foods) {
      const connect = categories
        .map((key) => categoryIdByKey.get(key))
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ id }));

      await prisma.foodCatalogItem.upsert({
        where: { country_name: { country, name: food.name } },
        update: { categories: { set: connect } },
        create: { country, ...food, categories: { connect } },
      });
    }
  };

  await seedFoods('NG', NG_FOODS);
  await seedFoods('US', US_FOODS);

  // --- Demo user ----------------------------------------------------------
  const demoEmail = process.env.SEED_DEMO_EMAIL ?? 'demo@lifeplanner.local';
  const demo = await prisma.user.upsert({
    where: { email: demoEmail },
    update: {},
    create: {
      email: demoEmail,
      name: 'Demo User',
      timezone: 'Africa/Lagos',
      country: 'NG',
      icalToken: crypto.randomBytes(32).toString('base64url'),
      passwordHash: await hash(process.env.SEED_DEMO_PASSWORD ?? 'demo12345'),
      categories: { create: DEFAULT_CATEGORIES },
      settings: { create: { timezone: 'Africa/Lagos', theme: 'system' } },
    },
    include: { categories: true },
  });

  // A second user so board sharing is demonstrable out of the box.
  const partner = await prisma.user.upsert({
    where: { email: 'partner@lifeplanner.local' },
    update: {},
    create: {
      email: 'partner@lifeplanner.local',
      name: 'Partner User',
      timezone: 'Africa/Lagos',
      country: 'NG',
      icalToken: crypto.randomBytes(32).toString('base64url'),
      passwordHash: await hash('partner12345'),
      categories: { create: DEFAULT_CATEGORIES },
      settings: { create: { timezone: 'Africa/Lagos' } },
    },
  });

  const existingActivities = await prisma.activity.count({ where: { userId: demo.id } });
  if (existingActivities === 0) {
    const health = demo.categories.find((c) => c.name === 'Health');
    const work = demo.categories.find((c) => c.name === 'Work');

    const goal = await prisma.goal.create({
      data: {
        userId: demo.id,
        title: 'Run a half marathon',
        description: 'Train consistently through the season',
        targetDate: addDays(today, 120),
        milestones: {
          create: [
            { title: 'Run 10k without stopping', dueDate: addDays(today, 30), order: 0 },
            { title: 'Complete a 15k long run', dueDate: addDays(today, 75), order: 1 },
          ],
        },
      },
    });

    // Dated activities across the current week, some private.
    for (let offset = -2; offset <= 4; offset += 1) {
      const date = addDays(today, offset);
      await prisma.activity.create({
        data: {
          userId: demo.id,
          title: offset % 2 === 0 ? 'Morning run' : 'Deep work block',
          date,
          startTime: offset % 2 === 0 ? '06:30' : '09:00',
          endTime: offset % 2 === 0 ? '07:15' : '11:00',
          isDone: offset < 0,
          completedAt: offset < 0 ? date : null,
          categoryId: offset % 2 === 0 ? (health?.id ?? null) : (work?.id ?? null),
          goalId: offset % 2 === 0 ? goal.id : null,
          isPrivate: offset === 1, // one private row to exercise §18.1/§18.2
          history: { create: { changeType: 'CREATED' } },
        },
      });
    }

    // A flexible (non-date-specific) task — Addendum 2 §18.3.
    await prisma.activity.create({
      data: {
        userId: demo.id,
        title: '10,000 steps',
        description: 'Hit 10k steps — aiming for 3 times this week',
        date: null,
        windowStart: today,
        windowEnd: addDays(today, 6),
        targetCount: 3,
        completedCount: 1,
        categoryId: health?.id ?? null,
        history: { create: { changeType: 'CREATED' } },
      },
    });

    await prisma.dayNote.create({
      data: {
        userId: demo.id,
        date: addDays(today, -1),
        content: 'Good focus today, hit all my goals.',
        mood: 4,
      },
    });
  }

  // --- Board share: demo -> partner (PUBLIC_ONLY) --------------------------
  await prisma.boardShare.upsert({
    where: { ownerId_viewerId: { ownerId: demo.id, viewerId: partner.id } },
    update: {},
    create: {
      ownerId: demo.id,
      viewerId: partner.id,
      permission: 'PUBLIC_ONLY',
      status: 'ACTIVE',
    },
  });

  // --- Food inventory + a published meal plan ------------------------------
  const inventoryItems = await prisma.foodCatalogItem.findMany({
    where: { country: 'NG', name: { in: ['Jollof rice', 'Grilled tilapia', 'Efo riro (vegetable soup)', 'Akara (bean cakes)', 'Watermelon'] } },
  });
  for (const item of inventoryItems) {
    await prisma.userFoodInventory.upsert({
      where: { userId_foodItemId: { userId: demo.id, foodItemId: item.id } },
      update: {},
      create: { userId: demo.id, foodItemId: item.id },
    });
  }

  const existingPlan = await prisma.mealPlan.findUnique({
    where: { userId_date: { userId: demo.id, date: today } },
  });
  if (!existingPlan && inventoryItems.length >= 3) {
    await prisma.mealPlan.create({
      data: {
        userId: demo.id,
        createdByAdminId: admin.id,
        date: today,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        targetCalories: 2000,
        notes: 'High protein, low sugar per the user’s fitness goal',
        meals: {
          create: [
            {
              name: 'Breakfast',
              mealTime: 'BREAKFAST',
              order: 0,
              items: {
                create: [
                  { foodItemId: inventoryItems[3]?.id ?? inventoryItems[0].id, servings: 2, order: 0 },
                ],
              },
            },
            {
              name: 'Lunch',
              mealTime: 'LUNCH',
              estimatedCalories: 620,
              order: 1,
              items: {
                create: [
                  { foodItemId: inventoryItems[0].id, servings: 1, order: 0 },
                  // Weight is optional, and can sit alongside serving-based items.
                  { foodItemId: inventoryItems[2].id, weightGrams: 150, order: 1 },
                ],
              },
            },
            {
              name: 'Dinner',
              mealTime: 'DINNER',
              order: 2,
              items: { create: [{ foodItemId: inventoryItems[1].id, servings: 1, order: 0 }] },
            },
            {
              name: 'Evening snack',
              mealTime: 'AFTERNOON_SNACK',
              order: 3,
              items: { create: [{ freeText: 'Handful of groundnuts', servings: 1, order: 0 }] },
            },
          ],
        },
      },
    });
  }

  // --- Budget month --------------------------------------------------------
  const budgetMonth = await prisma.budgetMonth.upsert({
    where: {
      userId_year_month: {
        userId: demo.id,
        year: today.getUTCFullYear(),
        month: today.getUTCMonth() + 1,
      },
    },
    update: {},
    create: {
      userId: demo.id,
      year: today.getUTCFullYear(),
      month: today.getUTCMonth() + 1,
    },
  });

  const expenseCount = await prisma.budgetExpense.count({ where: { budgetMonthId: budgetMonth.id } });
  if (expenseCount === 0) {
    await prisma.budgetExpense.createMany({
      data: [
        { budgetMonthId: budgetMonth.id, title: 'Rent', amount: 150000, category: 'MANDATORY', status: 'PAID', paidAt: new Date() },
        { budgetMonthId: budgetMonth.id, title: 'Electricity', amount: 18000, category: 'MANDATORY', status: 'PAID', paidAt: new Date() },
        { budgetMonthId: budgetMonth.id, title: 'Groceries', amount: 40000, category: 'SECONDARY', status: 'COMMITTED' },
        { budgetMonthId: budgetMonth.id, title: 'Transport', amount: 22000, category: 'SECONDARY', status: 'COMMITTED' },
        { budgetMonthId: budgetMonth.id, title: 'Cinema + dinner', amount: 20000, category: 'OPTIONAL', status: 'COMMITTED' },
      ],
    });
  }

  // Several income sources, deliberately in different states, so the budget
  // screen has something realistic to render: salary already banked, one client
  // still owing, one that slipped from last month, and a recurring retainer.
  const incomeCount = await prisma.budgetIncome.count({ where: { budgetMonthId: budgetMonth.id } });
  if (incomeCount === 0) {
    await prisma.budgetIncome.create({
      data: {
        budgetMonthId: budgetMonth.id,
        title: 'Salary',
        source: 'Employer',
        description: 'Monthly net salary',
        amount: 320000,
        status: 'ARRIVED',
        receivedAt: new Date(today.getTime() - 4 * 86_400_000),
        expectedDate: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 25)),
        recurring: true,
        recurrenceKey: 'seed_salary',
      },
    });
    await prisma.budgetIncome.create({
      data: {
        budgetMonthId: budgetMonth.id,
        title: 'Acme Ltd — marketing site',
        source: 'Acme Ltd',
        description: 'Second milestone on the website build',
        amount: 180000,
        status: 'PROJECTED',
        expectedDate: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 28)),
      },
    });
    await prisma.budgetIncome.create({
      data: {
        budgetMonthId: budgetMonth.id,
        title: 'Design retainer',
        source: 'Studio Beko',
        amount: 60000,
        status: 'PROJECTED',
        recurring: true,
        recurrenceKey: 'seed_retainer',
      },
    });
  }

  // A slipped invoice: DEFERRED last month, re-projected into this one, so the
  // rollover badge has something to show.
  const lastMonthDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const lastMonth = await prisma.budgetMonth.upsert({
    where: {
      userId_year_month: {
        userId: demo.id,
        year: lastMonthDate.getUTCFullYear(),
        month: lastMonthDate.getUTCMonth() + 1,
      },
    },
    update: {},
    create: {
      userId: demo.id,
      year: lastMonthDate.getUTCFullYear(),
      month: lastMonthDate.getUTCMonth() + 1,
    },
  });

  const deferredExists = await prisma.budgetIncome.count({
    where: { budgetMonthId: lastMonth.id, status: 'DEFERRED' },
  });
  if (deferredExists === 0) {
    const slipped = await prisma.budgetIncome.create({
      data: {
        budgetMonthId: lastMonth.id,
        title: 'Kola & Sons — invoice #114',
        source: 'Kola & Sons',
        description: 'Client asked to push payment to next month',
        amount: 95000,
        status: 'DEFERRED',
      },
    });
    await prisma.budgetIncome.create({
      data: {
        budgetMonthId: budgetMonth.id,
        title: slipped.title,
        source: slipped.source,
        description: slipped.description,
        amount: slipped.amount,
        status: 'PROJECTED',
        rolledFromId: slipped.id,
      },
    });
  }

  // --- A conversation for the admin inbox ---------------------------------
  const conversationCount = await prisma.conversation.count({ where: { userId: demo.id } });
  if (conversationCount === 0) {
    await prisma.conversation.create({
      data: {
        userId: demo.id,
        type: 'LIFE_COACH',
        title: 'Need help planning my week',
        assignedAdminId: coach.id,
        status: 'CLAIMED',
        lastMessageAt: new Date(),
        messages: {
          create: {
            senderType: 'USER',
            senderUserId: demo.id,
            content: 'Hi, can you help me build a workout plan around my schedule?',
          },
        },
      },
    });

    // Support is open to every tier, so the Free account gets one too.
    await prisma.conversation.create({
      data: {
        userId: demo.id,
        type: 'SUPPORT',
        title: 'Billing question',
        lastMessageAt: new Date(),
        messages: {
          create: {
            senderType: 'USER',
            senderUserId: demo.id,
            content: 'Can I switch from monthly to quarterly halfway through?',
          },
        },
      },
    });
  }

  // --- A little analytics traffic so the dashboards aren't empty -----------
  const eventCount = await prisma.analyticsEvent.count();
  if (eventCount === 0) {
    const paths = ['/', '/dashboard', '/calendar', '/goals', '/budget', '/nutrition'];
    const rows = [];
    for (let day = 0; day < 14; day += 1) {
      for (let i = 0; i < 6; i += 1) {
        rows.push({
          type: 'PAGE_VIEW' as const,
          path: paths[(day + i) % paths.length],
          sessionId: `seed-session-${day}-${i % 3}`,
          userId: i % 2 === 0 ? demo.id : null,
          createdAt: addDays(today, -day),
        });
      }
    }
    await prisma.analyticsEvent.createMany({ data: rows });
  }

  // --- Country configuration -------------------------------------------------
  // Currency, provider and tax per market. Pricing is then set deliberately per
  // country below rather than derived from an FX rate.
  const COUNTRIES = [
    { code: 'NG', name: 'Nigeria', currency: 'NGN', defaultProvider: 'PAYSTACK' as const, taxRate: 0.075, taxType: 'VAT' },
    { code: 'KE', name: 'Kenya', currency: 'KES', defaultProvider: 'PAYSTACK' as const, taxRate: 0.16, taxType: 'VAT' },
    { code: 'GH', name: 'Ghana', currency: 'GHS', defaultProvider: 'PAYSTACK' as const, taxRate: 0.15, taxType: 'VAT' },
    { code: 'ZA', name: 'South Africa', currency: 'ZAR', defaultProvider: 'PAYSTACK' as const, taxRate: 0.15, taxType: 'VAT' },
    { code: 'GB', name: 'United Kingdom', currency: 'GBP', defaultProvider: 'PADDLE' as const, taxRate: 0.2, taxType: 'VAT' },
    { code: 'US', name: 'United States', currency: 'USD', defaultProvider: 'PADDLE' as const, taxRate: 0, taxType: null },
    { code: 'CA', name: 'Canada', currency: 'CAD', defaultProvider: 'PADDLE' as const, taxRate: 0.05, taxType: 'GST' },
    { code: 'DE', name: 'Germany', currency: 'EUR', defaultProvider: 'PADDLE' as const, taxRate: 0.19, taxType: 'VAT' },
  ];

  for (const country of COUNTRIES) {
    await prisma.countryConfig.upsert({
      where: { code: country.code },
      update: {},
      create: country,
    });
  }

  // --- Personality notes (admin eyes only) ----------------------------------
  // What the desks should know about how to work with this person. Never
  // exposed on any user-facing endpoint.
  await prisma.user.update({
    where: { id: demo.id },
    data: {
      personalityNotes: [
        'Two young children — evenings are rarely free',
        'Answers voice notes faster than text',
        'Runs a tight monthly budget — flag any price change',
        'Vegetarian, avoids dairy',
        'Travels often, timezone shifts most months',
      ],
    },
  });

  // --- Plan catalog ----------------------------------------------------------
  // Solo prices per market; the 2- and 3-person rows are generated from the
  // 1.8x / 2.5x curve. All customer-facing copy lives in the row so wording and
  // price can change from the admin API without a frontend deploy.
  const SEAT_MULTIPLIER: Record<number, number> = { 1: 1, 2: 1.8, 3: 2.5 };

  const SOLO_PRICES: { region: string; currency: string; monthly: number; quarterly: number }[] = [
    { region: '', currency: 'USD', monthly: 9, quarterly: 24 },
    { region: 'NG', currency: 'NGN', monthly: 4500, quarterly: 12000 },
    { region: 'KE', currency: 'KES', monthly: 900, quarterly: 2400 },
    { region: 'GH', currency: 'GHS', monthly: 75, quarterly: 200 },
    { region: 'ZA', currency: 'ZAR', monthly: 129, quarterly: 349 },
    { region: 'GB', currency: 'GBP', monthly: 8, quarterly: 21 },
    { region: 'US', currency: 'USD', monthly: 12, quarterly: 32 },
    { region: 'CA', currency: 'CAD', monthly: 15, quarterly: 40 },
    { region: 'DE', currency: 'EUR', monthly: 11, quarterly: 29 },
  ];

  const PRIVACY_NOTE_SHARED =
    'Everyone on this plan keeps a completely private planner. You are paying for their access, nothing more — you cannot see their activities, goals, notes, budget or chats, and they cannot see yours. The only way to share anything is if one of you chooses to share a board.';

  const PRIVACY_NOTE_SOLO = 'Your planner is yours alone. Nothing is shared unless you choose to share a board.';

  const PRO_FEATURES = [
    'Your own Life Coach and Fitness Assistant',
    'Voice notes in chat',
    'Personalised meal plans',
    'Unlimited activities and goals',
  ];

  const seatName = (seats: number) =>
    seats === 1 ? 'Pro' : seats === 2 ? 'Pro for two' : 'Pro for three';

  const seatDescription = (seats: number, interval: string) => {
    const cadence = interval === 'MONTHLY' ? 'month' : 'quarter';
    if (seats === 1) {
      return `Everything in Life Planner, for you. Billed every ${cadence}, cancel whenever you like.`;
    }
    const saving = Math.round((1 - SEAT_MULTIPLIER[seats] / seats) * 100);
    return `Cover ${seats} people on one bill and save about ${saving}% each. Every person gets their own full Pro account — their own coach, their own fitness assistant, their own private planner. Billed every ${cadence} to you; you can drop back to a smaller plan at the end of any billing period.`;
  };

  const planRows: any[] = [];

  // Free is the same everywhere, so it only needs the fallback row.
  planRows.push({
    tier: 'FREE' as const,
    interval: 'MONTHLY' as const,
    currency: 'USD',
    region: '',
    seats: 1,
    amount: 0,
    name: 'Free',
    description:
      'The planner, calendar, goals, streaks and insights — free forever. Support chat is always available if you need us.',
    privacyNote: PRIVACY_NOTE_SOLO,
    features: [
      'Calendar, goals and streaks',
      'Flexible tasks and insights',
      'Support chat, always',
      '5 activities a week, 3 goals',
      'No coach or fitness chats',
    ],
    sortOrder: 0,
  });

  for (const price of SOLO_PRICES) {
    for (const interval of ['MONTHLY', 'QUARTERLY'] as const) {
      const solo = interval === 'MONTHLY' ? price.monthly : price.quarterly;
      for (const seats of [1, 2, 3]) {
        const amount = Math.round(solo * SEAT_MULTIPLIER[seats] * 100) / 100;
        planRows.push({
          tier: 'PRO' as const,
          interval,
          currency: price.currency,
          region: price.region,
          seats,
          amount,
          name: seatName(seats),
          description: seatDescription(seats, interval),
          privacyNote: seats === 1 ? PRIVACY_NOTE_SOLO : PRIVACY_NOTE_SHARED,
          features:
            seats === 1
              ? PRO_FEATURES
              : [...PRO_FEATURES, `Covers ${seats} people, each with their own private account`],
          highlight: seats === 1 && interval === 'MONTHLY',
          sortOrder: seats,
          paddlePriceId: price.region === '' || price.currency !== 'NGN' ? `pri_pro_${interval.toLowerCase()}_${seats}` : null,
          paystackPlanId: ['NG', 'KE', 'GH', 'ZA'].includes(price.region) ? `PLN_pro_${interval.toLowerCase()}_${seats}` : null,
          appleProductId: `app.lifeplanner.pro.${interval.toLowerCase()}.${seats}`,
          googleProductId: `app.lifeplanner.pro.${interval.toLowerCase()}.${seats}`,
        });
      }
    }
  }

  for (const { tier, interval, currency, region, seats, ...rest } of planRows) {
    await prisma.planCatalogEntry.upsert({
      where: { tier_interval_seats_currency_region: { tier, interval, seats, currency, region } },
      update: { ...rest },
      create: { tier, interval, currency, region, seats, ...rest },
    });
  }

  // --- Cartoon avatar presets ------------------------------------------------
  for (const preset of [
    { key: 'fox', label: 'Fox', category: 'animals', sortOrder: 0 },
    { key: 'owl', label: 'Owl', category: 'animals', sortOrder: 1 },
    { key: 'cat', label: 'Cat', category: 'animals', sortOrder: 2 },
    { key: 'panda', label: 'Panda', category: 'animals', sortOrder: 3 },
    { key: 'dawn', label: 'Dawn', category: 'abstract', sortOrder: 4 },
    { key: 'dusk', label: 'Dusk', category: 'abstract', sortOrder: 5 },
  ]) {
    await prisma.avatarPreset.upsert({
      where: { key: preset.key },
      update: {},
      create: { ...preset, url: `/avatars/presets/${preset.key}.svg` },
    });
  }

  // --- Landing-page content --------------------------------------------------
  // Reseeding should refresh marketing copy, not silently keep the old row.
  const siteContent = {
      contactEmail: 'hello@lifeplanner.app',
      supportEmail: 'support@lifeplanner.app',
      contactPhone: '+234 802 000 0000',
      contactAddress: '14 Adeola Odeku Street, Victoria Island, Lagos, Nigeria',
      heroHeadline: 'A calm canvas for a colorful life',
      heroSubhead:
        'Plan your days, keep your goals in view, and get a real coach in your corner — without the noise.',
      heroCtaLabel: 'Start planning',
      features: [
        { title: 'Your week, at a glance', body: 'A calendar that shows what matters and hides what does not.', icon: 'calendar' },
        { title: 'Goals that stay visible', body: 'Milestones and streaks, so progress is something you can see.', icon: 'flag' },
        { title: 'A coach who knows you', body: 'A life coach and a fitness assistant, in chat, whenever you need them.', icon: 'message' },
        { title: 'Money without the dread', body: 'Track what has actually landed, not just what you hoped for.', icon: 'wallet' },
      ],
      faqs: [
        { question: 'Is there a free plan?', answer: 'Yes. The planner, goals and Support chat are free forever. Coaching, voice notes and meal plans are Pro.' },
        { question: 'Can I pay for someone else?', answer: 'Yes — a plan can cover two or three people. Everyone keeps their own private account; you are paying for their access, nothing more.' },
        { question: 'Can my partner see my planner?', answer: 'Only if you share a board with them, and only what you choose to share. Nobody sees your planner by default.' },
        { question: 'What happens if I cancel?', answer: 'You keep Pro until the end of the period you paid for, then drop to Free. Nothing is deleted.' },
      ],
      aboutHeadline: 'A calm canvas for a colorful life',
      aboutBody:
        'Life Planner pairs a quiet, well-made planner with real people — a life coach and a fitness assistant — so the plan you make is one you actually keep.',
      socialLinks: { x: 'https://x.com/lifeplanner', linkedin: 'https://linkedin.com/company/lifeplanner' },
  };

  await prisma.siteContent.upsert({
    where: { id: 'singleton' },
    update: siteContent,
    create: { id: 'singleton', ...siteContent },
  });

  if ((await prisma.staffMember.count()) === 0) {
    await prisma.staffMember.createMany({
      data: [
        { name: 'Adaeze Nwosu', position: 'Founder & CEO', sortOrder: 0, bio: 'Built Life Planner after years of watching good plans die in bad tools.' },
        { name: 'Maya Okafor', position: 'Head of Coaching', sortOrder: 1, bio: 'Ten years in behaviour change; leads the coaching desk.' },
        { name: 'Tunde Bello', position: 'Head of Engineering', sortOrder: 2 },
        { name: 'Sarah Idowu', position: 'Nutrition Lead', sortOrder: 3 },
      ],
    });
  }

  // --- Demo subscription -----------------------------------------------------
  // The demo account is PRO so every paywalled surface is reachable. Flip tier
  // to FREE, or status to EXPIRED, to exercise the gated states instead.
  const periodEnd = new Date(today.getTime() + 24 * 86_400_000);
  const subscription = await prisma.subscription.upsert({
    where: { userId: demo.id },
    update: {},
    create: {
      userId: demo.id,
      tier: 'PRO',
      status: 'ACTIVE',
      interval: 'MONTHLY',
      currency: 'NGN',
      amount: 4500,
      provider: 'PAYSTACK',
      platform: 'WEB',
      providerCustomerId: 'CUS_demo',
      providerSubscriptionId: 'SUB_demo',
      startedAt: new Date(today.getTime() - 6 * 86_400_000),
      activatedAt: new Date(today.getTime() - 6 * 86_400_000),
      currentPeriodEnd: periodEnd,
      renewsAt: periodEnd,
    },
  });

  if ((await prisma.transaction.count({ where: { userId: demo.id } })) === 0) {
    // Nigerian VAT is 7.5% and inclusive of the ₦4,500 price, so net + tax = gross.
    await prisma.transaction.create({
      data: {
        userId: demo.id,
        subscriptionId: subscription.id,
        type: 'INITIAL',
        status: 'SUCCEEDED',
        provider: 'PAYSTACK',
        platform: 'WEB',
        providerTransactionId: 'lp_demo_txn_0001',
        currency: 'NGN',
        grossAmount: 4500,
        netAmount: 4186.05,
        taxAmount: 313.95,
        taxRate: 0.075,
        taxCountry: 'NG',
        taxType: 'VAT',
        merchantOfRecord: 'SELF',
        providerFee: 67.5,
        payoutAmount: 4432.5,
        settlementCurrency: 'NGN',
        settlementAmount: 4432.5,
        billingCountry: 'NG',
        description: 'MONTHLY Pro via Paystack',
        occurredAt: new Date(today.getTime() - 6 * 86_400_000),
      },
    });
  }

  for (const role of ['LIFE_COACH', 'FITNESS'] as const) {
    const existing = await prisma.coachAssignment.findFirst({
      where: { userId: demo.id, role, status: 'ACTIVE' },
    });
    if (!existing) {
      await prisma.coachAssignment.create({ data: { userId: demo.id, adminId: coach.id, role } });
    }
  }

  await prisma.conversation.upsert({
    where: { userId_type: { userId: demo.id, type: 'FITNESS' } },
    update: {},
    create: {
      userId: demo.id,
      type: 'FITNESS',
      title: 'Training around a desk job',
      assignedAdminId: coach.id,
      status: 'CLAIMED',
      lastMessageAt: new Date(),
      messages: {
        create: {
          senderType: 'ADMIN',
          senderAdminId: coach.id,
          content: 'Three runs in a row this week — the hardest part is behind you. 🎉',
        },
      },
    },
  });

  if ((await prisma.notification.count({ where: { userId: demo.id } })) === 0) {
    await prisma.notification.createMany({
      data: [
        { userId: demo.id, type: 'COACH_REPLY', title: 'Maya replied', body: 'Three days of runs in a row — the hardest part is behind you.', href: '/chats' },
        { userId: demo.id, type: 'MEAL_PLAN_PUBLISHED', title: 'Your meal plan is ready', body: 'Today’s plan is published.', href: '/nutrition' },
        { userId: demo.id, type: 'STREAK_MILESTONE', title: '5-day streak', body: 'Five days running. Keep it going.', href: '/insights', readAt: new Date() },
      ],
    });
  }

  if ((await prisma.coachInsight.count({ where: { userId: demo.id } })) === 0) {
    await prisma.coachInsight.create({
      data: {
        userId: demo.id,
        adminId: coach.id,
        headline: 'Work took 41% of your week',
        body: 'Work took 41% of your week. Want to protect two evenings next week?',
        periodStart: new Date(today.getTime() - 6 * 86_400_000),
        periodEnd: today,
      },
    });
  }

  console.log(`✅ Seed complete.
   Admin:   ${admin.email} / ${process.env.SEED_ADMIN_PASSWORD ?? 'admin12345'} (SUPERADMIN)
   Support: support@lifeplanner.local / support12345 (SUPPORT_ADMIN)
   Coach:   coach@lifeplanner.local / coach12345 (LIFE_COACH_ADMIN + FITNESS_ADMIN)
   Manager: manager@lifeplanner.local / manager12345 (MANAGER)
   User:    ${demo.email} / ${process.env.SEED_DEMO_PASSWORD ?? 'demo12345'} — PRO
   Partner: partner@lifeplanner.local / partner12345 (has PUBLIC_ONLY access to the demo board)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
