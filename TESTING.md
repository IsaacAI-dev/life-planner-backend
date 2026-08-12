# Testing guide

Everything below has been run against a live Postgres 16 + Redis 7 instance with the seed data
loaded. Import `postman/LifePlanner.postman_collection.json` and
`postman/LifePlanner.postman_environment.json`, then run **Auth → Login** and
**Admin API → Admin login** first; most requests auto-save the ids they create.

```bash
docker compose up -d
pnpm install && pnpm db:generate && pnpm db:push && pnpm db:seed
pnpm dev
```

---

## 1. Auth and account status

```bash
curl -s -X POST localhost:4000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@lifeplanner.local","password":"demo12345"}'
```

Save `data.tokens.accessToken` as `$TOK`. Things worth checking:

- `POST /auth/refresh` rotates: the old refresh token is revoked and stops working.
- `POST /auth/forgot-password` always answers identically whether or not the email exists; the reset
  token prints to the server console (`MAIL_TRANSPORT=console`). Feed it to
  `POST /auth/reset-password`, which also revokes every existing session.
- A user access token sent to any `:4001/admin/v1` route fails with `TOKEN_INVALID` — the two
  services use different signing secrets.

## 2. Flexible (non-date-specific) tasks

```bash
curl -s -X POST localhost:4000/api/v1/activities/flexible -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Gym session","windowStart":"2026-08-01","windowEnd":"2026-08-07","targetCount":3}'
```

Expected: `date: null`, the window echoed back, `isFlexible: true`.

| Step | Expected |
| --- | --- |
| `PATCH /activities/:id/progress` `{"increment":1}` ×2 | `completedCount` 1 → 2, `isDone: false` |
| `PATCH /activities/:id/progress` `{"increment":5}` | clamps at `targetCount` 3, `isDone: true` |
| `PATCH /activities/:id/toggle` on the same task | **400 `NOT_A_DATED_TASK`** |
| `PATCH /activities/:id/progress` on a dated task | **400 `NOT_A_FLEXIBLE_TASK`** |
| `GET /activities?flexible=true&activeOn=2026-08-03` | only tasks whose window contains that date |
| `GET /activities` (no flag) | dated rows only — unchanged base behavior |
| `GET /calendar?from=…&to=…` | flexible tasks appear in `flexibleTasks`, never inside `days[]` |
| `GET /stats/streaks` | unaffected by flexible tasks (documented in the response `note`) |

## 3. Task privacy and board sharing

The seed grants `partner@lifeplanner.local` `PUBLIC_ONLY` access to the demo board, and the demo
board contains one private activity.

```bash
# as the partner
curl -s "localhost:4000/api/v1/users/$DEMO_ID/board?from=$FROM&to=$TO" -H "Authorization: Bearer $PARTNER_TOK"
```

| Viewer | Result |
| --- | --- |
| Owner (`GET /calendar`) | 7 activities, 1 of them private |
| Partner, `PUBLIC_ONLY` | 6 activities, **0 private** |
| Partner after `PATCH /board-shares/:id {"permission":"FULL"}` | all 7, private included |
| Any user with no share | **403 `SHARE_NOT_GRANTED`** |
| Admin via `/admin/v1/users/:id/board` | everything, no share required |
| Public iCal feed | private activities excluded |

Also verify: granting the same viewer twice **updates** the row rather than duplicating it, and
`DELETE /board-shares/:id` flips `status` to `REVOKED` rather than deleting (visible via
`GET /board-shares?direction=granted&status=REVOKED`).

## 4. Budget tracker

```bash
curl -s -X PUT localhost:4000/api/v1/budget/2026/8 -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{"estimatedIncome":450000}'
```

- `GET /budget/2026/8` before the PUT → **404** with a message pointing at the income step.
- Add expenses across all three categories, then compare:
  - `GET /budget/2026/8/summary` → `totalExpenses` covers everything; `byCategory` lists all three
    with their fixed colors (`#DC2626` / `#D97706` / `#0891B2`).
  - `GET /budget/2026/8/summary?category=MANDATORY` → totals narrow to mandatory only,
    `filteredBy: "MANDATORY"`, `byCategory` still lists all three.
- An expense dated outside the month → **400** (`Expense date must fall within the budget month`).
- Amounts round-trip through `Decimal(12,2)` — try `1234.56` and confirm no float drift.

## 5. Nutrition board

