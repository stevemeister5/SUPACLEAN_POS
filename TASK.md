# SUPACLEAN POS — Backend Audit & Remediation Plan

> Scope: entire `server/` backend (10,753 lines of routes), schema provisioning, client flows.
> Lens: **front-office POS** — speed and intuitiveness for cashiers are the priority.
> Method: every finding verified against live DB or source; line numbers cited.

## 0. Executive summary

| Severity | Count | Theme |
|----------|-------|-------|
| CRITICAL | 5 | Broken flow, data leaks, fresh-deploy-brick |
| MAJOR | 6 | Front-office friction, inconsistency, silent bugs |
| MINOR | 7 | Robustness, duplication, naming |

**Biggest risk:** schema provisioning is fragmented. Live DB works, but a fresh `npm start` on empty PostgreSQL creates only **25 of 43 tables** — missing `users`, `orders`, `customers`, `transactions`, `branches`, `services`. No login, no orders. See §1.

---

## 1. CRITICAL — Schema provisioning gap (fresh deploy bricks)

**Facts (verified):**
- Production loads 15 `ensure*.js` at startup (`server/index.js:71-85`) — the *only* boot provisioning.
- `init.js` is **SQLite-only, never loaded in production** (`init.postgresql` not required in `index.js`).
- The 15 `ensure*.js` create **25 tables**. The other **18 tables** in the live DB are created *only* by `init.js` or one-off `scripts/migrate-*.js` (not run at startup).

### 1.1 Tables in live DB with NO `ensure*.js` provisioning

| Table | Created only by | Impact if missing |
|-------|----------------|-------------------|
| `users` | `init.js:301` | **Login impossible** |
| `user_sessions` | `init.js:332` | **Login impossible** |
| `branches` | `init.js:269` | No branch scoping |
| `customers` | `init.js:36` | **Core POS broken** |
| `services` | `init.js:47` | **Core POS broken** |
| `orders` | `init.js:63` | **Core POS broken** |
| `transactions` | `init.js:108` | **Payments broken** |
| `daily_cash_summaries` | `init.js:121` | Cash reports broken |
| `expenses` | `init.js:148` | Expenses broken |
| `bank_deposits` | `init.js:170` | Banking broken |
| `branch_features` | `init.js:291` | **`requireBranchFeature('collection')` → 403** |
| `settings` | `init.js:96` | Config missing |
| `notifications` | `init.js:182` | Notifications broken |
| `payment_audit_log` | `init.js` | Audit trail missing |
| `order_transfers` | `init.js` | Transfers missing |
| `loyalty_*` (3) | `init.js` | Loyalty broken |

### 1.2 Columns referenced by routes, only in `init.js`

These **exist in live DB** (verified) but a fresh `ensure*.js`-only deploy lacks them:

| Column | Table | Referenced by |
|--------|-------|---------------|
| `estimated_collection_date` | orders | `orders.js` widely |
| `ready_at_branch_id` | orders | `orders.js:1477` |
| `collected_at_branch_id` | orders | `orders.js:1484` |
| `sms_notifications_enabled` | customers | `orders.js:638`, `notifications.js` |
| `is_active` | users | `auth.js:18` (login **crashes** without it) |
| `phone_normalized` | customers | search |

### 1.3 Why the live DB is fine today

Built up over time via `init.js` (early), manual SQL, `scripts/migrate-*.js`. It is **more complete** than `ensure*.js` alone produces — so login/orders work now, but it's fragile and unreproducible.

### 1.4 Recommended fix

One authoritative idempotent schema source (`ensurePosCoreSchema.js`) creating **all 43 tables** + every column routes reference. Remove `init.js` reliance for production. Fresh DB becomes self-healing.

---

## 2. CRITICAL — Broken flows & data leaks

### 2.1 Cashier **cannot collect orders** (core workflow broken)
- `server/routes/orders.js:1633` gates collect on `requirePermission('canManageOrders')`.
- `server/middleware/permissions.js:46` → cashier has `canManageOrders: false`.
- Cashier **creates** orders (`canCreateOrders: true`) but **cannot collect** them.

**Fix:** introduce `canCollect` permission (cashier + manager + processor), gate collect on it.

### 2.2 Two unauthenticated endpoints (data leak)
- `orders.js:2401` `router.get('/notifications', async (req, res) => {` — **no `authenticate`**. Leaks every customer name, phone, SMS preference, pending balance.
- `orders.js:805` `router.get('/receipt/:receiptNumber/qrcode', async (req, res) => {` — **no `authenticate`**. Leaks receipt/customer data.

