# Life Planner — Backend

A calm canvas for a colorful life. Two independently deployable Express/TypeScript services over a
shared Prisma/PostgreSQL database, implementing the base specification **and Addendum 2**
(admin moderation & analytics, task privacy, board sharing, flexible tasks, nutrition board,
budget tracker).

```
lifeplanner-backend/
├── apps/
│   ├── user-api/       Express + Socket.IO   :4000   /api/v1
│   └── admin-api/      Express               :4001   /admin/v1
├── packages/
│   ├── database/       Prisma schema, client singleton, seed script
│   └── shared-utils/   Zod schemas, response envelope, errors, constants, date helpers
├── docker-compose.yml  Postgres 16 + Redis 7
└── turbo.json
```

---

## Quick start

```bash
# 1. Prerequisites: Node 20+, pnpm 9+, Docker
cp .env.example .env

# 2. Infrastructure
docker compose up -d

# 3. Install, generate the Prisma client, create the schema, seed
pnpm install
pnpm db:generate
pnpm db:push          # or: pnpm db:migrate  (for a versioned migration)
pnpm db:seed

# 4. Run both services
pnpm dev              # or: pnpm dev:user / pnpm dev:admin
```

Health checks: <http://localhost:4000/health> · <http://localhost:4001/health>

### Seeded credentials

| Account | Email | Password | Notes |
| --- | --- | --- | --- |
| Admin | `admin@lifeplanner.local` | `admin12345` | SUPERADMIN |
| Support | `support@lifeplanner.local` | `support12345` | SUPPORT |
| User | `demo@lifeplanner.local` | `demo12345` | Sample board, budget, meal plan |
| Partner | `partner@lifeplanner.local` | `partner12345` | Holds `PUBLIC_ONLY` access to the demo board |

The demo user ships with a private activity and a flexible "10,000 steps ×3" task, so the
privacy and board-sharing rules are observable immediately.

---

## Conventions

**Response envelope.** Every route answers with `{ success: true, data }` or
`{ success: false, error: { code, message, details? } }`. No exceptions, including errors raised
by the validation and 404 middleware.

**Ownership scoping.** Every user-api query is filtered by `userId` before anything else. There is
no route where an id alone grants access.

**Soft delete.** `deletedAt` on activities, categories and goals; revocation (a status flip) rather
than deletion for board shares and refresh tokens, so history stays auditable.

**Validation at the boundary.** Zod schemas live in `packages/shared-utils/src/schemas` — one per
endpoint body/query, with `z.infer` as the DTO. Parsed values replace the raw request segment, so
handlers always see coerced, defaulted data.

**Auth separation.** User tokens are signed with `JWT_ACCESS_SECRET`; admin tokens with
`ADMIN_JWT_SECRET`. A user token presented to an admin route fails signature verification — the two
services cannot be crossed. Refresh tokens are opaque random strings; only their SHA-256 hash is
stored, and every refresh rotates.

**Money.** `Decimal(12,2)` for `estimatedIncome` and `amount`, never `Float`. The Zod layer accepts a
plain JS number and Prisma handles the conversion.

---

## Addendum 2 — how each feature is implemented

### Task privacy (§18.1)
`Activity.isPrivate` defaults to `false` and is toggled through the existing
`PATCH /activities/:id`. Enforcement lives entirely in read paths that cross a user boundary:

- the **owner** always sees 100% of their own board;
- a **board-share viewer** sees private rows only when their permission is `FULL`;
- an **admin** always sees everything — moderation requires full visibility;
- the **public iCal feed** never includes private activities.

No field is added to `Activity` for sharing; the filter is applied at read time only.

### Board sharing (§18.2)
Each `BoardShare` row is a **one-way** grant. "Bidirectional" means two independently created rows,
each carrying its own permission level — A may grant B `FULL` while B grants A `PUBLIC_ONLY`. The
unique `[ownerId, viewerId]` constraint makes re-inviting an update rather than a duplicate, and
revocation flips `status` to `REVOKED` instead of deleting.

### Flexible (non-date) tasks (§18.3)
One table, two shapes, enforced by Zod rather than a DB check constraint:

| | Dated task | Flexible task |
| --- | --- | --- |
| `date` | set | `null` |
| `windowStart` / `windowEnd` | `null` | set (`end >= start`) |
| completion | `isDone` via `PATCH /activities/:id/toggle` | `completedCount` via `PATCH /activities/:id/progress` |

`/progress` increments, clamps at `targetCount`, flips `isDone` when the target is met, and appends
a `TOGGLED` history row. Calling the wrong endpoint for a shape returns 400 with a specific code.
`GET /activities` without `flexible=` keeps its original dated-only behavior, so existing callers
are unaffected.

