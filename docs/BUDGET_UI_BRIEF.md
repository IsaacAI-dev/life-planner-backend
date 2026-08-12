# Budget redesign — income as first-class rows

A brief for updating the Budget page. Everything here is live in the API; no
endpoint below is speculative.

---

## What changed, in one line

The budget used to have **one number for income**. It now has **a list of income
rows**, each with its own title, amount and status — because "did the client
actually pay?" is the question that makes a freelance budget realistic, and one
figure cannot answer it.

## Why the screen needs rethinking

The old page could be a single form: type your monthly income, add expenses,
read a balance. The new page is a **ledger with two sides**, and the interesting
tension is between *money I actually have* and *money I am expecting*. The
design should make that tension legible at a glance, because that is the whole
point of the feature.

A person opening this screen is usually asking one of three questions:

1. **"Can I afford this right now?"** → arrived income minus paid expenses.
2. **"Will I be okay this month?"** → everything expected, minus everything owed.
3. **"Who still owes me?"** → the projected list, sorted by expected date.

The layout should let all three be answered without navigating anywhere.

---

## The data

`GET /budget/:year/:month/ledger` returns everything the screen needs in one
call. Shape:

```jsonc
{
  "year": 2026, "month": 8,
  "currency": "NGN",              // resolved from the user's country — format with this
  "notes": null,
  "incomes": [
    {
      "id": "...",
      "title": "Salary",
      "description": "Monthly net salary",
      "source": "Employer",
      "amount": 320000,
      "status": "ARRIVED",           // PROJECTED | ARRIVED | DEFERRED | CANCELLED
      "expectedDate": "2026-08-25",
      "receivedAt": "2026-08-04T...",
      "rolledOver": false,            // true = slipped in from an earlier month
      "recurring": true
    }
  ],
  "expenses": [
    { "id": "...", "title": "Rent", "amount": 150000,
      "category": "MANDATORY",        // MANDATORY | SECONDARY | OPTIONAL
      "status": "PAID",               // COMMITTED | PAID
      "paidAt": "2026-08-04T..." }
  ],
  "totals": {
    "arrivedIncome": 320000,
    "projectedIncome": 335000,
    "totalIncome": 655000,
    "deferredIncome": 0,
    "totalExpenses": 250000,
    "paidExpenses": 168000,
    "outstandingExpenses": 82000,
    "availableNow": 152000,          // arrived − paid  → question 1
    "projectedBalance": 405000       // all income − all expenses → question 2
  },
  "byCategory": [
    { "category": "MANDATORY", "color": "#DC2626", "total": 168000, "paid": 168000 }
  ],
  "counts": { "incomes": 4, "awaiting": 3, "expenses": 5, "unpaid": 3 }
}
```

**The server owns all arithmetic.** Never re-derive a balance on the client —
two surfaces computing it independently is how they end up disagreeing. Filters
are a *view*: `?status=ARRIVED` narrows the returned list but the totals always
describe the whole month.

---

## The four statuses, and how they should read

| Status | Meaning | Visual intent |
| --- | --- | --- |
| `ARRIVED` | In the bank | Solid, confident, full-colour. This is real money. |
| `PROJECTED` | Expected, not yet here | Lighter, outlined, provisional. Not a promise. |
| `DEFERRED` | Slipped; rolled into a later month | Muted, struck-through or greyed. Present but not counted. |
| `CANCELLED` | Written off | Faintest, collapsible. Ideally hidden behind a toggle. |

The single most important visual decision on this page: **projected money must
never look like arrived money.** If a glance can confuse the two, the redesign
has failed at its main job. Weight, fill and opacity are better tools here than
colour alone — colour is already carrying budget categories on the expense side.

`DEFERRED` and `CANCELLED` are excluded from every total but still listed, so a
month reads honestly: "I expected ₦400k here, it didn't come." Show them, but
make it obvious they aren't counted.

## Rollover