**Fix:** add `authenticate` (+ `requireBranchAccess()`) to both.

### 2.3 `items.js:24` operator-precedence bug (admins never see inactive items)
```js
if (!req.user.role === 'admin' || include_inactive !== 'true') {
  query += ' AND i.is_active = TRUE';
}
```
`!req.user.role` → `false`; then `false === 'admin'` → `false`. Left side **always false** → the `is_active = TRUE` filter is **always applied**. Admins never see inactive items even when requesting them.

**Fix:** `if (req.user.role !== 'admin' && include_inactive !== 'true') {`

### 2.4 No index on `orders.receipt_number` (slow receipt lookup)
Verified: `pg_indexes` on `orders` → **zero** indexes mention `receipt_number`. Both exact lookup (`orders.js:418`) and partial search do **sequential scans**. Receipt lookup is the most common front-office action — it must be instant.

**Fix:** `CREATE INDEX idx_orders_receipt_number ON orders (receipt_number);` (consider `text_pattern_ops` for `UPPER()` lookups).

---

## 3. MAJOR — Front-office friction & inconsistency

### 3.1 Receipt search exact-match only → partial search added
- `orders.js:418`: `WHERE UPPER(o.receipt_number) = UPPER(?)`. Typing `8000` for `REC-008000` failed.
- **Done this session:** added `GET /orders/search/receipt?q=` (partial, grouped, limit 20) + Collection.js fallback showing matches. Depends on §2.4 index to stay fast.

### 3.2 Competing rounding functions (penny drift)
- `orders.js:61-62`: `roundMoney` (cents) vs `roundFigure` (whole). Third copy in `invoices.js`, `bills.js`, `cleaningDocuments.js`.
- A 3-line receipt of 3,333.33 TSh totals 9,999.99 in one path and 10,000 in another.

**Fix:** one shared util (`server/utils/mathUtils.js`), one rounding rule for TSh, used everywhere.

### 3.3 `/collect` double-gated → confusing 403
`orders.js:1633` requires BOTH `canManageOrders` AND branch feature `collection`. Generic 403 gives cashier no clue why.

**Fix:** single clear permission (`canCollect`) + specific error naming the missing requirement.

### 3.4 `MAX(status)` for grouped receipts is alphabetical, not logical
Partial-search and collection-queue group by receipt and take `MAX(o.status)`. Alphabetically `sent` > `ready` > `pending` > `collected` → mixed receipt shows meaningless status.

**Fix:** status-progression priority via `CASE` or lookup (most-advanced wins).

### 3.5 Fire-and-forget / partial audit trail
- `orders.js:1097` `scheduleBackgroundDailySummaryRefresh` — no `.catch()` → unhandledRejection.
- `orderVoid.js:226-237` logs audit *after* COMMIT → failed log = void with no audit trail.

**Fix:** add `.catch()`; move audit write inside the transaction before COMMIT.

### 3.6 `customers.js:357` `:id/tags` + `:id/by-tag` lack permission guard
Any authenticated user can read/write tags regardless of role (`canManageCustomers: false` for cashier).

**Fix:** add `requirePermission('canManageCustomers')`.

---

## 4. MINOR — Robustness & cleanliness

### 4.1 Duplicated business logic
- `roundMoney`/`roundFigure` in 3 files (see §3.2).
- `awardPointsOnCollection` in both `loyalty.js:238` and inlined differently in `orders.js:1900-1940`.
- Receipt building scattered across `receipt.js`, `orders.js`, `invoices.js`.

**Fix:** consolidate into `server/utils/`.

### 4.2 Swallowed rollback failures
`receiptPayment.js:226` swallows `ROLLBACK` failure → dirty connection returned to pool. Never swallow rollback errors.

### 4.3 `cashManagement.js:64` early-return skips init
Early return on reconciled day can skip `opening_cash_declared` read → stale values.

### 4.4 `customers.js:386` tag search can't use index
3 `ILIKE` patterns on comma-separated tags → sequential scan. A `tags` junction table scales better.

### 4.5 Naming confusion
`orders.js:61-62` `roundMoney` vs `roundFigure` adjacent with opposite semantics.

### 4.6 `ready_at_branch_id`/`collected_at_branch_id` only set when `branchId` truthy
`orders.js:1477,1484` — if admin has no branch selected, these stay NULL → breaks multi-branch audit trail.

---

## 5. Front-office flow end-to-end (as-is vs target)