**Calendar and streaks.** `GET /calendar` and `/calendar/week` key day buckets off `date`, so
flexible tasks appear in a separate top-level `flexibleTasks` array rather than inside a day. Streaks
scan dated activities only — flexible tasks are excluded **by design**, not by oversight.

### Nutrition board (§18.4)
`FoodCatalogItem` is a shared, country-scoped, admin-managed reference table (`country` is a plain
string so a new country is a data insert, not a migration). Users build a `UserFoodInventory` from it
— `PUT /food-inventory` replaces the whole selection, the natural shape for a multi-select widget.
Plans are **hand-built by admins**: there is no recommendation algorithm in this iteration.
`DRAFT` plans are invisible to the user; only `PUBLISHED` ones are ever returned.

### Budget tracker (§18.5)
One `BudgetMonth` per user per year/month, expenses attached to it. Colors are fixed **per category**
(`BUDGET_CATEGORY_COLORS` in shared-utils) and returned alongside category totals, so the frontend
never hardcodes them twice. `GET /budget/:year/:month/summary?category=X` narrows
`totalExpenses`/`estimatedBalance` to X while still listing all three subtotals for context.

### Admin moderation (§18.6)
`status` gates both the login/refresh handlers and `requireAuth` — one centralized check on the same
query that already loads the user for JWT validation. `BANNED` additionally revokes every refresh
token so live sessions die immediately; `SUSPENDED` lets access tokens expire naturally (≤15 min)
but blocks refresh. Admin-initiated task deletion soft-deletes and writes a `DELETED_BY_ADMIN`
history row carrying the acting `adminId`.

### Site analytics (§18.7)
`POST /analytics/events` sits behind `optionalAuth`, which attaches `req.user` when a valid token is
present and continues silently when it is not — page views happen before login too. It gets its own
generously sized rate-limit bucket keyed by session. **Signups are derived** from `User.createdAt`
rather than logged as events, so there is only ever one source of truth for that fact.

---

## Endpoint reference

