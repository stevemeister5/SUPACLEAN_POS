# SUPACLEAN POS — Pre‑launch checklist

Use this before going live next week. It covers **major implementation risks**, **what’s done**, **what’s left**, and **how to run** (including thermal POS photos and multi‑branch scale).

---

## 1. Major issues (fixed or mitigated)

### 1.1 Customers API branch params bug — **FIXED**
- **Issue:** Branch filter was used twice (JOIN + CASE) but `branchId` was only passed once → wrong results or SQL errors.
- **Change:** `server/routes/customers.js` now passes branch params twice when filtering by branch.

### 1.2 No pagination on orders/customers — **FIXED**
- **Issue:** With many branches and rows, loading all orders/customers could time out or be slow.
- **Change:** Orders and customers APIs support `limit` (default 200, max 500), `offset`, and `page`. Use `?limit=200&page=1` (or offset) when calling from the UI.

### 1.3 Reports using `alert()` — **FIXED**
- **Change:** Reports use `useToast` and `showToast` instead of `alert` for errors.

### 1.4 Order item photos (thermal POS) — **ADDED**
- **New:** `order_item_photos` table, upload API, and static serving for uploads.
- **Run:** `scripts/add-order-item-photos.sql` on your Postgres DB.
- **API:** `GET /api/order-item-photos?order_id=X`, `POST /api/order-item-photos/upload` (form: `order_id`, `photo` file, optional `caption`). Photos stored under `uploads/item-photos/`, served at `/uploads/`.

---

## 2. Multi‑branch and scale

### 2.1 Ready for large, per‑branch data
- **Orders:** `branch_id` (and related branch columns) used; list/collect/receive-payment are branch‑scoped.
- **Customers:** Shared globally; outstanding balance is computed per branch via orders.
- **Transactions, expenses, cash management:** Use `branch_id` where needed.
- **Indexes:** Run `scripts/indexes-multi-branch-scale.sql` for better performance with many branches and rows.

### 2.2 Optional: customer list per branch
- Today, customers are global. If you want “customers who have orders at this branch” only, you’d add branch‑scoped customer filtering (e.g. via `orders.branch_id`). Not required for launch.

### 2.3 Table layout
- Core tables already use `branch_id` appropriately (`orders`, `transactions`, `expenses`, `daily_cash_summaries`, etc.).
- `order_item_photos` includes `branch_id` for branch‑scoped access.
- Run `add-order-item-photos.sql` and `indexes-multi-branch-scale.sql` so DB and indexes match.

---

## 3. Thermal POS and item photos

### 3.1 Backend (done)
- Table: `order_item_photos` (see script).
- Upload: `POST /api/order-item-photos/upload` with `order_id` + `photo` file (+ optional `caption`).
- List: `GET /api/order-item-photos?order_id=...`.
- Files served at `/uploads/` (e.g. `/uploads/item-photos/...`).

### 3.2 Frontend (to do)
- **New Order:** Optional “Take photo” / “Attach photo” per cart line; after order create, call `uploadOrderItemPhoto(orderId, file, caption)` for the corresponding order line.
- **Orders / Collection:** Optional “Add photo” for an order; same upload API.
- **Thermal POS:** Use device camera or file picker, then send the file via the upload API. No backend changes needed.

### 3.3 Run before using photos
```bash
npm run pre-launch-db
# or: psql $DATABASE_URL -f scripts/add-order-item-photos.sql
```

---

## 4. UI stabilisation (debug & polish)

### 4.1 Done
- Reports: toast instead of `alert`, `ToastContainer` in Reports page.
- Orders/customers: pagination on API; UI can pass `limit`/`page` when loading lists.

### 4.2 Recommended before launch
1. **Loading states:** Ensure Orders, Customers, Collection, Dashboard, Reports show a clear loading state (e.g. spinner/skeleton) while fetching.
2. **Empty states:** Friendly messages when no orders, no customers, no queue, etc.
3. **Error handling:** All list/fetch actions use `showToast` (or equivalent) on failure; no silent failures.
4. **Pagination in UI:**  
   - Orders: “Load more” or page buttons using `limit` + `offset`/`page`.  
   - Customers: same if you expect large lists.
5. **Forms:** Disable submit while saving; show success/error toasts.
6. **Collection / New Order:** Double‑check receipt lookup, payment flow, and receive‑payment with the updated APIs.

### 4.3 Quick regression checks
- [ ] Login (admin + branch user).
- [ ] New order → add items → create → receipt.
- [ ] Orders list → filters → status updates → “Receive payment”.
- [ ] Collection: search by receipt → collect with/without payment.
- [ ] Dashboard: ready queue, today’s stats.
- [ ] Reports: overview, financial, etc.; no `alert`, errors as toasts.
- [ ] Cash management: today, reconcile (if used).

---

## 5. What to run before go‑live

### 5.1 Database
**Option A — npm script (recommended):**
```bash
npm run pre-launch-db
```
Runs `add-order-item-photos.sql` and `indexes-multi-branch-scale.sql` via Node + `DATABASE_URL` from `.env`.

**Option B — psql:**
```bash
psql $DATABASE_URL -f scripts/add-order-item-photos.sql
psql $DATABASE_URL -f scripts/indexes-multi-branch-scale.sql
```

### 5.2 App
```bash
npm run install-all
npm run dev
```
- Backend: `http://localhost:5000`
- Frontend: `http://localhost:3000`
- Health: `GET /api/health`

### 5.3 Env
- `DATABASE_URL` for Postgres.
- Optional: SMS env vars (Africa’s Talking, etc.) for ready‑for‑collection notifications.

---

## 6. Summary

| Area | Status | Action |
|------|--------|--------|
| Customers branch params | Fixed | Deploy updated `customers` route |
| Orders/customers pagination | Added | Use `limit`/`page` in UI where needed |
| Reports toasts | Fixed | Deploy updated Reports page |
| Order item photos API | Added | Run `add-order-item-photos.sql`, mount uploads |
| Multi‑branch indexes | Script added | Run `indexes-multi-branch-scale.sql` |
| Thermal POS photos UI | Pending | Add camera/file upload in New Order & Orders/Collection |
| UI loading/empty/error | Partially done | Harden lists and forms as in §4.2 |

---

## 7. Execution order for “go live next week”

1. Run the two SQL scripts above on your Postgres DB.
2. Deploy backend + frontend (including customers fix, orders/customers pagination, Reports toasts, order‑item‑photos route).
3. Verify branch‑scoped flows (branch user vs admin) and collection/receive‑payment.
4. Add UI pagination for Orders (and optionally Customers) if you expect large datasets.
5. Add “Attach photo” / “Take photo” in New Order and Orders/Collection, calling the new upload API.
6. Do a final UI pass: loading states, empty states, and error toasts everywhere critical.

After that, you’re in good shape to run multiple branches, large data, and thermal POS photo uploads.

---

## 8. Go‑live execution log

| Step | Command / action | Status |
|------|------------------|--------|
| 1. Pre‑launch DB | `npm run pre-launch-db` | ✅ Done (order_item_photos + indexes) |
| 2. Backend | ` ` | ✅ Health `GET /api/health` OK |
| 3. Order‑item‑photos API | `GET /api/order-item-photos` (no auth) | ✅ 401 — route exists, auth required |
| 4. Client build | `npm run build` | ✅ Build succeeds |
| 5. Full stack | `npm run dev` | Run locally when ready |

**Next:** Run `npm run dev`, then work through the **Quick regression checks** in §4.3 (login, new order, collection, receive payment, dashboard, reports, cash management).