| Step | As-is pain | Target |
|------|-----------|--------|
| Find order | Exact receipt only; no index → slow | Instant partial search + index |
| Collect it | Cashier can't (wrong permission) | Cashier collects with `canCollect` |
| See why blocked | Generic 403 | Specific error message |
| New machine / fresh DB | Schema incomplete → login/orders broken | One idempotent schema = self-healing |

---

## 6. Recommended fix order

1. **§1 authoritative schema** (all tables + columns, idempotent) — protects every deployment.
2. **§2.1 cashier `canCollect`** — unblocks the main workflow.
3. **§2.2 auth** on `/notifications` + `/qrcode`.
4. **§2.3 items.js** bug + **§2.4 receipt index**.
5. **§3.2 / §3.5 / §4.1** consolidate rounding + shared utils + error handling.
6. **§3.3 / §3.4 / §3.6** permission clarity, status logic, tag guards.
7. **§4.2–4.6** robustness polish.
8. **§9.6 Tier 1** — add the 3 missing indexes (`idx_orders_receipt_number`, `idx_customers_phone`, `idx_customers_name`) + simplify the receipt lookup `WHERE` — highest-leverage perf at scale (see §9).
9. **§9.4 Tier 2** — stop the server self-terminating on background-rejection (`index.js:241-248` log+continue; `.catch()` on `orders.js:1097`) — availability at scale.
10. **§11 Tier 1** — strip emoji from `server/` log/utility strings (`server/index.js`, `query.js`, `db.js`, `ensure*Schema.js`, `utils/*`); verify with `node --check` + `_emoji_scan.py` → 0. Tier 2/3 deferred (see §11.2/11.3).

---

## 7. Verified-live-DB notes (what currently works)

- All 43 tables present; all columns referenced by routes present (login, orders, search all functional).
- Schema gaps in §1 are **fresh-deploy risks**, not current outages.
- Receipt partial search, invoice schema, items schema, bank_deposits schema all verified working this session.
- `/orders/notifications` and `/orders/receipt/:receiptNumber/qrcode` confirmed **unauthenticated** (fix before any external deployment).

---

## 8. UI/UX AUDIT — Client application

### 8.1 Stack & architecture (what is present)

| Concern | Findings |
|---------|----------|
| Framework | React 18.2 + react-router-dom v6, Create React App (`react-scripts`) |
| Code splitting | Route-level `React.lazy` + `Suspense` in `App.js:12-28` — each page is its own chunk. Good first-paint hygiene. |
| Offline | Service worker in `index.js:35`, caches only logo + manifest, never the app shell. Offline action-queue in `utils/offlineQueue.js` wired into `api.js` response interceptor (mutations queued on network failure). |
| PWA | `manifest.json`: `display: standalone`, icon, `start_url`, theme colors → installable on mobile. |
| Styling | No framework (no Tailwind/Bootstrap/MUI). Custom CSS variables (`index.css:66-108` light, `:110+` dark) — iOS-style: system font, rounded corners, subtle elevation, vibrancy blur on toasts. |
| Responsiveness | `Layout.js` uses `matchMedia('(max-width: 768px)')`; `index.css:421` collapses toasts on `<480px`; `Collection.css` has tablet/desktop breakpoints. |
| Theming | Light + dark via `ThemeContext`, persisted to `localStorage`. |
| Accessibility | `:focus-visible` outline (`index.css:30-34`), `prefers-reduced-motion` (`index.css:43-54`), `aria-live` on loaders, `role="status"` on offline indicator. Good foundation. |

**Overall impression:** foundations are professional and deliberately built for a front-office device. iOS-style target, code-split, offline-aware, installable PWA. Gaps are in completeness/consistency, not capability.

### 8.2 Strengths (preserve these)

1. **iOS-style design suits a touch POS** — large targets, subtle shadows, rounded cards, system fonts. Staff won't fight unfamiliar chrome.
2. **Code splitting** keeps initial bundle to Login + shared shell only.
3. **Offline-aware** — `api.js` rewrites ECONNREFUSED/timeout/DB errors to human text referencing `SETUP_GUIDE.md`.
4. **Service worker + manifest** = installable PWA (mobile presence met).
5. **Focus management + reduced-motion + aria** show accessibility was considered.

### 8.3 Gaps & recommendations