### user-api — `/api/v1`

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` · `/auth/login` · `/auth/refresh` · `/auth/logout` | Session lifecycle |
| GET/PATCH | `/auth/me` | Profile |
| POST | `/auth/change-password` · `/auth/forgot-password` · `/auth/reset-password` | Password flows |
| GET/POST | `/categories` · PATCH/DELETE `/categories/:id` | Categories |
| GET/POST | `/activities` · GET/PATCH/DELETE `/activities/:id` | Activities (`?flexible=&activeOn=`) |
| POST | `/activities/bulk` · `/activities/reorder` | Range create, per-day ordering |
| PATCH | `/activities/:id/toggle` | Dated completion |
| **POST** | **`/activities/flexible`** | Create a non-date-specific task |
| **PATCH** | **`/activities/:id/progress`** | Log progress toward `targetCount` |
| GET | `/activities/:id/history` | Audit trail |
| GET | `/calendar` · `/calendar/week` | Day buckets + `flexibleTasks` |
| PUT/GET/DELETE | `/days/:date/note` | Day notes |
| GET/POST | `/goals` · GET/PATCH/DELETE `/goals/:id` · `/goals/:id/milestones` | Goals |
| GET/POST | `/tags` · PATCH/DELETE `/tags/:id` | Tags |
| GET/POST | `/recurring` · PATCH/DELETE `/recurring/:id` | RRULE templates |
| GET | `/stats/overview` · `/stats/categories` · `/stats/streaks` · `/stats/mood` | Stats |
| GET/POST | `/reminders` · DELETE `/reminders/:id` | Reminders |
| GET/POST | `/ical/feed-url` · `/ical/rotate` | Tokenized feed (feed itself at `/ical/:token.ics`) |
| GET/POST | `/chat/conversations` · `/chat/conversations/:id/messages` | Coaching chat |
| GET/PUT/PATCH | `/settings` | Preferences |
| **POST/GET** | **`/board-shares`** · PATCH/DELETE `/board-shares/:id` | Board-sharing grants |
| **GET** | **`/users/:id/board`** | View a shared board |
| **GET** | **`/food-catalog`** | Country-scoped catalog |
| **GET/PUT** | **`/food-inventory`** · POST/DELETE `/food-inventory/:foodItemId` | Available foods |
| **GET** | **`/meal-plans`** · `/meal-plans/:date` | Published plans only |
| **GET/PUT** | **`/budget/:year/:month`** | Estimated income |
| **GET/POST** | **`/budget/:year/:month/expenses`** · PATCH/DELETE `/budget/expenses/:id` | Expenses |
| **GET** | **`/budget/:year/:month/summary`** | Balance, overall or by category |
| **POST** | **`/analytics/events`** | Page view / custom event (auth optional) |

### admin-api — `/admin/v1`

| Method | Path | Purpose |
| --- | --- | --- |
| POST/GET | `/auth/login` · `/auth/refresh` · `/auth/logout` · `/auth/me` | Admin session |
| GET/POST | `/admins` · DELETE `/admins/:id` | Admin accounts (SUPERADMIN) |
| GET | `/inbox` · `/inbox/counts` | Support inbox |
| GET/POST | `/conversations/:id` · `/claim` · `/messages` · `/close` · `/reopen` | Conversation handling |
| **GET** | **`/users?q=&status=&page=`** | Search / filter users |
| GET | `/users/:id` | User detail |
| **GET** | **`/users/:id/board`** | Read-only board, private tasks included |
| **POST** | **`/users/:id/suspend`** · **`/ban`** · **`/reinstate`** | Moderation |
| **DELETE** | **`/users/:id/activities/:activityId`** | Audited task removal |
| **GET** | **`/analytics/overview`** · **`/pages`** · **`/signups`** | Site analytics |
| **GET/POST** | **`/food-catalog`** · PATCH/DELETE `/food-catalog/:id` | Catalog management |
| **GET** | **`/users/:id/food-inventory`** · **`/users/:id/meal-plans`** | Planning context |
| **PUT/DELETE** | **`/users/:id/meal-plans/:date`** | Author / remove a day's plan |

Bold rows are new in Addendum 2.

---

## Background jobs

| Job | Schedule | Behavior |
| --- | --- | --- |
| Recurring materializer | hourly | Expands active RRULE templates up to `RECURRING_HORIZON_DAYS`. Idempotent — existing dates are skipped. |
| Reminder dispatcher | every minute | Sends due `PENDING` reminders (email prints to the console by default), cancels reminders for non-active accounts. |

Set `ENABLE_JOBS=false` to run an instance as a pure API node.

## Real time

user-api runs Socket.IO with the Redis adapter. Clients authenticate in the handshake with their
access token; the handshake re-checks account status, so a banned user cannot open a new connection.

**Messages are persisted over REST and broadcast over the socket — never both.** admin-api does not
run its own Socket.IO server; it publishes onto a Redis channel (`lifeplanner:realtime`) that
user-api subscribes to and re-broadcasts into the right room. This keeps a single write path while
letting an admin reply reach the user's browser instantly.

Client events: `conversation:join`, `conversation:leave`, `typing`.
Server events: `message:new`, `conversation:claimed`, `conversation:closed`, `conversation:reopened`,
`reminder:due`, `account:banned`.

## Environment

See `.env.example`. Required: `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`ADMIN_JWT_SECRET`, `ADMIN_JWT_REFRESH_SECRET`. Both services validate their environment with Zod at
boot and exit with a readable message if anything is missing.

## Decisions carried over from Addendum 2 §23

These were defaulted to keep momentum; each is a small, localized change to flip.

1. **Board-share acceptance** — no viewer approval; the owner's grant takes effect immediately.
2. **Flexible task semantics** — a count of completions ("3 times this week"), not a cumulative
   numeric target with units.
3. **Meal-plan authoring** — fully manual, one admin per plan; no co-editing, no suggestion algorithm.
4. **Suspension vs. ban** — two severities on one field; no scheduled auto-expiry.
5. **Analytics retention** — no TTL yet. `AnalyticsEvent` grows unbounded; agree a retention window
   before this sees production traffic.
6. **Admin role scoping** — catalog and meal-plan management are open to `SUPPORT` and `SUPERADMIN`;
   only admin-account management is SUPERADMIN-gated.

Also still open from the earlier round: **shared/household plans**. If a workspace ownership model is
on the roadmap, it gets more expensive to retrofit with every endpoint added.

---

# Addendum 3

Subscriptions and multi-provider billing, five-level admin RBAC, three chat
types with coach assignment, message editing and soft delete, voice notes,
notifications, the meal redesign, and landing-page content.

## What changed at the model level

`schema.v2.bak` sits beside the current schema if you need to compare.

| Area | Change |
| --- | --- |
| Admins | `Admin.role` → `Admin.roles AdminRole[]`. One admin holds several levels at once. |
| Chats | `Conversation.channel` → `Conversation.type` (`LIFE_COACH`, `FITNESS`, `SUPPORT`), unique per user. |
| Messages | Gained `kind`, `replyToId`, `editedAt`/`editCount`, `deletedAt`/`purgeAfter`, plus `MessageEdit`, `MessageReaction`, `MessageAttachment`. |
| Meals | `MealPlanItem` replaced by `Meal` → `MealItem`. Foods carry many categories via `FoodCategoryTag`. |
| Billing | New `Subscription`, `Transaction`, `WebhookEvent`, `PlanCatalogEntry`. |
| Media | New `MediaAsset` and `AvatarPreset`. |

