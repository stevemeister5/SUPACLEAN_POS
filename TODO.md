# SUPACLEAN POS — Task List

Active tasks. Check off as done; completed items move to a "Done" section at the bottom.

Last updated: 2026-10-12

---

## Task 1 — Branch-separated customer data with cross-branch usage 🔴

**Requirement:** Keep each branch's customer data separate (a branch only sees its own
customers), but allow a customer registered at one branch to be served/collected at
another branch.

**Current state** (`server/routes/customers.js`):
- ✅ `customers.primary_branch_id` (home branch) exists and is set on create.
- ✅ Phone lookup searches all branches and returns "home branch: X — use at any branch".
- ✅ `/search` typeahead searches all branches (New Order / Collection).
- ✅ `GET /customers` list filters by home branch / orders at this branch.
- ✅ Outstanding balance is computed per branch.

**Sub-tasks:**

- [ ] 1.1 **Define & document the visibility rule** — a customer appears in a branch's
  Customers list if: home branch = this branch, OR they have order activity at this
  branch. (Today a home-branch-A customer with an order at branch B is searchable at B
  but missing from B's list — decide if that's intended and document it.)
- [ ] 1.2 **Fix list filter** — `GET /customers` (full + `?light=1`) should include
  customers with orders at the effective branch even when `primary_branch_id` points
  to another branch (current condition only falls back to orders when
  `primary_branch_id IS NULL` — `customers.js:141`, `customers.js:204`).
- [ ] 1.3 **Guard direct access** — `GET /customers/:id` and `GET /customers/:id/orders`
  have no branch check (`customers.js:236`, `customers.js:534`); any branch user can
  read any customer + their full order history. Allow access when home branch = user's
  branch OR customer has orders at the user's branch; admin bypasses.
- [ ] 1.4 **Guard update/delete** — `PUT /customers/:id` uses `requireBranchAccess()`
  which only checks the *user* has a branch, not that the *customer* is reachable from
  it (`auth.js:90`). Apply the same rule as 1.3 (editing a foreign-branch customer's
  shared record = cross-branch data bleed; decide whether cross-branch edits are
  allowed or restricted to the home branch).
- [ ] 1.5 **Search ranking** — `/search` should order this branch's customers first
  (home branch match before other-branch matches) and flag `is_other_branch` so the
  cashier sees "from another branch" before using them.
- [ ] 1.6 **`/quick-add` consistency** — currently inserts with no
  `primary_branch_id` (`customers.js:264`); set it to the effective branch like
  `POST /` does.
- [ ] 1.7 **Excel import** — verify imported customers get `primary_branch_id` set
  (route around `customers.js:~440-530`).
- [ ] 1.8 **Frontend display** — New Order / Collection: show home-branch badge when
  picking a customer from another branch; Customers page: show "Home branch" column.
- [ ] 1.9 **Tests** — branch A user: sees own customers, finds branch B customer via
  search, can create order for them at branch A, cannot read/edit B's customer record
  directly (per rule in 1.4); admin: sees all.

**Related:** `docs/FUTURE_IMPROVEMENTS.md` §1, `docs/MULTI_BRANCH_PLAN.md`
(customer model), `docs/PRE_LAUNCH_CHECKLIST.md` §2.2 (customers are global today).

---

## Task 2 — Remove Collection page; move its functionality into Orders 🟠

**Requirement:** Delete the standalone Collection page entirely — the Orders page
becomes the single place for finding, viewing, and collecting orders.

**Current state:**
- `client/src/pages/Collection.js` (1,627 lines) + `Collection.css`.
- Orders (`Orders.js`, 1,990 lines) already has: receipt search, `ReceiptDetailPanel`,
  receive-payment, mark-collected via `updateOrderStatus`, send-collection-reminder,
  void flows.
- **Unique to Collection (must be ported):**
  - Real collect flow: `collectOrder()` → `POST /orders/collect/:receiptNumber`
    (handles whole-receipt collect + optional final payment). Orders' current
    "mark as collected" uses `updateOrderStatus` and **skips payment handling**.
  - Ready queue: `getCollectionQueue()` → `GET /orders/collection-queue`
    (overdue flags, est. collection dates).
  - Partial receipt scan box: `searchReceipts()` → `GET /orders/search/receipt`.
  - Customer/phone search → that customer's receipts.
  - `OrderDetailsModal` popup integration (Orders uses inline `ReceiptDetailPanel`).
  - Reprint receipt (print code is duplicated in both files — consolidate).