| Step | Expected |
| --- | --- |
| `GET /food-catalog?country=NG&category=PROTEIN` | paginated slice of the seeded NG catalog |
| `PUT /food-inventory {"foodItemIds":[…]}` | replaces the whole selection |
| `POST` / `DELETE /food-inventory/:foodItemId` | incremental add/remove, idempotent |
| Admin `GET /users/:id/food-inventory` | the same list, as planning context |
| Admin `PUT /users/:id/meal-plans/:date` with `status: DRAFT` | plan authored |
| User `GET /meal-plans/:date` | **404** while it is a draft |
| Admin re-PUTs with `status: PUBLISHED` | user now sees it, with `totalCalories` computed |
| Item with both `foodItemId` and `freeText` | **400** — exactly one is required |
| Re-PUT with fewer items | previous `MealPlanItem` rows are fully replaced |

## 6. Admin moderation

```bash
curl -s -X POST localhost:4001/admin/v1/users/$USER_ID/suspend -H "Authorization: Bearer $ATOK" \
  -H 'Content-Type: application/json' -d '{"reason":"Reported spam in chat"}'
```

| Action | Effect |
| --- | --- |
| Suspend | existing token → **403 `ACCOUNT_SUSPENDED`** (with the reason); fresh login also blocked; `sessionsRevoked: 0` |
| Reinstate | `status: ACTIVE`, reason cleared, login works again |
| Ban | **403 `ACCOUNT_BANNED`**, plus every refresh token revoked (`sessionsRevoked` > 0) |
| `DELETE /users/:id/activities/:activityId` | soft delete; `GET /activities/:id/history` shows `DELETED_BY_ADMIN` with a non-null `adminId` |
| `GET /users?q=demo&status=ACTIVE` | case-insensitive match on email or name, paginated |

A banned user's Socket.IO handshake also fails immediately, because the handshake re-checks
`status` rather than trusting the token alone.

## 7. Site analytics

```bash
# no Authorization header — anonymous page view
curl -s -X POST localhost:4000/api/v1/analytics/events -H 'Content-Type: application/json' \
  -d '{"type":"PAGE_VIEW","path":"/pricing","sessionId":"abc-123"}'
```

- Accepted anonymously (202). Send the same request **with** a token and `userId` is attached.
- An invalid token is treated as anonymous rather than rejected.
- `GET /admin/v1/analytics/overview?from=&to=` → `totalPageViews`, `uniqueVisitors` (distinct
  `sessionId`), `newSignups` (from `User.createdAt`), `activeUsers` (distinct user with an activity
  mutation in range).
- `GET /admin/v1/analytics/pages?limit=10` → most-visited paths, descending.
- `GET /admin/v1/analytics/signups?granularity=day` → bucketed counts (`day` / `week` / `month`).