When an income slips, the original stays put as `DEFERRED` and a **new**
`PROJECTED` row appears in the target month with `rolledOver: true`.

That row deserves a small badge — "rolled over from July" — because a client who
has slipped three months running is exactly the thing a freelancer needs to
notice. Don't render it as an ordinary new income; the history is the value.

---

## Suggested structure

Three zones, in priority order:

**1. The headline pair.** `availableNow` and `projectedBalance`, side by side,
clearly distinguished. `availableNow` is the honest number and should carry more
weight; `projectedBalance` is the optimistic one. Some subtle cue that one is
real and one is a forecast — a dashed border, a "if all goes to plan" label —
does a lot of work here.

**2. Income.** A list, grouped or sortable by status, with `expectedDate`
visible on projected rows so "who owes me, and when" is scannable. Each row
needs: title, source, amount, status, and a one-tap **Mark as arrived**. That
action is the most-used control on the page — a person opens this screen
*because* money landed. Give it prominence and make it reversible without a
confirmation dialog.

Secondary per-row actions: roll forward, edit, cancel, delete.

**3. Expenses.** Largely as today, plus a paid/unpaid state mirroring the income
side, and `byCategory` now carrying both `total` and `paid` — a category bar
that fills as things get paid would make the two halves of the page rhyme.

## Empty and edge states worth designing

- **No income yet** — the most common first-run state. The prompt should invite
  a *source*, not a number: "Add your salary, a client invoice, anything you're
  expecting." That framing teaches the model in one sentence.
- **Everything projected, nothing arrived** — early in the month. `availableNow`
  is 0 and that is not alarming; make sure it doesn't read as alarming.
- **Overspend** — `projectedBalance` negative. Worth a distinct treatment, but
  restrained; this is somebody's actual financial stress, not a gamification
  moment.
- **A deferred row from two months ago that keeps rolling** — the design should
  let this accumulate visibly without becoming clutter.

---

## Endpoints

| Action | Call |
| --- | --- |
| Load the screen | `GET /budget/:y/:m/ledger` |
| Income list only | `GET /budget/:y/:m/incomes?status=&arrivedOnly=` |
| Add income | `POST /budget/:y/:m/incomes` |
| Edit income | `PATCH /budget/:y/:m/incomes/:id` |
| **Mark arrived** | `POST /budget/:y/:m/incomes/:id/arrived` |
| Undo arrived | `POST /budget/:y/:m/incomes/:id/unarrived` |
| Roll to a later month | `POST /budget/:y/:m/incomes/:id/roll` `{year, month}` |
| Cancel | `POST /budget/:y/:m/incomes/:id/cancel` |
| Delete | `DELETE /budget/:y/:m/incomes/:id` |
| Mark expense paid / unpaid | `POST /budget/:y/:m/expenses/:id/paid` · `/unpaid` |
| Copy a month forward | `POST /budget/:y/:m/copy-from` `{fromYear, fromMonth}` |

**Creating income** takes `title` (required), `amount` (required), plus optional
`description`, `source`, `expectedDate`, `status: "ARRIVED"` for money already
banked, and `recurring: true`. A recurring income silently materialises as
`PROJECTED` into the next three months — the person is not told about the
horizon, it simply stays topped up. The form should offer a plain "repeats
monthly" checkbox and say nothing about three months.

## Constraints

- **One currency per person**, resolved from their country and returned as
  `currency` on the ledger. No picker, no per-row currency — mixing currencies
  needs live FX and is out of scope. Format every amount with that code.
- A rolled-over row exposes both `rolledOver: true` and `rolledFromId`, so the
  badge can link back to the month the money slipped from.
- Categories stay `MANDATORY` / `SECONDARY` / `OPTIONAL` with fixed colours from
  the API (`byCategory[].color`). Don't invent new ones.
- `expectedDate` must fall inside the month being viewed; the API rejects
  otherwise, so constrain the date picker.
- Amounts are positive only. There is no negative income — that's an expense.