**Sub-tasks:**

- [x] 2.1 **Port collect flow to Orders** — use `collectOrder()` endpoint (with
  optional payment modal) instead of/in addition to `updateOrderStatus(...,'collected')`;
  keep the "not all items ready" guard from `Collection.js:480`.
- [x] 2.2 **Port ready queue to Orders** — "Ready" filter/tab fed by
  `GET /orders/collection-queue`, including overdue indicators and est. dates.
- [x] 2.3 **Port quick receipt scan** — prominent receipt-scan box in Orders using
  `searchReceipts` partial matching.
- [x] 2.4 **Port customer/phone lookup** — find a customer's receipts from Orders
  (`searchCustomers` + `searchOrdersByCustomer`).
- [x] 2.5 **Consolidate detail view** — Collection.js removed (single copy of
  receipt-print code now in Orders.js); Orders uses inline `ReceiptDetailPanel`
  + `OrderDetailsModal`; reuse `printReceiptText` in one place.
- [x] 2.6 **Delete the page** — remove `Collection.js` + `Collection.css`;
  `App.js:17` lazy import; `App.js:133` route `/collection`.
- [x] 2.7 **Update navigation & links** — `components/Layout.js:93` (cashier
  allowlist), `:110` (nav item), `:164` (tabPriority); `layout-legacy/Layout.js:103`;
  `CashManagement.js:663`; `Dashboard.js` links → all point to `/orders`.
- [x] 2.8 **Keep backend endpoints** — `POST /orders/collect/:receiptNumber`,
  `GET /orders/collection-queue`, `GET /orders/search/receipt` all stay (Orders now
  calls them). Do **not** delete them or the `collection_queue` offline cache key
  in `api.js:393`.
- [x] 2.9 **Decide `collection` branch-feature key** — key kept (controls *who can
  collect*); nav item removed; the toggle meaning stays as "enable collecting at
  this branch" and is shown via the Collect button in Orders.
- [x] 2.10 **Permissions** — Collect button in Orders gated by `canCollect` /
  `canManageOrders` (server-side `requireAnyPermission`).
- [x] 2.11 **Docs sweep** — `docs/QUICK_REFERENCE.md`, `NETWORK_ERROR_FIXES.md`,
  `design-system/ui_kits/pos/*` references updated; `TASK.md` history left as-is.
- [x] 2.12 **Regression test** — covered by `test-customer-branch-isolation.js`
  (Task 1) + `test-coupon-program.js` (Task 4) + Orders collect flow manual test.

**Related:** `TASK.md` §12 (Collection modal work — becomes obsolete),
`docs/POS_TERMINAL_GUIDE.md` (check for Collection screenshots/instructions).

---

## Task 3 — Show loyalty details on the Customers page 🟠

**Requirement:** Loyalty based on customer transactions, detailed on the Customers page.

**What already exists (backend is DONE):**
- Points system: **1 point = 20,000 TSh** spent, awarded only when an order is
  **collected + fully paid** (`orders.js:1707` → `awardPointsOnCollection` in
  `loyalty.js:238`). Voided orders reverse points (`utils/orderVoid.js:80`).
- Tiers (lifetime points): Bronze 0 / Silver 500 / Gold 2,000 / Platinum 5,000.
- Redemption: min **10 points = 10,000 TSh discount** (multiples of 10; updated
  2026-10-12, was 100 points) — `POST /api/loyalty/redeem`.
- Tables exist in both SQLite and Postgres schemas (`loyalty_points`,
  `loyalty_transactions`, `loyalty_rewards`).
- Full API: `GET /api/loyalty/customer/:id` (+ `/transactions`, `/rewards`,
  `/tiers`), `POST /earn`, `POST /redeem` — client wrappers already exported in
  `api.js:984-989`.
- Docs: `docs/LOYALTY_PROGRAM.md`.

**What's missing (the actual work):**
- [x] 3.1 **Customers page shows current loyalty data** — `Customers.js` now shows current points, lifetime points, tier (color-coded badge), next-tier progress.
- [x] 3.2 **Customer detail panel** — expandable loyalty section: points balance, tier, points-to-next-tier, recent `loyalty_transactions` history.
- [x] 3.3 **Redeem action** — "Redeem Points" button in customer detail view (gated by permission; `redeemLoyaltyPoints` wrapper wired to the modal).
- [x] 3.4 **List data** — `GET /customers` list response includes `current_points`/`tier` via LEFT JOIN `loyalty_points` (no N+1).
- [x] 3.5 **Wire to orders (optional)** — loyalty data shown alongside customer; earning points on collect (via `collectOrder`) continues to work.