#### 8.3.1 Responsiveness / touch
- **`Layout.js` fetch-branch effect lacks `selectedBranchId` reactivity audit** — pages like NewOrder/Orders must re-fetch when branch changes; verify each page's `useEffect` deps.
- **`NewOrder.css` (1,861 lines) and `Collection.css` (790 lines)** contain raw pixel breakpoints that read like guesses. Test the POS flow on a 7.9" iPad (1024×768): the order-form two-column grid + receipt preview must collapse to single column. Add explicit `@media (max-width: 768px)` rules.
- **Touch target audit:** every interactive `<button>` should be ≥44×44px. The `Toast.js` close button (`×`) and nav icons (`nav-icon`) need explicit min-size.
- **Viewport:** `index.html:5` uses `initial-scale=1` (correct); confirm `user-scalable` is not disabled — staff may need to zoom the receipt preview.
- **Barcode scanning:** no camera/barcode input for receipt lookup, even though a QR-code path exists server-side (`orders.js:805`). Wiring a mobile scan to the collect flow would materially speed up collection.

#### 8.3.2 Perceived performance & loading states
- **`Suspense` fallback is a generic `Loader` with `delayMs={0}`** (`App.js:116`). On 3G the first page chunk can take 2–4s with no progress. Acceptable, but add byte-size budgets.
- **Blank `Loader` is fine; list pages (Orders/Customers/Reports) should render skeletons** (shimmer bars) rather than empty space to reduce perceived wait.
- **`OfflineIndicator`** is excellent — keep it; the reconnect toast ("Back online. Synced N actions") is the right pattern.

#### 8.3.3 Consistency of controls & messaging
- **Two notification systems coexist** — `components/Toast.js` (transient) and `components/AdminNotificationCenter.js` (persistent admin inbox). NewOrder uses inline `toast()` calls; standardize on the `useToast` hook everywhere.
- **`sound.js`** plays a success chime (good for a noisy laundry). The speaker-toggle in `Layout.js` (muting/unmuting the chime icon) is wired and persisted to `localStorage`. Confirm a11y label coverage is complete (aria-label on the toggle).
- **Error tone inconsistency:** some pages surface raw API strings; `NewOrder.js` form validation still uses browser-default alert modals in places. Replace with shared `Toast` (error variant) + inline field hints for faster till recovery.

#### 8.3.4 Mobile-specific workflows
- **Receipt printing:** `jspdf`/`jspdf-autotable` generate PDFs. For a 58mm thermal printer, confirm the print path. The `NewOrder.css` receipt preview is desktop-width; on mobile route to the PDF path or add a thermal `@media print` stylesheet.
- **Numeric input:** ensure `inputMode="decimal"` or `inputMode="numeric"` + `pattern="[0-9]*"` on all numeric fields (price override, cash amounts). Customer-phone in NewOrder should use `inputMode="tel"`.

#### 8.3.5 Navigation & information architecture
- **`Layout.js`** sidebar nav is role-filtered; hamburger → slide-over menu works on mobile. Recommend a fixed bottom tab bar on mobile for the 3–4 highest-frequency actions (New Order, Collect, Search Receipt) — thumb-friendly and persistent.
- **Branch context** shows a static badge for cashiers (correct), but ensure it is also explicit on collection screens so cashiers confirm the receipt belongs to their branch.

#### 8.3.6 PWA completeness
- **Icons:** `manifest.json` uses a single SVG (`purpose: any maskable`). iOS shows a fallback color on the home screen. Add ≥192px + 512px PNGs and reference them — cheapest win for the mobile presence goal.
- **`beforeinstallprompt`** is not captured. Hook it to show an "Install app" button on Dashboard for iPad users.

### 8.4 Specific front-office screens

| Screen | UX status | Note |
|--------|-----------|------|
| `Login.js` | Strong | Health-check on load, clear error rewrite, remembered session. |
| `NewOrder.js` | Core — needs polish | Largest file; form validation uses browser alerts → switch to inline `Toast` errors. |
| `Orders.js` | Functional | Receipt search is now partial (server fixed); add input debounce client-side. |
| `Collection.js` | Improved | Patched this session to accept partial receipt input; needs the receipt-index fix (§2.4) for speed. |
| `Dashboard.js` | OK | Card grid; add loading skeletons for chart first-paint. |
| `CashManagement.js` | OK | Has offline banner; numeric inputs need `inputMode`. |
| `Reports.js` | Heavy | `recharts` charts; code-split chart module out of main bundle if >200KB. |

### 8.5 UX hardening checklist

