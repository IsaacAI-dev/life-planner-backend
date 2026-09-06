# API coverage — round 2

Answering `API_COVERAGE.md` (open issues). Every shape below was **captured from
a live response**, not read off a schema. Backend suite: **272 assertions, 0
failures**, including 25 new ones covering everything in this document.

Round 1 is preserved as `API_COVERAGE_VERIFIED_ROUND1.md`.

Three things changed in the backend because of your feedback, one of your gaps
turned out already to exist, and the rest is the shape data you asked for.

---

## 1. One correction: `DELETE /goals/:goalId/milestones/:id` already existed

It has been there since the base spec. I nearly shipped a duplicate route on top
of it before the test caught that the response was `{ deleted: true }` rather
than the `{ ok: true }` I had just written — the original was matching first.

```
DELETE /goals/:goalId/milestones/:milestoneId
-> { "deleted": true }
```

Ownership is checked through the parent goal, so another account gets `404`
rather than `403` — deleting somebody else's milestone is indistinguishable from
one that does not exist. Wire the delete control; nothing to build.

---

## 2. Built

### `GET /reminders?activityId=`

```
GET /reminders?activityId=act_9              -> { "reminders": [...] }
GET /reminders?activityId=act_9&status=PENDING   (composes with status)
```

Still scoped by `userId`, so passing someone else's activity id returns an empty
list rather than their reminders.

### Expense routes now match income

Both forms work; the month-scoped one is the canonical shape going forward:

```
PATCH  /budget/:y/:m/expenses/:id     (new — matches income and /paid)
DELETE /budget/:y/:m/expenses/:id     (new)
PATCH  /budget/expenses/:id           (still works)
DELETE /budget/expenses/:id           (still works)
```

The id is unique and ownership-scoped, so the month segment is decorative for
lookup — it exists so the surface reads uniformly.

### Landing page content

You assumed `hero`, `features` and `faqs`. They genuinely did not exist, so the
landing page would have rendered empty no matter what it was named. They are now
real columns on `SiteContent`, editable from the admin console, and seeded with
copy. **Note the nesting: they are top-level on `data`, not under `content`.**

```jsonc
// GET /public/content
{
  "contact": { "email", "phone", "address", "supportEmail" },
  "hero": { "headline": "A calm canvas for a colorful life",
            "subhead": "...", "ctaLabel": "Start planning" },
  "features": [ { "title": "...", "body": "...", "icon": "calendar" } ],
  "faqs":     [ { "question": "...", "answer": "..." } ],
  "about":    { "headline", "body",
                "staff": [ { "id","name","position","bio","imageUrl","linkedIn" } ] },
  "socialLinks": { "x": "...", "linkedin": "..." },
  "updatedAt": "2026-08-11T…"
}
```

`features` and `faqs` are always arrays, never null, so sections can map without
guarding. Admin edits them via `PUT /admin/v1/site-content`.

---

## 3. The destructive dialog, made misread-proof

You were right to put this first. `selectedMealsRemoved` **was** nested under
`consequences`, so reading it flat would have given `undefined` — a confirmation
implying nothing would be lost while the confirm cleared their food selections.

Rather than only renaming, the endpoint now returns the numbers **both flat and
nested**, plus server-authored copy:

```jsonc
// GET /auth/me/profile/country/change-preview?country=KE
{
  "from": { "country": "NG", "currency": "NGN", "name": "Nigeria" },
  "to":   { "country": "KE", "currency": "KES", "name": "Kenya" },

  "currentCurrency": "NGN",          // flat — safe to read directly
  "nextCurrency": "KES",
  "selectedMealsRemoved": 5,

  "warnings": [
    "Your 5 selected foods will be cleared — Kenya has its own food list.",
    "Amounts across the app, including your budget, will show in KES instead of NGN. Existing figures are not converted."
  ],

  "consequences": { "selectedMealsRemoved": 5, "foodsAvailableInNewCountry": 6,
                    "currencyChanges": true, "budgetsRedenominated": true },
  "requiresConfirmation": true
}
```

**Render `warnings` verbatim.** They are pluralised and name the real currencies
and counts, and a wrong field name cannot make them silently empty — an empty
array means genuinely nothing will be lost.

---

## 4. High-risk shapes — captured live

Your eleven, with what the server actually returns. Differences from your
assumption are called out.

**`GET /public/avatar-presets`** — no `gradient`; the field is `url`, not `imageUrl`.
```jsonc
{ "presets": [ { "id", "key": "fox", "label": "Fox",
                 "url": "/avatars/presets/fox.svg", "category": "animals" } ] }
```

**`GET /public/security/:token`** — flat, not under `token`. No `actorName`;
`summary` is a ready-made sentence that already names the inviter.
```jsonc
{ "type": "SEAT_INVITE" | "SIGNUP" | "PASSWORD_RESET",
  "email": "…",
  "summary": "Adaeze invited you to a shared Life Planner plan they pay for.",
  "canReject": true,        // true only for SEAT_INVITE
  "expiresAt": "…" }
```

**`POST /public/security/:token`** — your guess was a subset; there is more.
```jsonc
{ "type": "SIGNUP", "outcome": "REPORTED" | "REJECTED",
  "consequences": ["account suspended pending review", "all sessions ended"],
  "message": "Thank you — this has been reported to our team and we have secured the account." }
```

**`GET /stats/coach-insight`** — flat on `data`, **not** under `insight`, and
`null` when nothing has been written for the range. Handle the null.
```jsonc
{ "id", "headline", "body", "periodStart": "2026-08-04", "periodEnd": "2026-08-11",
  "author": { "id", "name": "Maya Okafor", "avatarUrl": null }, "createdAt" }
```

