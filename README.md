# Life Planner — Backend

A personal life-planning backend: a color-coded calendar of activities, per-day
reflections, goals, reminders, stats/streaks, iCal export, and two real-time
"assistant" chat channels where a user talks to a **human admin/coach** on the
other end.

Built as a **pnpm + Turborepo monorepo** with two independently-deployable
services — `user-api` and `admin-api` — over **one shared PostgreSQL database**
and a shared toolkit. Both run Socket.IO servers bridged through **Redis**, so a
chat message reaches the other party regardless of which service holds the
socket.

```
 User ──HTTP/WS──▶  user-api  ┐                 ┌  admin-api  ◀──HTTP/WS── Admin
                              ├──▶  Redis  ◀────┤        (Socket.IO backplane + rate-limit store)
 packages/database ──────────┴──▶ PostgreSQL ◀─┴────────── packages/database
                      packages/shared-utils (zod, errors, jwt, dates, realtime contracts)
```

## Tech stack

Node 20+ · TypeScript (ESM) · Express 4 · Zod · Prisma · PostgreSQL · Socket.IO
+ Redis adapter · node-cron · argon2 · JWT (access + refresh) · pino · helmet ·
express-rate-limit (Redis-backed) · `ics` for calendar export.

## Repo layout

```
life-planner/
  apps/
    user-api/    # planner, chat (user side), settings, jobs (cron), iCal feed
    admin-api/   # admin auth, conversation inbox, claim/reply/close, user lookup
  packages/
    database/    # @life-planner/database — Prisma schema, client singleton, seed
    shared-utils/# @life-planner/shared-utils — zod schemas, DTOs, errors, jwt,
                 #   date/RRULE helpers, HTTP envelope, realtime contracts
```

Both apps depend on both packages via `workspace:*`. In dev they run straight
from TypeScript with `tsx` (no build step); `pnpm build` compiles for production.

## Prerequisites

- Node.js 20+ and pnpm 9+ (`corepack enable` to get pnpm)
- PostgreSQL 16 and Redis 7 — easiest via the bundled compose file:
  ```bash
  docker compose up -d
  ```

## First run

```bash
pnpm install
cp .env.example .env                 # fill in secrets; defaults match docker-compose
pnpm db:generate                     # prisma generate (build the typed client)
pnpm db:migrate                      # create the schema (prisma migrate dev)
pnpm db:seed                         # default admin + a demo user
pnpm dev                             # turbo runs both apps in watch mode
```

`pnpm dev` starts `user-api` on `:4000` and `admin-api` on `:4001`. Health
checks: `GET http://localhost:4000/health` and `:4001/health`.

### Seeded credentials (dev)

- **Admin** (admin-api): `admin@lifeplanner.local` / `admin12345` (SUPERADMIN)
- **Demo user** (user-api): `demo@lifeplanner.local` / `demo12345`

Override via `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_USER_EMAIL` /
`SEED_USER_PASSWORD`.

## Environment

See `.env.example`. Both services read `DATABASE_URL` and `REDIS_URL`. `user-api`
uses `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`; `admin-api` uses
`ADMIN_JWT_SECRET` (a fully separate secret — admin tokens never validate on
user-api and vice-versa). `RECURRING_HORIZON_DAYS` controls how far ahead the
recurring-template job materializes activities. Mail defaults to a console
transport so reminders work with zero external config.

## API surface

**user-api** — base path `/api/v1` (all routes require a Bearer access token
except `register` / `login` / `refresh` and the public iCal feed):

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/{register,login,refresh,logout}` · `GET /auth/me` |
| Categories | `GET/POST /categories` · `PATCH/DELETE /categories/:id` |
| Activities | `GET/POST /activities` (`?from=&to=&categoryId=&tag=&done=&q=`) · `POST /activities/bulk` · `GET/PATCH/DELETE /activities/:id` · `PATCH /activities/:id/toggle` · `POST /activities/reorder` · `DELETE /activities/batch/:id` |
| Recurring | `GET/POST /recurring` · `PATCH/DELETE /recurring/:id` |
| Day notes | `GET/PUT/DELETE /days/:date/note` |
| Calendar | `GET /calendar?from=&to=` · `GET /calendar/week?start=` |
| Goals | `GET/POST /goals` · `PATCH/DELETE /goals/:id` · `POST /goals/:id/milestones` |
| Tags | `GET/POST /tags` · `DELETE /tags/:id` |
| Stats | `GET /stats/{overview,categories,streaks,mood}` |
| Reminders | `GET/POST /reminders` · `DELETE /reminders/:id` |
| iCal | `GET /ical/feed-url` (authed) · `GET /ical/feed/:token.ics` (public) |
| Chat | `GET/POST /chat/conversations` · `GET /chat/conversations/:id` · `POST /chat/conversations/:id/messages` |
| Settings | `GET/PUT/PATCH /settings` |

**admin-api** — base path `/admin/v1`:

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/{login,refresh}` · `GET /auth/me` |
| Inbox | `GET /inbox` (`?status=&channel=&assigned=me`) · `GET /inbox/counts` |
| Conversations | `GET /conversations/:id` · `GET /conversations/:id/messages` · `POST /conversations/:id/{claim,assign,messages,close,reopen}` |
| Users | `GET /users/:id` (read-only lookup) |
| Admins | `GET/POST /admins` (SUPERADMIN only) |