## 8. Real-time chat

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:4000', { auth: { token: ACCESS_TOKEN } });
socket.on('connect', () => socket.emit('conversation:join', CONVERSATION_ID));
socket.on('message:new', ({ message }) => console.log(message.senderType, message.content));
```

Then, from admin-api: `POST /admin/v1/conversations/:id/messages`. The user's socket receives
`message:new` within milliseconds — admin-api publishes to Redis, user-api re-broadcasts.

Confirm the message is stored **once**: re-fetch `GET /chat/conversations/:id` and count `ADMIN`
messages. Persistence happens on the REST path only; the socket layer never writes.

## 9. Background jobs

- **Recurring:** create a template with `FREQ=WEEKLY;BYDAY=MO,WE,FR`. Occurrences are materialized
  immediately on create, then hourly. Run it twice — no duplicates appear (the job is idempotent).
- **Reminders:** create one with `remindAt` a minute out and watch the console for the mail payload;
  the row moves `PENDING → SENT`. Reminders for suspended or banned accounts are cancelled instead.

## 10. Cross-cutting checks

| Check | Expected |
| --- | --- |
| Any validation failure | 400, `VALIDATION_ERROR`, with `details` from Zod's `flatten()` |
| Unknown route | 404 in the standard error envelope |
| Another user's resource id | 404 (never 403 — ids are not enumerable) |
| `PUT /settings` with an unknown key | 400 (`.strict()`) |
| Rapid repeated logins | 429 `RATE_LIMITED` after 20 in 15 minutes |
| `POST /analytics/events` flood | its own, much larger bucket — does not starve normal traffic |

---

# Addendum 3 — verification

Everything below was run against live Postgres 16 and Redis 7 with both services
booted, on a freshly reset and reseeded database: **289 assertions, 0 failures.**

## Seeded accounts

| Role | Email | Password |
| --- | --- | --- |
| Super Admin | `admin@lifeplanner.local` | `admin12345` |
| Manager | `manager@lifeplanner.local` | `manager12345` |
| Coach (Life Coach **and** Fitness) | `coach@lifeplanner.local` | `coach12345` |
| Support | `support@lifeplanner.local` | `support12345` |
| Demo user — **PRO** | `demo@lifeplanner.local` | `demo12345` |
| Partner — **FREE** | `partner@lifeplanner.local` | `partner12345` |

The demo account is Pro so every paywalled surface is reachable; the partner
account is Free so the gated states are too. To exercise the expired state, set
`status` to `EXPIRED` on the demo subscription row.

## Running it yourself

```bash
docker compose up -d           # postgres + redis
pnpm install
pnpm build:packages
pnpm db:push && pnpm db:seed
pnpm dev                       # both services
```

Then import `postman/LifePlanner.postman_collection.json` (45 folders, 327
requests) and its environment. Folders 23–37 cover Addendum 3, 38–40 family
plans and security reports, 42 the budget income ledger, 43 the admin console,
44 moderation and store notifications, 45 the frontend-feedback shapes; folder
22 holds the expected-failure cases.

Log in as each of the six accounts and store the tokens in `accessToken`,
`partnerAccessToken`, `adminAccessToken`, `managerAccessToken` and
`coachAccessToken` — the RBAC requests depend on hitting the same endpoint with
different roles.

## What was verified

**Subscriptions (8/8)** — Pro state returns null limits; a Nigerian user is
routed to Paystack and offered naira pricing; switching the region to GB flips
to Paddle and falls back to USD; iOS returns store product ids.

**Chat, paywall and RBAC (23/23)** — three conversation types with per-thread
unread counts; a Free user is refused the coach chat with 402 +
`upgradeRequired` but can still open Support; quote replies resolve their
parent; edits increment `editCount`; a reaction toggles off when repeated; a
soft-deleted message disappears for the user but a Manager still sees it **and**
its prior version, while a coach passing the same flag does not; Support is
403'd from a coach chat, a coach is 403'd from another admin's queue and from
reassigning.

**Voice notes, quotas, sessions, coaching (23/23)** — a voice note returns 32
normalised waveform samples and the file is actually served; over-length is
rejected; a Free user is refused; the 6th activity in a week is blocked at the
env-configured cap while Pro is unaffected; a second concurrent timer is
refused with 409 and planned-vs-actual minutes are computed; an accepted
recommendation really creates the activity and a second accept is refused; a
feedback form snapshots the coach ids, refuses a duplicate week, and its ratings
roll up for the Manager.

**Everything else (39/39)** — notifications, search with its two-character
floor, profile fields with the birth-year guard, avatar upload → cartoon preset
→ removal, text size and settings reset, seven-day stats including empty days,
authored coach insight, exactly-one-featured-goal, multi-category foods and
category filtering, meal authoring with optional weight/calories/meal-time, the
meal-request loop, coach reassignment with the conversation following and a
wrong-role target refused, public landing content without auth, and VAT split
correctly in the revenue report (₦313.95 on ₦4,500) with no cross-currency
summing.

## Two things the runtime caught that typechecking could not

1. **Neither service could boot.** Nothing loaded `.env`. Both apps now walk up
   from the cwd to find it, so they start the same way from the repo root or
   from their own directory.
2. **A plan could be `PUBLISHED` with a null `publishedAt`.** The stamp only
   fired on a status transition, so a plan published at creation never got one.
   It now stamps on transition and backfills.

The rate limiter also proved itself unprompted: four suites of logins in quick
succession correctly returned 429. Admin auth is capped at 20 attempts per 15
minutes, so cache tokens rather than logging in per request when scripting.

## Family plans and security reports

**Seats and pricing (13/13)** — the catalog returns solo, two- and three-person
rows and the multiplier is measured, not assumed: two seats came back at exactly
1.8× solo and three at 2.5×. A Nigerian user is offered NGN; switching region to
Kenya gives KES 900 via Paystack, to the UK GBP 8 via Paddle, to the US USD 12
via Paddle. `description` and `privacyNote` are confirmed present on the rows,
since the frontend renders them straight from the response.

Beneficiary validation was exercised on all five paths: an existing free user is
allowed, an unknown address is flagged for invitation, an address that already
pays for Pro is refused *with the word "cancel" in the message*, naming yourself
is refused, and a third beneficiary is refused with 400.

**Security reports (24/24)** — the whole lifecycle, driven through the console
mail transport by scraping the links out of the server log:

- *Sign-up*: registered a new account, confirmed the welcome mail carried a
  report link, confirmed the session worked, reported it, then confirmed the
  account came back `SUSPENDED` and the token could not be reused (400).
- *Password reset*: requested a reset, reported it, confirmed both consequences
  (links voided, sessions ended) were returned.
- *Seat invite*: invited someone, confirmed the mail carried a **reject** link
  and that the preview names the sender, declined it, and confirmed the seat
  moved to `DECLINED` and freed up for reuse.
- *Privacy*: asserted the payer's seats response contains no trace of the word
  "report" anywhere — a declined invite and a reported one look identical.
- *Queue*: reports arrive with the account attached, counts work, a Manager can
  review one, a coach is 403'd, and a bogus token 404s.

## A note on running these repeatedly

The suites mutate state, so a second run against the same database will show
failures that are not defects — most visibly, suite 4 reassigns the demo user's
life coach, after which the original coach is *correctly* 403'd from that
conversation in suite 2. Reset between full runs:

```bash
# stop both services first, or the drop will block on open connections
psql -c 'DROP DATABASE lifeplanner WITH (FORCE);'
psql -c 'CREATE DATABASE lifeplanner OWNER lifeplanner;'
pnpm db:push && pnpm db:seed
```

Cache tokens rather than logging in per request, too — admin auth is capped at
20 attempts per 15 minutes and repeated suites will trip it.

## Budget income (28/28)

The seeded demo month is deliberately mixed so the screen has something
realistic to render: salary **arrived** (₦320,000), two clients **projected**
(₦180,000 and ₦60,000), one invoice **rolled over** from last month (₦95,000),
two expenses **paid** and three still **committed**. That gives
`availableNow` ₦152,000 against a `projectedBalance` of ₦405,000 — the gap
between those two numbers is the entire point of the feature.

Verified: multiple income sources on one month; `availableNow` equals arrived
minus paid, computed independently in the test; the rollover badge appears;
create → mark arrived → stamp `receivedAt` → reverse it → `receivedAt` cleared;
rolling a slipped income leaves the original `DEFERRED` and creates a flagged
`PROJECTED` copy in the target month; the deferred amount is excluded from
totals but still listed; rolling twice and rolling backwards are both refused;
a recurring income materialises exactly three future months and stops; expenses
mark paid and unpaid; `arrivedOnly` filters the list while totals stay
month-wide; and `copy-from` lands everything projected and unpaid.

The two-phase migration was exercised end to end against real data: a ₦450,000
`estimatedIncome` was exported, the column dropped by `db push`, and the value
restored as a `PROJECTED` income row.

## Budget — income ledger (33/33)

Run against an isolated future month so seeded data cannot skew the arithmetic.

**Multiple sources** — two incomes in one month, each keeping its own title,
description and source. Creating one already `ARRIVED` stamps `receivedAt`.

**Arrived toggle** — mark arrived, confirm `receivedAt` is set, undo it, confirm
it is cleared. The flip is reversible in both directions.

**Rolling forward** — the original is left in place as `DEFERRED` and a new
`PROJECTED` row appears in the target month with `rolledFromId` pointing back.
Verified that the deferred amount is excluded from totals but the row is still
listed, and that a rolled income can no longer be marked arrived (400).

**Committed vs paid** — expenses default to `COMMITTED`; marking one paid moves
it and updates `paidExpenses` / `outstandingExpenses`.

**Arithmetic**, asserted exactly against known rows — ₦650k arrived, ₦400k
projected but deferred, ₦250k paid, ₦25k outstanding:

```
arrivedIncome 650000 · projectedIncome 0 · deferredIncome 400000
totalExpenses 275000 · paidExpenses 250000 · outstandingExpenses 25000
availableNow 400000 · projectedBalance 375000
```

`availableNow` is arrived minus paid — real money only. `projectedBalance`
correctly ignores the deferred row.

**Recurring** — a recurring income materialises into exactly the next three
months as `PROJECTED`, and the fourth month is never created (404), confirming
the horizon holds without the user being told about it.

**Filters, copy-forward and guard rails** — status filters return only matching
rows; a copied month brings nothing in as `ARRIVED` or `PAID`; negative amounts
are refused (400) and another user's income is invisible (404).

**Currency** comes back as `NGN` for a Nigerian user, resolved through
`CountryConfig` rather than hardcoded.

## Admin console (40/40)

**Personality notes** — saved with order preserved, readable on the user detail
and on the chat payload, and cleared by an empty array. Four separate assertions
confirm the string "personality" appears nowhere in the login response,
`/auth/me`, `/auth/me/profile` or `/settings`. That is the guarantee worth
regression-testing: the field is written by staff about the user, and must never
be visible to them.

**Users table** — page size honoured, `totalPages` present, per-user counts and
subscription state included, and filters verified for country, subscription tier
and joined-date range.

**Admins table** — paginated, exposes `status` and `lastActiveAt`, filters by
role and search. An admin was created, patched with phone/country/status, and
then the ACTIVE→DISABLED transition was proven in both directions: logging in
succeeded while active and returned 403 once disabled.

**Content tables** — all six (`activities`, `goals`, `flexible-tasks`,
`budgets`, `meal-plans`, `plans`) return the full pagination envelope, a coach is
403'd from every one, private activity titles come back null, plans carry live
subscriber counts and meal plans carry the weekday label.

**Dashboard** — ten counters each with a delta, six trend series, and the bucket
count matches the requested window at both 12 and 26 weeks.

## Moderation, store webhooks and country changes (40/40)

**Log redaction** — asserted directly against the log file: after an
authenticated request, `authorization` appears zero times and `"password"` zero
times in `user.log`.

**Suspension** — carries an end date, returns 403 with `ACCOUNT_SUSPENDED`, and
the payload includes both the reason and `suspendedUntil` so the UI can show
them. Setting `suspendedUntil` into the past makes the very next request succeed
with 200, proving the read-time lift works without waiting for the cron.

**Ban** — 403, and the reason is asserted absent from the response body while
still readable by an admin on the same account.

**Moderation history** — the event is logged with its expiry and the acting
admin's name, and reinstating adds a second row rather than overwriting: history
survives.

**Dashboard** — twelve counters and twelve series, each of the six new ones
checked by name. Bans are counted from the moderation log, `?month=` is accepted
and scopes the buckets to that month, and `month=2026-13` is rejected with 400.

**Country change** — the preview reports `NGN->KES` and the count of meals that
would be lost; the change is refused without `confirm`, applied with it, the
currency follows, selected meals come back at zero, and an unsupported country
is refused.

**Store webhooks** — Apple rejects an unsigned payload with 401 and a missing
payload with 400; Google acknowledges a test notification and a malformed push
with 200, so Pub/Sub stops retrying them.

A real bug surfaced here: a malformed Apple JWS threw during decode and returned
500 instead of 401. That endpoint is public and anyone can post junk at it, so
it now treats an unparseable payload as a rejection.

## Frontend feedback round 2 (25/25)

Driven by the client team's open-issues list. Everything here was captured from
a live response rather than read off the schema.

**Milestone delete** — turned out to already exist. The test caught it: my new
route returned `{ ok: true }` but the response came back `{ deleted: true }`,
because the original was matching first. The duplicate was removed.

**Reminders by activity** — returns only that activity's reminders, composes
with `status`, and another account's id yields an empty list rather than a leak.

**Expense routes** — the new month-scoped `PATCH`/`DELETE` work and the original
unscoped pair still do.

**Landing content** — hero, features and FAQs are real columns now, seeded, and
editable from the console. Verified shape on both `title/body` and
`question/answer`.

**Country preview** — flat `selectedMealsRemoved`, flat currencies, and at least
one server-authored warning naming the target currency. This one feeds a
destructive confirm, so a nested-only number was a genuine hazard.

**Chat** — reactions verified as `{ emoji, count: 2, reactedByMe: true }` with
two distinct reactors on one message; quote replies name the sender; deleting a
quoted message nulls the quoted text.

**Receipts** — `netAmount` present alongside gross and tax.


## Public pricing (17/17)

Region resolution verified on every path: `?country=NG` gives NGN via Paystack
and reports `QUERY`; a `cf-ipcountry: KE` header gives KES and reports `EDGE`;
`x-vercel-ip-country` works the same; Cloudflare's anonymised `XX` falls back;
and an explicit query beats the edge header.

Pricing arithmetic checked against live figures — two seats at ₦8,100 gives
`perSeatAmount` ₦4,050 and `savingVersusSolo` ₦900 (10%). `description`,
`privacyNote` and `maxSeats` are all present, and the fallback catalog still
lists all three seat tiers.

The assertion worth keeping: the public and signed-in responses are compared
field by field for the same region and must be identical. Both call one
`buildPlanCatalog()`, and that test is what stops a second copy of the pricing
maths appearing later.