## Tiers and gating

`GET /api/v1/subscription` is the only endpoint the gating layer reads. It
returns limits **and** current usage together, so the client can render
"3 / 5 activities this week" without a second round trip and the quota rule
stays server-side.

| | Free | Pro | Expired |
| --- | --- | --- | --- |
| Activities per week | `FREE_MAX_ACTIVITIES_PER_WEEK` (5) | unlimited | 0 |
| Goals | `FREE_MAX_GOALS` (3) | unlimited | 0 |
| Life Coach / Fitness chat | ✗ | ✓ | ✗ |
| Voice notes | ✗ | ✓ | ✗ |
| Meal plans | ✗ | ✓ | ✗ |
| **Support chat** | **✓** | **✓** | **✓** |

Support is never paywalled. A Free user must always be able to raise a
complaint, so that one channel is exempt at every tier.

Chats are now fully behind the paywall — there is no daily allowance any more.
A blocked call returns **402** with `details.upgradeRequired: true`.

A lapsed plan is treated as expired **at read time**, so entitlement never
depends on the nightly sweep having run. The cron job only handles
notifications and releasing coaches.

## Payment routing

| Platform | Region | Provider | Merchant of record |
| --- | --- | --- | --- |
| Web | Africa | Paystack | us |
| Web | elsewhere | Paddle | Paddle |
| iOS | worldwide | App Store | Apple |
| Android | worldwide | Play Store | Google |

The country comes from `PUT /subscription/region` — mobile reports the store
front it is signed into, web reports its own guess. That one value drives both
the food catalog and which rails checkout uses.

`Transaction` deliberately stores tax, store commission and PSP fees as separate
columns rather than deriving them. VAT has to be separable per jurisdiction, and
a 30% Apple commission is a different thing from a Paystack processing fee.
`grossAmount = netAmount + taxAmount`; everything else is deducted from gross to
reach `payoutAmount`. Revenue reports never sum across currencies.

Entitlement is granted **only** by a verified webhook or a verified store
receipt — never by the checkout call, and never by the client declaring a tier.
Webhooks are signature-verified and idempotent on `(provider, eventId)`, which
is what stops a retried renewal being counted twice.

## Admin roles

`FITNESS_ADMIN`, `LIFE_COACH_ADMIN`, `SUPPORT_ADMIN`, `MANAGER`, `SUPERADMIN`.
An admin holds any combination.

- A coach sees only the conversation types they staff, and only their own or
  unassigned threads.
- **Manager and Super Admin alone** can read other admins' chats and client
  lists, reassign work, and open the audit view.
- Roles are re-read from the database on every request rather than trusted from
  the token, so a demotion takes effect immediately instead of at token expiry.

On activation, a Pro subscription assigns a Life Coach and a Fitness Assistant
by least-loaded round robin, skipping anyone unavailable or at `maxClients`, and
opens the matching conversations. It is idempotent, so a renewal never
reshuffles coaches.

## Messages

Editing is soft: the current text lives on `Message.content` and every prior
version in `MessageEdit`. Deleting is soft too, with a 30-day retention window
(`MESSAGE_PURGE_DAYS`) before the nightly job removes the row for good. Users
never see deleted messages or edit history; Managers and Super Admins see both
via `?includeDeleted=true`. A quoted message that was later deleted renders as a
tombstone rather than leaking its text.

Emoji are plain unicode in `content` — no special handling. Reactions are a
separate model and toggle off when the same emoji is sent twice.

## Storage

`STORAGE_DRIVER=local` writes to `LOCAL_STORAGE_DIR` and serves from `/media`,
so avatars and voice notes work end to end with no Cloudflare account. Set
`STORAGE_DRIVER=r2` and the R2 credentials for production; requests are signed
with SigV4 directly rather than pulling in the AWS SDK for a single PUT.

**Waveforms are an approximation.** Measuring true amplitude means decoding
Opus/AAC, which needs ffmpeg. `lib/audio.ts` computes an energy envelope over
the compressed byte stream instead. It is deterministic, so sender and recipient
always render identical bars, and it looks right — but it is not real PCM. If
ffmpeg is added to the image later, swap the body of that one function; nothing
else has to change.

## Decisions worth knowing

- **Imported calendar events are a read-only overlay** (`ImportedEvent`), not
  `Activity` rows. They are not editable, do not count toward quota and do not
  affect streaks.
- **Accepting a coach's recommendation still respects the user's quota** — a
  coach cannot spend someone's Free allowance on their behalf.
- **Feedback forms snapshot the coach ids** being rated, so a later reassignment
  does not rewrite history.