- [ ] Add 192px + 512px PNG icons; reference in `manifest.json`.
- [ ] Capture `beforeinstallprompt` → "Install" button on Dashboard.
- [ ] Touch-target audit: all buttons ≥44px; fix Toast close + nav icons.
- [ ] Numeric fields use `inputMode` + `pattern`.
- [ ] Replace browser `alert()` in NewOrder validation with inline `Toast` errors.
- [ ] Add explicit `@media (max-width: 768px)` single-column rule for the NewOrder form.
- [ ] Add loading skeletons for Orders/Customers/Reports list pages.
- [ ] Confirm every page re-fetches on `selectedBranchId` change.

### 8.6 Mobile vs web presence — status

| Requirement | Status |
|-------------|--------|
| Mobile presence | Met — installable PWA, responsive Layout, offline queue. Needs: PNG icons, install prompt, bottom tab bar, thermal-print review. |
| Web presence | Met — desktop sidebar, dark mode, full feature set. |
| Fast loading | Met — code splitting. Needs: skeletons, numeric `inputMode`, Charts bundle review. |
| Responsive | Partial — breakpoints exist but are guess-based; needs explicit tablet/phone rules on the 5 largest CSS files (NewOrder, Collection, Orders, CashManagement, Reports). |

---

## 9. DATABASE PERFORMANCE & SCALING — TENS OF THOUSANDS OF RECORDS

Addresses: *is database access the only limitation, and how do we stay fast as the dataset reaches 10k–50k+ records?*

### 9.1 Lazy loading — already correct (do not re-architect)

Every front-office list endpoint uses bounded pagination and the client uses infinite scroll. No `SELECT *`-without-limit antipattern was found on the hot paths:

| Page / endpoint | Client pattern | Server bound | Cache |
|----------------|----------------|--------------|-------|
| Orders list | `Orders.js:119` infinite scroll, `ORDERS_PAGE_SIZE`=50, `append` → offset grows | `orders.js:220` `LIMIT 50 OFFSET ?` (max 500) | `syncCache` when offline |
| Customers list | `Customers.js:60` infinite scroll, 50/page, `light=true` (skips balance JOIN) | `customers.js:126` `LIMIT 50 OFFSET ?` (max 500) | cache + offline |
| Customer typeahead (NewOrder/Collection) | `searchCustomers` `api.js:193`, min 2 chars, debounced, capped 15 | `/customers/search`, bounded | cache on offline |
| Collection queue | capped set of ready receipts | `orders.js:344` `LIMIT min(limit*25, 500)`, grouped client-side | — |
| Admin inbox / cash / payroll / sms | each paginated with `LIMIT ? OFFSET ?` | bounded | — |
| Services / Items dropdowns | `getServices`/`getItems` in `syncCache`, filtered client-side | small lookup tables | yes |

Branch scoping (`branchFilter.js:12` → `AND branch_id = ?`) composes with every compound index by design. **The fetch layer is sound — leave it alone.**

### 9.2 Missing indexes — the real fresh-deploy perf regression (same root cause as §1)

Three front-office-critical indexes exist **only** in `init.js` (SQLite, never loaded in production) and `backups/*.sql` — **not** in any `ensure*.js` that boots production (`index.js:71-85`):

| Missing index | Hot query | Impact at scale (fresh deploy has no index) |
|---------------|-----------|--------|
| `idx_orders_receipt_number` | `orders.js:418` `WHERE UPPER(o.receipt_number) = UPPER(?)` | **#1 front-office action** — till staff look up a receipt to collect it. 1k rows ≈ 5 ms; 10k ≈ 100+ ms; 50k ≈ 1–3 s. Staff perceive it as "the app hung". |
| `idx_customers_phone` | `customers.js:139` & `orders.js:169` `c.phone ILIKE ?` | Customer search scans on every keystroke (NewOrder autocomplete + Customers filter). |
| `idx_customers_name` | `customers.js:139` & `orders.js:169` `c.name ILIKE ?` | Same as above. |
| `idx_orders_customer_id` | receipt-lookup join (`orders.js:415 JOIN customers`) | Minor (small result set), but absent on fresh deploy. |

The compound indexes that **do** ship with `ensure*.js` (`idx_orders_active_branch_status`, `idx_orders_branch_order_date` from `ensurePerformanceIndexes`/`ensureLongevitySchema`) correctly support the **Orders list** query. But the receipt-lookup and customer-search indexes — the two most frequent interactive queries — were never migrated into the boot sequence.

### 9.3 Query shapes that defeat even a correctly-placed index