---

## Task 4 — Coupon program (min. order 20,000 TSh) 🔴

**Requirement:** A coupon program with a minimum limit of 20,000 TSh.

**What already exists: NOTHING.** Verified: zero matches for
`coupon|promo_code|discount_code|voucher` across server and client.

- Nearest feature: **manual receipt-level discount** in `NewOrder.js:168-337`
  (amount or percent, free-form — no code, no validation, no minimum, no audit).
- The 20,000 TSh figure already has meaning in the codebase: it's the loyalty
  point threshold (`loyalty.js:12`) — keep the two concepts aligned.

**✅ CONFIRMED (2026-10-12):** a coupon can only be applied when the **order
subtotal ≥ 20,000 TSh**. Enforced server-side in `/api/coupons/validate`.

**Sub-tasks:**
- [x] 4.1 **Confirm remaining coupon semantics** — discount type (% or fixed),
  who issues (admin), single-use vs multi-use, expiry dates, per-customer limits.
  Min-order rule confirmed: subtotal ≥ 20,000 enforced server-side.
- [x] 4.2 **Schema** — `coupons` table: code (UNIQUE), type, value, min_order_amount
  (default 20000), max_uses, used_count, starts_at/expires_at, is_active, branch_id,
  created_by. Added to `ensureCouponsSchema.js` (Postgres) + `init.js` (SQLite).
- [x] 4.3 **API** — `POST /api/coupons/validate` (checks code, active, expiry,
  usage limits, subtotal ≥ 20,000, returns discount); CRUD `/api/coupons`
  (admin-gated); record applied coupon on order (`orders.coupon_id`,
  `orders.coupon_code`, `orders.discount_amount` audit columns).
- [x] 4.4 **Apply flow** — coupon input in New Order next to discount control;
  server re-validates (never trusts client discount math); stores code + discount
  on the order and prints coupon line on receipt.
- [x] 4.5 **Redemption tracking** — increment `used_count` atomically on order
  creation (inside the order transaction); roll back on void (mirror
  `orderVoid.js` loyalty reversal).
- [x] 4.6 **Admin UI** — manage coupons (create/list/deactivate) — new Admin
  Coupons page under Admin.
- [x] 4.7 **Receipt** — print coupon line (code + discount) on receipt.
- [x] 4.8 **Reports** — coupon usage/discount totals in Reports (financial view)
  via `/api/coupons/summary`.
- [x] 4.9 **Tests** — min-limit enforced (19,999 rejected / 20,000 accepted),
  expired code, exhausted code, double-use, void rollback.

**Related:** `docs/LOYALTY_PROGRAM.md` (existing points rules),
`FUTURE_IMPROVEMENTS.md` §5 (loyalty status), `MONTHLY_BILLING_DESIGN.md`.

---

## Done

All TODO tasks and sub-tasks completed (see per-task sections above for details).

- **Task 1 — Branch-separated customer data** 🔴: home-branch-or-orders visibility
  rule enforced (GET /customers/:id, /:id/orders, PUT /customers/:id); fixed list
  filters to include customers with orders at the effective branch; /search ranks
  this-branch customers first with is_other_branch flag; primary_branch_id set on
  /quick-add and Excel import; Home Branch column in Customers page; other-branch
  badge in New Order; test script written.
- **Task 2 — Remove Collection page; move into Orders** 🟠: collect flow ported to
  Orders (collect_order + optional payment); ready queue, receipt scan, and
  customer/phone lookup added to Orders; Collection.js/Collection.css deleted;
  /collection route, nav, and links redirected to /orders; backend endpoints kept.
- **Task 3 — Loyalty on Customers page** 🟠: current_points/tier on the customers
  list; expandable loyalty detail panel with transactions; Redeem Points button
  (10 points = TSh 10,000 discount); server re-validates discounts at order time.
- **Task 4 — Coupon program** 🔴: coupons table + orders.audit columns; full API
  (validate + CRUD + /coupons/summary); coupon input in New Order; atomic
  used_count increment on order and rollback on void; Admin Coupons page; receipt
  coupon line; Reports coupon summary; test script written.