- **`/meal-plans/requests` is mounted before `/meal-plans`** — otherwise the
  `:date` param route swallows it.

## Still open

Shared/household plans. Board shares, meal plans, budgets and inventories all
still assume a single `userId` owner, and retrofitting a workspace model gets
more expensive with every endpoint added.

---

# Family plans (seats)

## Why seats, not shared spaces

The obvious way to build "pay for two people" is co-ownership: a household that
jointly owns budgets, meal plans and boards. We deliberately did not do that.

**A seat grants entitlement, never ownership.** Nothing becomes co-owned. Every
person keeps a completely separate account with their own coach, their own
fitness assistant and their own private planner. `BoardShare` remains the one
and only way anyone sees anyone else's data — at the *beneficiary's* own
initiative, never the payer's.

This closes the workspace-ownership question that had been open since the first
addendum. There is no `spaceId`, no ownership retrofit across the schema, and no
second sharing mechanism competing with `BoardShare`. **The decision is settled:
one row belongs to exactly one person, permanently.**

It also fits the payment rails cleanly — a two-seat plan is simply a different
product with its own price id on all four providers. No Apple Family Sharing, no
cross-account entitlement games.

## The privacy guarantee

The payer gets **no read path whatsoever** into a beneficiary's data — not their
activities, goals, notes, budget, meals or chats, and not even a count of them.
Seats touch the entitlement check and nothing else. There are expected-failure
tests covering exactly this so it cannot quietly regress.

Two details that follow from taking this seriously:

- A beneficiary sees `source: "SEAT"` and who provides it, so they understand
  why they have Pro and who can end it. That is the only thing either party
  learns about the other.
- A declined invitation reads as `DECLINED` to the payer whether the person
  simply said no or reported it as unsolicited. Telling someone they had been
  reported would expose the reporter and defeat the point of offering the
  report link. Reports go to the admin abuse queue instead.

## Pricing

Seats are priced at **1× / 1.8× / 2.5×** for one, two and three people. The
multiplier lives in the seed, not the code — the rows it generates are ordinary
catalog entries an admin can edit afterwards.

| Nigeria | Solo | Two | Three |
| --- | --- | --- | --- |
| Monthly | ₦4,500 | ₦8,100 | ₦11,250 |
| Quarterly | ₦12,000 | ₦21,600 | ₦30,000 |

`PlanCatalogEntry` is keyed on `(tier, interval, seats, currency, region)` and
carries `name`, `description`, `privacyNote` and `features`. **All customer-facing
copy comes from the database**, so benefit text, the privacy wording and the
price change from the admin API with no frontend deploy.

## Regional pricing

`CountryConfig` holds currency, payment provider and tax rate per market, so
charging Lagos differently from London is an ops change rather than a code one.
Nine markets ship seeded:

| | NG | KE | GH | ZA | GB | US | CA | DE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Currency | NGN | KES | GHS | ZAR | GBP | USD | CAD | EUR |
| Solo/month | 4,500 | 900 | 75 | 129 | 8 | 12 | 15 | 11 |
| Tax | 7.5% | 16% | 15% | 15% | 20% | — | 5% | 19% |

Anywhere without an explicit row falls back to the USD price. `taxRate` only
applies where we are merchant of record (Paystack); Paddle and the app stores
remit on our behalf. This also removed a latent bug: Nigeria's 7.5% VAT used to
be a literal in the Paystack adapter, which would have been wrong the moment we
sold into Kenya.

## Buying for someone else

Beneficiaries are validated **before** payment, so we never take money we cannot
honour:

| Case | Outcome |
| --- | --- |
| Has an account, no paid plan | Allowed — added on payment |
| No account yet | Allowed — emailed an invitation |
| Already pays for Pro | **Refused** — asked to cancel first |
| Yourself | Refused |
| More than 2 beneficiaries | Refused (3 seats max) |

Revocation: an unclaimed invite can be pulled immediately; an active seat ends
at period end, because it was paid for. If the payer's own plan lapses, every
seat falls to Free with it.

# "This wasn't me"

Every email announcing something a stranger could have started in your name
carries a one-time link: **seat invitations, sign-ups and password resets**.

These endpoints are unauthenticated by design. The person clicking may have no
account at all, and requiring a login to disown an action you never took would
be absurd. The token is the credential, and it only ever reaches the mailbox the
notice was sent to — which is also what makes acting on a report safe. It cannot
be used against a stranger's account.

| Type | Reporting it does this |
| --- | --- |
| `SIGNUP` | Suspends the imposter account, ends every session |
| `PASSWORD_RESET` | Voids outstanding reset links, ends every session |
| `SEAT_INVITE` | Cancels the invitation |

