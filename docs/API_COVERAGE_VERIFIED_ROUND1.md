# API coverage — verified against a live backend

Answering `API_COVERAGE.md`, whose own closing note says: *"Not performed: no run
against a live backend."* This is that run.

Method: both services booted against live Postgres 16 and Redis 7 on a freshly
seeded database; every endpoint referenced in the document called for real; a
scripted diff of all 247 implemented routes against the document's references.

**Result: everything the document relies on exists and responds.** Three things
it flagged as unconfirmed turned out to need backend changes, and those are now
made.

---

## 1. Endpoint existence

45 distinct endpoints are referenced. All resolve except one, and the five that
first appeared missing were mostly a shorthand artefact:

| Referenced as | Reality |
| --- | --- |
| `GET/POST/PATCH/DELETE /recurring` | Real routes are `/recurring` and `/recurring/:id` — present |
| `GET/POST/PATCH/DELETE /tags` | `/tags`, `/tags/:id` — present |
| `GET/POST/DELETE /reminders` | `/reminders`, `/reminders/:id` — present |
| `GET /budget/…` | `/budget/:year/:month` — present |
| `GET /budget/recent-months` | **Did not exist. Now built.** |

The deprecated `GET /budget/:y/:m/summary` still exists and still works, so the
decision not to use it remains correct rather than blocking.

---

## 2. Unwrap keys — all confirmed

Section 1 listed eight endpoints whose envelope key was inferred rather than
confirmed. Called live, every inference was right:

| Endpoint | Actual |
| --- | --- |
| `GET /activities` | `data.activities` |
| `GET /goals` | `data.goals` |
| `GET /tags` | `data.tags` |
| `GET /reminders` | `data.reminders` |
| `GET /recurring` | `data.recurring` |
| `GET /board-shares` | `data.boardShares` *(plus `data.direction`)* |
| `GET /settings` | `data.settings` |
| `GET /budget/:y/:m` | `data.budgetMonth` |

Two details worth carrying into the client:

- `GET /board-shares` also returns `direction`, echoing the `?direction=granted|received`
  filter. The default is `granted`, which is why a viewer's list looks empty
  until `?direction=received` is passed.
- `GET /budget/:y/:m/incomes` returns `data.year`, `data.month` **and**
  `data.incomes` — the month context rides along, so a bare "sole property"
  fallback would pick the wrong key here. Name it explicitly.

The 17 keys the document listed as confirmed were all spot-checked and match.

---

## 3. Three things that needed backend changes

### `GET /ledger` used to 404 on an untouched month

The document was right to flag this, and the answer was the bad one: an untouched
month returned `404 NOT_FOUND — "No budget set for 2031-11 yet"`. The empty state
would have rendered an error.

**Fixed.** A ledger is a *view* of a month, not a resource that must be created
first, so a month nobody has touched now returns `200` with empty lists, zeroed
totals, the resolved `currency`, and:

```json
"started": false
```

`started` is also returned as `true` on populated months, so "start a brand new
budget" is a single field check rather than an error path. `GET /budget/:y/:m`
still 404s — it addresses the month record itself, which genuinely may not
exist.

### `GET /budget/recent-months` did not exist

**Built**, matching the proposed shape, with one addition:

```json
{ "months": [
  { "year": 2026, "month": 7, "recurringIncomes": 1, "incomes": 3,
    "expenses": 5, "hasData": true }
]}
```

`recurringIncomes` is counted separately from total `incomes` because only the
recurring ones are what a person means by "copy last month" — one-off client
invoices should not be carried forward blindly. Months with no data are returned
with `hasData: false` rather than omitted, so the chooser can show "June (empty)"
instead of silently skipping it. Three round trips become one.

### `GET /calendar` never returned imported events

Section 5 item 3 guessed this was a field-name mismatch and "a five-minute
change". It was not — the key did not exist at all. `ImportedEvent` was modelled
and the connection endpoints worked, but the calendar view never surfaced them,
so the overlay could not have been drawn regardless of naming.

**Fixed.** Each day now carries:

```json
"importedEvents": [
  { "id": "…", "title": "Standup", "startTime": "09:30", "endTime": "09:45",
    "allDay": false, "location": null, "source": "Team calendar" }
]
```

Kept deliberately separate from `activities`: imported events are not editable,
do not count toward quota, and must not affect streaks — so `total` and `done`
ignore them entirely. `source` is the connection's label, falling back to the
provider name.

**They are also owner-only.** A shared board returns `importedEvents: []` even
for a `FULL` grant. Somebody connects a work calendar for themselves, not to
publish it to whoever they share a board with. Verified live from both sides.

---

## 4. Section 5's other items, checked

**Mobile purchase verification** — `POST /subscription/verify-purchase` works,
and since that document was written the store lifecycle has been closed:
`/webhooks/store/apple` (ASSN V2) and `/webhooks/store/google` (RTDN) now handle
renewals, cancellations, grace periods and refunds. The native wrapper no longer
needs to poll.

**`POST /calendar-connections` with `provider: GOOGLE`** — still a deliberate
501. ICS is the working path.

**Household plans** — confirmed closed. Seats grant entitlement, never ownership;
`BoardShare` remains the only sharing mechanism.

---

## 5. What was verified, and what was not

Every endpoint in section 4's "existed but had no UI" table responds `200`:
`/recurring`, `/stats/mood`, `/tags`, `/reminders`, `/meal-plans/requests`,
`/chat/feedback-forms`, `/board-shares`.

The backend suite is **247 assertions, 0 failures** on a clean seeded database,
covering all of the above plus the paywall, RBAC, moderation, billing and the
budget ledger.

**Not verified here:** that the frontend consumes these shapes correctly. This
confirms the backend contract; the client-side wiring is still only as good as
its own type checks. The three fixes above change two response shapes
(`/ledger` gains `started`, `/calendar` gains `importedEvents`) and add one
endpoint — all additive, so nothing already written should break.