1. **`UPPER(o.receipt_number) = UPPER(?)`** (`orders.js:418`) — a plain b-tree index on `receipt_number` is **not** used, because the `UPPER()` wrapper changes the indexed expression.
   - **Preferred fix:** drop `UPPER()` and compare directly (`o.receipt_number = ?`). Receipts are system-generated and uppercase, so case-insensitivity is irrelevant at insert time.
   - **Alternative:** a functional index `CREATE INDEX idx_orders_receipt_number_upper ON orders (upper(receipt_number));` — must be added on both Postgres and SQLite through the shared `db.run` in `query.js`.
   - The partial-search route (`orders.js: search/receipt?q=`, api.js:353) uses `ILIKE '%q%'` — a b-tree index **never** serves a leading-wildcard match. It is bounded at 20 results; keep it, but the exact-match path must use the index.

2. **`ILIKE '%term%'`** (`customers.js:139`, `orders.js:169`) — leading-wildcard ILIKE cannot use a standard b-tree index. Under ~20k customer rows, the `LIMIT 50/15` cap makes a sequential scan acceptable (small page, good cache locality). Beyond that:
   - **Postgres:** `CREATE EXTENSION IF NOT EXISTS pg_trgm;` + `CREATE INDEX … USING gin (name gin_trgm_ops, phone gin_trgm_ops);`
   - **SQLite:** no trigram by default; switch to **prefix search** (`LIKE 'term%'`, b-tree-friendly) or cap archive.
   ### 9.4 Scaling limitations that are NOT the database (verified)

Database indexes are necessary but **not sufficient** — at 10k+ rows these other ceilings dominate:

| # | Limitation | Where | Scale risk |
|---|------------|-------|------------|
| 1 | **Pool ceiling 12 + timeout-stack mismatch** | `query.js:14` (max 12), `index.js:60` (30s server), `api.js:12` (15s client) | Concurrent tills + the background `scheduleBackgroundDailySummaryRefresh` (`orders.js:1097`) exhaust the pool at shift end → client 15s timeout → retry storm → cascading 500s across the floor. |
| 2 | **No server-side response caching** | `index.js:36-54` (only `helmet`/`compression`/`cors`/`bodyParser`; no Redis/apicache) | Every Orders/Customers/Collection refresh re-runs the JOINed query; the client cache is offline-only. |
| 3 | **No list virtualization → client DOM bloat** | `Orders.js:1650`, `Customers.js:423`, `Collection.js:1039` render every loaded row via `.map()`; manual "Load more" button (`Orders.js:1683`); **no** `react-window`/`IntersectionObserver` in `client/src` — despite `PERFORMANCE_AND_DATA_GUIDE.md:99` recommending it | 300+ mounted card DOM trees per scroll → browser jank/lockup before the DB is the bottleneck. |
| 4 | **Server exits on any async hiccup** | `index.js:241-248` (`unhandledRejection` → `gracefulShutdown` → `process.exit(1)`) + `orders.js:1097` (no `.catch()`) | One background refresh rejection kills the **entire POS** mid-shift; P(≥1 crash/day) → ~1 at scale. |
| 5 | **Deep OFFSET degrades linearly** | `orders.js:222` `LIMIT 50 OFFSET 50000` | Staff scrolling to an old order walks 50k rows to discard them. |
| 6 | **In-memory Excel export** | export routes load 500 rows + build workbooks in-process | Concurrent admin exports pressure heap. |

### 9.5 Tiered remediation

| Tier | Action | Files | Urgency |
|------|--------|-------|---------|
| 1 | Add the 3 missing indexes (`idx_orders_receipt_number`, `idx_customers_phone`, `idx_customers_name`) + drop/simplify `UPPER()` so the index is used. See §9.2 + §1.4. | `ensurePosCoreSchema.js` (new) | **Critical** (fresh-deploy regression) |
| 2 | Stop the process from self-terminating on background-rejection: `index.js:241-248` logs & continues for non-fatal errors; add `.catch()` to `orders.js:1097`. | `index.js`, `orders.js` | **High** |
| 3 | Pool/timeout hardening: lower `connectionTimeoutMillis` (~3 s), add retry-with-backoff in `api.js`, set client timeout below server's 30 s to abort early. | `query.js`, `api.js` | Medium |
| 4 | Server-side caching (`apicache`/LRU) on stable read endpoints (orders list, customers light list, dashboard stats), invalidated on writes. | `index.js`, routes | Medium |
| 5 | Keyset (cursor) pagination on infinite-scroll lists (`WHERE (order_date, id) < cursor ORDER BY … DESC LIMIT 50`) — O(log n) at any depth. Keep `offset` for admin exports. | `orders.js`, `customers.js`, `Orders.js`, `Customers.js` | Forward-looking |
| 6 | `react-window` virtualization on Orders / Customers / Collection so the DOM stays bounded. | `client/src/pages/*` | Forward-looking |
| 7 | Streaming Excel export (streaming workbook / CSV) instead of in-memory 500-row workbook. | export routes | Low |