Invitations also offer a plain **decline**, which is not an accusation and files
no report. Tokens are single-use and live 30 days — deliberately longer than the
14-day invite, so someone reading an old email can still report it.

Reports land in an oversight-only admin queue at `/admin/v1/security/reports`,
with a repeat-offender tally. A report button that went nowhere would be worse
than not offering one.

---

# Budget: income as first-class rows

## The change

`BudgetMonth.estimatedIncome` — one number for the whole month — is gone.
Income is now a list of `BudgetIncome` rows, each with its own title, amount and
status.

One figure cannot represent a salary plus three clients, and it cannot answer
the question that actually matters to someone freelancing: **did the money
arrive?** A budget that says "income: ₦450,000" when ₦180,000 of it is still an
unpaid invoice is not a budget, it is a wish.

## Statuses

| Income | Meaning |
| --- | --- |
| `PROJECTED` | Expected, not yet banked |
| `ARRIVED` | Landed; `receivedAt` stamped |
| `DEFERRED` | Slipped and rolled into a later month |
| `CANCELLED` | Written off |

Expenses gained the mirror of this — `COMMITTED` vs `PAID` — so the two sides of
the comparison mean the same thing. An expense you have agreed to is not an
expense you have paid.

`DEFERRED` and `CANCELLED` are excluded from every total but still listed, so a
month reads honestly: *"I expected ₦400k here and it didn't come."*

## Currency

The budget is single-currency: everything in it is denominated in the money of
the country the person is in, resolved from `CountryConfig` and returned as
`currency` on both the ledger and the summary. Mixing currencies properly means
storing an FX rate per row and choosing a reporting currency — a much bigger
promise than "what landed this month", and not one worth making implicitly.

## Rolling a slipped income forward

`POST /budget/:y/:m/incomes/:id/roll` does **not** move the row. It marks the
original `DEFERRED` where it is and creates a fresh `PROJECTED` copy in the
target month with `rolledFromId` pointing back.

Moving it would erase the fact that it was expected in July and slipped — which
is exactly the information that makes the view realistic. Because the history
survives, a client who has slipped three months running is visible instead of
quietly reappearing each month. Rolls go forwards only, and a row can only be
rolled once.

## Recurring income

Creating an income with `recurring: true` materialises `PROJECTED` copies into
the next three months (`RECURRING_HORIZON_MONTHS`). The horizon is deliberately
not surfaced to the user — the UI offers a plain "repeats monthly" checkbox and
the ledger simply stays topped up. `recurrenceKey` groups the instances and
prevents duplicates when the series is touched again.

There is also `POST /budget/:y/:m/copy-from` for pulling a whole previous month
across. Copies always land `PROJECTED` and `COMMITTED`: carrying "paid" or
"arrived" forward would assert something that has not happened.

## Totals

`GET /budget/:y/:m/ledger` returns both sides plus every total in one call. The
two numbers that matter:

- **`availableNow`** = arrived income − paid expenses. What is actually in hand.
- **`projectedBalance`** = all income − all expenses. Where the month lands if
  everything expected turns up.

Filters (`?status=`, `?expenseStatus=`, `?category=`) narrow the returned lists
but never the totals. A filter is a view, not a redefinition of the month.

The server owns all the arithmetic; no client should re-derive a balance.

## Currency

One currency per person, resolved from their country. Per-row currencies would
need live FX rates to total honestly, and a budget that silently adds dollars to
naira is worse than one that refuses to.

## Migrating existing data

`prisma db push` creates `BudgetIncome` and drops `estimatedIncome` in the same
operation, so there is no moment when both exist. The migration therefore runs
in two phases around the push:

```bash
pnpm tsx prisma/migrations/addendum4_budget_income.ts export   # before
pnpm db:push
pnpm tsx prisma/migrations/addendum4_budget_income.ts import   # after
```

Each old value becomes one `PROJECTED` row titled "Monthly income" — the column
was called *estimated*, so projected is the truthful mapping. Both phases are
idempotent, and `import` refuses to run without the export file rather than
quietly doing nothing. `export` fails loudly if it cannot reach the database:
reporting "nothing to migrate" when Postgres is merely down would invite someone
to drop the column and lose the data.

A UI brief for the redesigned budget screen is in `docs/BUDGET_UI_BRIEF.md`.

---

# Admin console

## Personality notes

Each user carries `personalityNotes: String[]` — a short list of things the
support, fitness and coaching desks should know about how to work with them:
*"answers voice notes faster than text"*, *"evenings are rarely free"*.