### Response envelope

```jsonc
{ "success": true,  "data": { /* ... */ } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [] } }
```

Central error middleware maps `AppError` → its status, Zod → 422, Prisma unique
violation → 409, missing record → 404, and anything else → 500 (logged, generic).

## Real-time chat (Socket.IO, Redis-bridged)

One namespace per service, both sharing the Redis adapter and the same
`conversation:{id}` rooms. Handshake auth: `auth: { token }` (a user access
token on user-api, an admin access token on admin-api); unauthenticated sockets
are rejected.

| Direction | Event | Payload |
| --- | --- | --- |
| client → server | `conversation:join` / `conversation:leave` | `{ conversationId }` |
| client → server | `message:send` | `{ conversationId, content }` |
| client → server | `message:read` | `{ conversationId, upToMessageId }` |
| client → server | `typing` | `{ conversationId, isTyping }` |
| server → room | `message:new` | `{ message }` |
| server → room | `conversation:updated` | `{ id, status, assignedAdminId }` |
| server → room | `typing` | `{ conversationId, from, isTyping }` |
| server → client | `error` | `{ code, message }` |

A user's `message:send` on user-api persists the message and emits `message:new`
into the room; the assigned admin's socket on admin-api receives it through the
Redis backplane (and vice-versa). REST `POST .../messages` endpoints exist as a
fallback and emit the same event.

## Background jobs (user-api)

- **Recurring materializer** (hourly + on boot): expands each active
  `RecurringTemplate`'s RRULE out to `RECURRING_HORIZON_DAYS`, creating concrete
  activities. Idempotent — skips dates that already exist and advances
  `lastRunOn`.
- **Reminder dispatcher** (every minute): polls `PENDING` reminders that are due,
  delivers via the mail/push adapter, and marks them `SENT` / `FAILED`.

Both run in-process via node-cron. For multi-instance deploys, move them to a
dedicated worker or add a Redis lock so they don't double-run; swap node-cron for
BullMQ for reliable retries at scale.

## Scripts

```bash
pnpm dev          # both apps in watch mode (turbo)
pnpm build        # compile all packages/apps
pnpm typecheck    # tsc --noEmit across the graph
pnpm lint         # eslint across the graph
pnpm test         # vitest across the graph
pnpm db:migrate   # prisma migrate dev
pnpm db:seed      # seed defaults + dev admin
pnpm format       # prettier
```

## Notable design decisions

- **Shared DB, two services** (not strict db-per-service) — keeps chat
  persistence and cross-service delivery simple while still allowing separate
  scaling/deploys.
- **Dates** are stored as `@db.Date` (no time) for clean range queries;
  time-of-day lives in `startTime`/`endTime` `"HH:MM"` strings interpreted in the
  user's timezone.
- **Soft deletes** (`deletedAt`) on Activity/Category/DayNote/Goal/Conversation;
  all reads filter `deletedAt: null`. `ActivityHistory` is the lightweight audit
  trail (CREATED / UPDATED / TOGGLED / DELETED).
- **Auth**: argon2id password hashing; short-lived access JWTs; user refresh
  tokens are stored **hashed** and rotated on use (reuse is rejected). Admin
  refresh is a stateless signed token (the Admin model has no refresh-token
  table); rotating `ADMIN_JWT_SECRET` is the kill-switch.
- **iCal feed** uses a stateless signed token in the URL so calendar apps can
  poll without a login.

## Open items carried from the spec (§15)

These were defaulted to keep the build moving; each is localized and easy to flip:

1. **Streak rule** — defaulted to *"all activities done that day"*. Toggle
   `STREAK_RULE` in `apps/user-api/src/modules/stats/stats.service.ts`.
2. **Category delete** — soft-delete + null-out on activities (activities show as
   uncategorized), not block-on-use.
3. **Chat assignment** — single assignee per conversation; first admin reply
   auto-claims an unassigned one.
4. **Reminder providers** — mail defaults to a console transport; SMTP/Resend and
   push are stubbed behind `sendMail` / the dispatcher, ready to wire.
5. **Admin refresh tokens** — stateless (no per-session revocation) pending an
   `AdminRefreshToken` model if that becomes a requirement.

## Build status

Implemented end-to-end: foundation (monorepo, database, shared-utils, auth),
core planner (categories, activities incl. bulk/toggle/reorder, calendar, day
notes), planner depth (recurring + materializer, goals/milestones, tags/search,
stats/streaks, soft-delete + audit, iCal), reminders (model + dispatcher +
adapter), and chat + admin (Socket.IO on both services, conversations/messages,
inbox/claim/reply/close, read-only user lookup, cross-service delivery via Redis).

> Dependencies have not been installed in this delivery environment, so the code
> has not been compiled here. Run `pnpm install` then `pnpm typecheck` to verify
> against your toolchain before first deploy.