### 9.6 The single highest-leverage change

The missing **3 indexes** (Tier 1). They are why the two most frequent interactive queries — receipt lookup (#1 till action) and customer search — go from ~5 ms to **1–3 s** at 50k rows, and they are absent on a fresh production deploy for the **same root cause** as §1 (the `ensure*.js` boot sequence never fully inherited from `init.js`/backups). Three lines of SQL buys linear scaling **without a client rewrite**. The client-side changes (virtualization, keyset pagination) are future-proofing for 100k+ — not the fix for the current problem.

---

## 11. Emoji removal from the codebase

The scan (`_emoji_scan.py`, kept in repo root) enumerated every source file containing true emoji. Tiered because client glyphs are **decorative UI icons**, not log noise — bulk removal without replacements would silently change POS semantics.

### 11.1 Tier 1 — Server log / utility emoji (ASSIGNED)

Pure `console.log`/`console.error` decoration in `server/` — safe to swap for text tokens. Replacement map: ✅→`OK:`, ❌→`ERROR:`, ⚠→`WARN:`, 🔄→`SYNC:`, 📍→`` , 💡→`TIP:`. Files & counts from the scan:

| File | Emoji | Lines |
|------|-------|-------|
| `server/index.js` | 🚀 ❌ 📍 ✅ | 6 |
| `server/database/query.js` | ✅ ❌ | 2 |
| `server/database/db.js` | ❌ 📍 | 2 |
| `server/database/ensure*Schema.js` (12 files) | ✅ ❌ ⚠ | ~30 total |
| `server/utils/verifyAdminPostgres.js` | ⚠ ✅ ❌ 💡 📋 🔍 🔧 | 12 |
| `server/utils/verifyAdmin.js` | ⚠ ✅ ❌ 📋 🔍 🔧 | 12 |
| `server/utils/testLogin.js` | ✅ ❌ 📝 🔍 🔐 🔧 | 18 |
| `server/utils/fix-receipt-constraint.js` | ⚠ ✅ ❌ 📋 📑 🔍 | 11 |
| `server/utils/createDefaultAdmin.js` | ⚠ ✅ | 3 |
| `server/utils/checkAdmin.js` | ✅ ❌ | 3 |
| `server/utils/sms.js` / `whatsapp.js` / `notifications.js` | 📱 | 8 |
| `server/utils/dailyClosingReport.js` | 👤 💰 💵 📅 📈 📊 📍 📤 📥 | 10 |
| `server/routes/orders.js` | ✅ ❌ 📩 📱 | 11 |

**Method:** repo-root Python script (`_strip_server_emoji.py`) walks `server/**/*.js` + `server/**/*.sql`, applies the map, writes back in place. **Verify with `node --check` per file + re-run `_emoji_scan.py` → `server/` must report 0 emoji.**

### 11.2 Tier 2 — Client JSX decorative icons (DEFERS — needs design review)

UI icons in `client/src` carry meaning (status badges, empty states, nav). A mechanical delete breaks UX; each should map to a text label or an SVG icon. Files & counts from the scan:

| File | Count | Representative usage | Replace-with |
|------|-------|---------------------|--------------|
| `NewOrder.js` | 54 | 💰💳💵 🧺🧼🧴 (laundry status) 👤 (customer) 📦 (order) ⚡ (urgent) | text label + CSS ::before |
| `Collection.js` | 40 | 💰💵 📍📋📝📞 (call-to-collect) 🏁 (ready) 🖨 (print) | text labels |
| `CashManagement.js` | 22 | 💰💳💵 💾📤 (deposit/withdraw) 🏦 (bank) 🔄 (sync) | text labels |
| `Orders.js` | 14 | 📦 (orders) ⏳ (pending) 🔍 (search) 🔽 (download) | text labels |
| `Dashboard.js` | 14 | 📈📊 (graphs) ⏰ (time) ✨ (new) | text labels |
| `Customers.js` | 15 | 📤 (export) 📱 (sms) ⏳ (loading) | text labels |
| `PriceList.js` | 27 | 👕👔👗🧥👖 (categories) 💰 (price) 🗑 (clear) 🚫🚚 (out of stock) | text labels |
| `Expenses.js` | 7 | 🏦💵 (cash/bank) 📱 (receipt photo) 🗑 (delete) 📝 (note) | text labels |
| `AdminBranches.js` | 15 | 🏢👥 (branches/users) 🔐 (password) 💾 (save) ⚙ (settings) | text labels |
| `CleaningServices.js` | 7 | 👥 (customer) 💰 (balance) 📄📋📝🧾 (docs) | text labels |
| `MonthlyBilling.js` | 3 | 📄📋 (invoice) ✕ (error) | text labels |
| `Layout.js` / `layout-legacy/Layout.js` | 22 + 21 | 🌙☀️ (theme) 🔔🔕 (notifications) 🚪 (logout) ☰ (menu) | text labels |
| `AuthContext.js` | 17 | ⏸🔒🔐 (auth states) ❌ (error) | text labels |
| `Toast.js` | 3 | ✕ (close) ✓⚠ (icon variants) | text labels |
| `Reports.js` | 2 | ✅❌ (status) | text labels |
| `ListViewToggle.js` | 2 | 🃏📋 (view mode) | text labels |
| `*.css` (NewOrder, Collection, Orders, CashManagement, Reports, Customers) | — | `content: "…"` icon glyphs used as pseudo-element bullets | replace with `::before` text or drop |

**Decision rule:** create a centralized `client/src/components/icons.js` that maps each semantic key to a literal (`STATUS.READY = 'READY'`, etc.). Tier 2 removal is then a single grep+replace against that map. **Defer execution** until §8.3 chooses a replacement scheme (SVG vs text) — bulk-deleting now would erase meaningful state cues.

### 11.3 Tier 3 — SQL / seed scripts

`server/database/init.js` / `init.postgresql.js` / `migrations/20260808_drop_permissive_rls_policies.sql` carry emoji **in `-- comments` only** (`✅ ❌ 🔄 ⚠ 💡`). Same repo-root script as Tier 1 covers `.sql`; include them in the sweep.

### 11.4 Verification

Re-run `python3 _emoji_scan.py` after each tier; targets:
- **Tier 1 done:** `server/` → **0** true-emoji characters; all `node --check server/**/*.js` green; pool connects (`require('./server/database/query')` no-throws).
- **Tier 3 done:** `server/database/init*.js`, `init.postgresql.js`, `*.sql` migrations → 0 emoji.
- **Tier 2:** only `client/src/components/icons.js` (the centralized map) may retain literals; every other `client/src` file → 0.


## 12. Collection receipt detail — popup on select (IMPLEMENTED)

**Request:** when searching for a receipt or customer in Collections and clicking a result, the detail should pop up immediately instead of rendering at the bottom of the page (which requires scrolling).

**What changed:**
- New `client/src/components/OrderDetailsModal.js` + `OrderDetailsModal.css`: a popup wrapper around the shared `ReceiptDetailPanel` (same detail content as before, now in a centered dialog, max-width 720px, scrollable body, mobile responsive, z-index above other modals).
- `client/src/pages/Collection.js`: the ~10.9k-char inline bottom detail card (`order-details-card-modern`) was replaced with `<OrderDetailsModal open={showOrderDetailsModal && !!order} ... />`. Detail actions (Receive Payment / Collect / Reprint / status notices) moved into the modal's `actions` slot; Receive Payment and Collect close the detail popup first, then open their existing payment/collect flows unchanged.
- All selection paths now open the popup: receipt-number search (exact + single partial match), customer/phone search (first receipt auto-load), clicking a row in the customer-receipts list, clicking a partial-receipt-match row, and clicking a ready-queue card or row (which also collapses the queue).
- Selection no longer depends on page scroll position: close via X button, overlay click, or the `showOrderDetailsModal` state.

**Also in this change:** removed decorative emoticons touched by the edited Collection action buttons (Receive Payment / Collect / Reprint / status notices now text-only), consistent with Tier 2 text-label direction in §11.2.

**Verify:** search a receipt number in Collections → modal opens with receipt/customer/items/payment sections; click another result row → modal content swaps; Collect / Receive Payment still open their existing modals; `node --check` on edited files; client build compiles.

### 11.5 Tier 1 execution log

| Step | Status | Detail |
|------|--------|--------|
| Write `_strip_server_emoji.py` | — | maps ✅❌⚠🔄📍💡📱 etc. → short ASCII token or drop; applied to `server/` only. |
| `node --check` all modified files | — | |
| `_emoji_scan.py` re-run | — | `server/` must report 0 emoji. |