**These are admin eyes only.** They are written by staff, about the person, and
no user-facing endpoint selects the column. A note like *"loses momentum after
two missed days"* is useful to a coach and would be a horrible thing to discover
about yourself in your own profile. The user API selects columns explicitly
everywhere and serialises through an allow-list (`publicUser`), so the field
cannot leak by accident — and there are regression tests asserting the string
"personality" appears nowhere in the login, `/auth/me`, profile or settings
responses.

| | |
| --- | --- |
| `GET /admin/v1/users/:id/personality` | Read the list |
| `PUT /admin/v1/users/:id/personality` | Replace it; `[]` is "delete list" |

The list also rides along on `GET /admin/v1/conversations/:id`, which is what
powers the personality popover on the chat screen — a coach shouldn't have to
leave the conversation to remember who they're talking to.

Replacing the whole array rather than patching individual entries keeps ordering
under the console's control and makes deletion a plain empty array.

## Admin lifecycle

Admins gained `phone`, `country`, `lastActiveAt` and a `status` of `ACTIVE`,
`INVITED` or `DISABLED`. `INVITED` means the seat exists but the person has not
signed in yet; `DISABLED` keeps the row for audit while blocking every login.

Status is checked **on every request**, not just at login, so disabling someone
takes effect immediately rather than whenever their access token happens to
expire. `lastActiveAt` is stamped on each authenticated request as
fire-and-forget — a failed write there must never cost someone their request.

## Console content tables

`/admin/v1/console/*` backs the sidebar's content sections:

| | |
| --- | --- |
| `/console/activities` | Dated activities across every user |
| `/console/flexible-tasks` | Non-dated tasks, with progress |
| `/console/goals` | Goals with milestone and linked-activity counts |
| `/console/budgets` | Months with income/expense rollups |
| `/console/meal-plans` | Plans across all users, with weekday and calories |
| `/console/plans` | Catalog with live subscriber counts |

**Oversight only.** These cross every user boundary at once, so a coach cannot
browse them. Private activities appear so a manager can see they exist, but
their titles are withheld — visibility of the row is not the same as reading it.

Subscriber counts are matched on `(currency, interval, amount)` rather than a
foreign key: a `Subscription` records what was actually charged, not which
catalog row it came from, so prices can change without rewriting history.

## Pagination

Every list endpoint in the admin API is paginated and returns the same envelope:

```json
{ "items": [...], "page": 1, "pageSize": 10, "total": 96, "totalPages": 10 }
```

`pageSize` defaults to 10 and is capped at 100. There is no way to fetch a whole
table in one call — deliberately, since these tables grow without bound.

## Console dashboard

`GET /admin/v1/analytics/dashboard?weeks=12` returns the ten headline counters
(users, activities, budgets, flexible tasks, meal plans, shared boards,
subscribers, goals, reviews, site visits), each with a week-over-week delta, plus
six weekly trend series for 8, 12 or 26 weeks.

"vs last week" compares the trailing seven days against the seven before, which
is what a person reading a dashboard means by it — not calendar weeks. The trend
series are built from one query each and bucketed in memory; at 26 weeks that is
6 queries rather than 156.

The older `GET /analytics/overview?from=&to=` is untouched and still serves the
site-analytics view.

---

# Moderation, store notifications and country changes

## Bans and suspensions

Enforced centrally in the auth middleware, so every authenticated route is
covered by one check.

**A ban is permanent and unexplained.** The user is told the account is closed
and nothing else — no reason, no field to read one from. Explaining a ban to the
account it applies to invites an argument the product can't have. The reason is
recorded for staff and visible in the admin console.

**A suspension is temporary and explained.** The person sees why and when it
lifts, because the point is that they come back:

```json
{ "success": false,
  "error": { "code": "ACCOUNT_SUSPENDED",
    "message": "This account is suspended.",
    "details": { "suspended": true,
                 "reason": "Repeated spam in support chat",
                 "suspendedUntil": "2026-08-16T09:00:00.000Z" } } }
```

Suspensions are **lifted at read time** once `suspendedUntil` passes, so a
missed nightly sweep never keeps someone locked out. The 03:00 sweep does the
actual row flip, writes an `AUTO_REINSTATED` event and notifies them. A
suspension defaults to 7 days rather than being open-ended — an open-ended
suspension is a ban wearing a different hat.

## Moderation history

`ModerationEvent` rows are immutable and never deleted. `User.status` is current
state; this is the audit trail, and it's what the console's banned/suspended
charts read from. Counting from `User.status` would mean reinstating someone
erased the fact they were ever banned, and the charts would silently rewrite
themselves. `GET /admin/v1/users/:id/moderation` returns the history, paginated.

## Console dashboard

`GET /admin/v1/analytics/dashboard` now returns **twelve** counters and twelve
weekly series, adding banned users, suspended users, flexible tasks, goals,
activities and reviews.