**`GET /activities/:id/history`** — `changeType`, not `action`. No `actorName` or
`detail`; `adminId` is null for user-initiated changes.
```jsonc
{ "history": [ { "id", "activityId",
    "changeType": "CREATED" | "UPDATED" | "TOGGLED" | "DELETED" | "DELETED_BY_ADMIN",
    "snapshot": null, "adminId": null, "createdAt" } ] }
```

**`GET /chat/feedback-forms`** — periods, not `weekOf`; ratings are flat ints.
```jsonc
{ "forms": [ { "id", "status": "SENT" | "COMPLETED" | "EXPIRED",
    "periodStart": "2026-08-03", "periodEnd": "2026-08-09",
    "platformRating": null, "lifeCoachRating": null, "fitnessRating": null,
    "supportRating": null, "comment": null, "expiresAt", "respondedAt": null } ] }
```

**`GET /search`** — your three keys are right, plus `query` and `totals`.
Activities carry `isPrivate` and a nested `category { id, name, color }`.
```jsonc
{ "query": "run",
  "activities": [ { "id","title","date","startTime","isDone","isPrivate",
                    "category": { "id","name","color" } } ],
  "goals": [ { "id","title","status","featured" } ],
  "notes": [ { "id","date","content","mood" } ],
  "totals": { "activities": 3, "goals": 1, "notes": 0 } }
```

**`GET /subscription/transactions`** — `netAmount` **added** for you this pass.
There is no `invoiceUrl`; `providerInvoiceId` is the identifier, often null.
```jsonc
{ "transactions": [ { "id", "type", "status", "provider", "currency",
    "grossAmount": 4500, "netAmount": 4186.05, "taxAmount": 313.95,
    "description", "occurredAt", "providerInvoiceId": null } ] }
```

**`GET /seat-invites/:token`** — public preview shown before signup; unauthenticated.

**`GET /auth/me/profile/country/change-preview`** — see section 3.

**`GET /public/content`** — see section 2.

---

## 5. Medium-risk nested shapes — two now changed for you

**`ChatMessage.reactions[]` — changed.** It used to return one raw row per
person, so every client would have grouped them slightly differently. It now
returns exactly what a chat UI draws:

```jsonc
"reactions": [ { "emoji": "🎉", "count": 2, "reactedByMe": true } ]
```

Your assumed shape, now real. Verified with two different reactors on one
message. Remove any client-side grouping you wrote.

**`ChatMessage.replyTo` — changed.** `senderName` added, since the quote bubble
needs to name who is being quoted.

```jsonc
"replyTo": { "id", "senderType": "USER" | "ADMIN" | "SYSTEM", "kind": "TEXT",
             "senderName": "Demo User",
             "content": "…" | null,     // null when deleted
             "deleted": false }
```

`deleted` is the field you flagged as tombstone-critical — it is named exactly
that, and `content` is independently nulled server-side, so even a wrong read of
`deleted` cannot leak the text.

**`ChatMessage.recommendation`** — `title` and `date` live inside `payload`, not
at the top. `createdEntityId` added this pass.
```jsonc
{ "id", "kind": "ACTIVITY" | "GOAL",
  "status": "PENDING" | "ACCEPTED" | "DISMISSED",
  "payload": { "title": "Easy 5k", "date": "2026-08-11", … },
  "createdEntityId": null }
```

**`stats/daily → days[].byCategory[]`** — your guess was exactly right:
`{ categoryId, name, color, minutes }`, alongside `date` and `totalMinutes`.

**`GET /subscription/seats`** — it is `seatCount`, **not** `total`. Others as
assumed: `pendingSeatCount`, `used`, `available`,
`history[] { email, status, invitedAt }`, `seats[]`.

**`GET /notifications`** — `items[]` exactly as assumed
(`{ id, userId, type, title, body, href, metadata, readAt, createdAt }`), plus
`nextCursor`.

**`MealPlan.meals[].items[]`** — no per-item `calories`; calories are on the
**meal** (`meal.calories`, computed, and `meal.estimatedCalories`, the coach's
own figure).
```jsonc
{ "id", "mealId", "foodItemId", "freeText": null,
  "weightGrams": 150, "servings": null, "order": 0,
  "foodItem": { … } | null }
```

---

## 6. Still true, unchanged

`POST /calendar-connections` with `provider: GOOGLE` remains a deliberate 501.
`GET /budget/:y/:m` still 404s on an untouched month while `/ledger` returns 200
with `started: false` — your read of that is right.

Your note about request bodies is the one I would keep in mind: this pass, like
the last, verifies **responses**. `POST /activities/bulk` and `PATCH /recurring/:id`
were wrong in your client and nothing on my side would have caught it. If you
want request bodies verified too, the Postman collection is the contract — the
Activities and Recurring folders hold the bodies those two screens should match.

---

## What to change on the client

1. `data.hero` / `data.features` / `data.faqs` — top-level, not under `content`.
2. `avatar-presets`: `url`, not `imageUrl`; drop `gradient`.
3. `security/:token`: flat; use `summary`, there is no `actorName`.
4. `coach-insight`: flat on `data` and nullable — not `data.insight`.
5. `activities/:id/history`: `changeType`, not `action`.
6. `transactions`: `netAmount` now available; `providerInvoiceId`, no `invoiceUrl`.
7. `seats`: `seatCount`, not `total`.
8. `feedback-forms`: `periodStart` / `periodEnd`, not `weekOf`.
9. Meal items: read calories from the meal, not the item.
10. Country preview: render `warnings` verbatim.
11. Reactions and `replyTo.senderName` now match what you assumed — no change
    needed beyond removing any client-side grouping.
12. Milestone delete already exists: `{ deleted: true }`, not `{ ok: true }`.