`?month=YYYY-MM` scopes everything to a calendar month and buckets that month by
week. With a month selected the delta compares against the **previous month**,
not last week — a weekly comparison next to a monthly figure would be
meaningless. Omit it for the trailing `weeks=8|12|26` window.

## Store server notifications

| | |
| --- | --- |
| `POST /webhooks/store/apple` | App Store Server Notifications V2 |
| `POST /webhooks/store/google` | Play Store RTDN (Pub/Sub push) |

Without these, a renewal or cancellation made in a store only reached us the
next time the app happened to call `/verify-purchase` — which for a lapsed user
may be never.

Apple notifications are JWS; the payload is verified against the leaf
certificate in the `x5c` header and the chain root is pinned to
`APPLE_ROOT_CA_G3`. **Honest limit:** full X.509 validation (expiry, revocation,
the intermediate's signature over the leaf) needs a proper certificate library.
This stops a forged payload but would not catch a revoked-yet-unexpired Apple
certificate.

Google pushes carry a shared `?token=`, but the real guard is that every
notification is **re-verified against the Play Developer API** before it grants
anything — so a forged push can't hand out Pro either way.

Both are idempotent on `(provider, eventId)`.

## Changing country

Country is set at signup. Changing it later is destructive — the food catalog is
per-country, so selected meals stop existing, and every amount switches
currency. So it's a two-step flow:

1. `GET /auth/me/profile/country/change-preview?country=KE` returns both
   currencies and how many selected meals would be removed.
2. `PUT /auth/me/profile/country` with `confirm: true` applies it.

Without `confirm`, the change is refused with a 400 explaining why. Setting the
country for the first time needs no confirmation — there's nothing yet to lose.
Historic budgets are **not** rewritten: the amounts stay as recorded and only
the symbol changes.

## Logging

Structured JSON to stdout, one object per line, no external error service.

**Redaction matters more than volume.** pino logs whole request objects, which
means bearer tokens, cookies and password fields land in every downstream log
tool unless removed at source. Those paths are dropped entirely (`remove: true`)
rather than printed as `[Redacted]`, so nothing can be reconstructed from a log
line. Base64 upload payloads are dropped too — otherwise a single voice note
buries a day of logs.

A 500 is the one case where the log has to be enough to debug from, so it
carries request id, method, URL, user or admin id, and the stack.

**Known limit:** cron jobs run in-process via node-cron. Two user-api instances
means every job runs twice. That needs a lock before scaling horizontally.

---

# Budget ledger and calendar: three contract details

**An untouched month is empty, not missing.** `GET /budget/:y/:m/ledger` returns
`200` with empty lists, zeroed totals and `started: false` for a month nobody has
touched. A ledger is a view of a month, not a resource that has to be created
first, and the first-run screen should render an empty budget rather than catch
an error. `GET /budget/:y/:m` still `404`s — that one addresses the month record
itself, which genuinely may not exist.

**`GET /budget/recent-months?limit=3`** backs the "copy from a recent month"
chooser in one call. `recurringIncomes` is counted separately from total
`incomes`, because only recurring rows are what someone means by copying a month
forward — a one-off client invoice should not be carried over blindly. Months
with no data are returned with `hasData: false` rather than omitted.

**`GET /calendar` days carry `importedEvents`.** A read-only overlay from
connected calendars, deliberately separate from `activities`: they are not
editable, do not count toward quota and must not affect streaks, so `total` and
`done` ignore them. They are **owner-only** — a shared board returns an empty
list even on a `FULL` grant, because someone connects a work calendar for
themselves, not to publish it to whoever they share a board with.


---

# Public pricing

`GET /api/v1/public/plans` is region-aware and returns the same `PlanOption`
shape as the signed-in `GET /subscription/plans`, plus `resolvedFrom`. Both call
one `buildPlanCatalog()`, so the arithmetic exists once and the two cannot drift.

Region is resolved from `?country=` (wins), then an edge header
(`cf-ipcountry`, `x-vercel-ip-country`, `fastly-client-country`,
`x-country-code`), then the default catalog. `resolvedFrom` reports which, so the
client can state a currency confidently or offer a picker rather than implying
certainty it does not have.

No geo-IP service is called: that is a paid dependency and a round trip on the
landing page, and being wrong costs only that someone sees fallback pricing until
they choose. Cloudflare's `XX` is treated as no answer.

The fallback catalog still lists all three seat tiers — the shared plans are the
strongest reason to choose Life Planner over a solo planner, so they are never
hidden, merely priced in the default currency.

**Cache note:** this route is unauthenticated and cacheable, but any cache must
vary on `cf-ipcountry` and the `country` parameter, or one visitor's currency
will be served to the next.
