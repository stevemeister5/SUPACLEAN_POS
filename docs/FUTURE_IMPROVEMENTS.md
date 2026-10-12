# SUPACLEAN POS — Future Improvements (Working Notes)

> Living document for ideas, debt, and roadmap items. Add anything here as we spot it;
> promote items into `TASK.md` (audit/fix work) or `docs/PRE_LAUNCH_CHECKLIST.md`
> (go-live work) when we start executing.
>
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done
> **Priority:** 🔴 high · 🟠 medium · 🟡 low
>
> Last updated: 2026-10-12

---

## 0. How this fits with existing docs

| Doc | Purpose |
|-----|---------|
| `TASK.md` | Backend/UI audit findings with verified fixes (fix order in §6) |
| `docs/PRE_LAUNCH_CHECKLIST.md` | Go-live steps and regression checks |
| `docs/DEPLOYMENT_READINESS.md` | Deploy env/security checklist |
| **This file** | Everything else — ideas, debt, features, future phases |

---

## 1. Carry-over from existing audits (verify status first)

Items already identified elsewhere that may still be open. Check `TASK.md` before re-fixing.

- [ ] 🔴 **Authoritative schema provisioning** — `TASK.md` §1: fresh deploy on empty
  PostgreSQL creates only 25 of 43 tables (missing `users`, `orders`, `customers`, …).
  Goal: one idempotent `ensurePosCoreSchema.js` covering all tables + columns.
- [ ] 🔴 **Cashier cannot collect orders** — `TASK.md` §2.1: `/collect` gated on
  `canManageOrders`. Introduce `canCollect` permission.
- [ ] 🔴 **Unauthenticated endpoints** — `TASK.md` §2.2:
  `GET /orders/notifications` and `GET /orders/receipt/:receiptNumber/qrcode` leak
  customer data. Add `authenticate` + `requireBranchAccess()`.
- [ ] 🟠 **`items.js:24` operator-precedence bug** — `TASK.md` §2.3: admins never see
  inactive items.
- [ ] 🟠 **Missing indexes** — `TASK.md` §9.6 Tier 1: `orders.receipt_number`,
  `customers.phone`, `customers.name`. Receipt lookup is the hottest POS action.
- [ ] 🟠 **Server self-termination on background rejection** — `TASK.md` §9.4:
  `server/index.js:241-248` should log+continue; add `.catch()` at `orders.js:1097`.
- [ ] 🟡 **Consolidate rounding** — `TASK.md` §3.2: `roundMoney` vs `roundFigure`
  copies in `orders.js`, `invoices.js`, `bills.js`, `cleaningDocuments.js` →
  single `server/utils/mathUtils.js`.
- [ ] 🟡 **Emoji removal Tier 2/3** — `TASK.md` §11 (Tier 1 server strings pending?).
- [ ] 🟠 **Thermal POS photo UI** — `PRE_LAUNCH_CHECKLIST.md` §3.2: "Take photo" /
  "Attach photo" per cart line in New Order & Orders/Collection (backend API exists).
- [ ] 🟡 **UI hardening pass** — `PRE_LAUNCH_CHECKLIST.md` §4.2: loading/empty/error
  states, disable-submit while saving, UI pagination for Orders/Customers.

---

## 2. Engineering quality

### 2.1 Automated testing (biggest gap) 🔴
- [ ] There are **no unit/integration tests** — only ad-hoc root scripts
  (`test-admin-login.js`, `test-api-routes.js`, …) run manually against a live server.
- [ ] Add a test runner: **Jest + Supertest** for the Express API (matches existing
  Node/Express stack; CRA's `react-scripts test` already available for client).
- [ ] First tests to write (highest regression risk):
  - [ ] Auth: login, session, permission matrix (`server/middleware/permissions.js`)
  - [ ] Order lifecycle: create → ready → collect → payment
  - [ ] Money math: `roundMoney` consistency, receipt totals
  - [ ] Receipt search (exact + partial)
  - [ ] Branch scoping / data isolation
- [ ] Client component tests for the POS critical path (New Order cart, Collection search).

### 2.2 CI/CD 🔴
- [ ] No `.github/` — add GitHub Actions: `npm install` → lint → test →
  `npm run build` on every PR.
- [ ] Add ESLint/Prettier config at repo root (client uses CRA's `react-app` config;
  server currently unlinted).
- [ ] Block commits that reintroduce removed patterns (e.g. emoji scan — see
  `_emoji_scan.py`, currently gitignored).

### 2.3 Repo hygiene 🟡
- [ ] Root has leftover one-off scripts: `_emoji_scan.py`, `_find_survivor.py`,
  `_fix_line.py`, `_strip_server_emoji.py`, `tee.env.txt`, `test-*.js` — move to
  `scripts/` or remove.
- [ ] `scripts/seed-baseline.js` is currently modified (`git status`) — decide
  commit or discard.
- [ ] `package.json` `dev`/`server` scripts call **PowerShell** `kill-ports.ps1` —
  breaks on macOS/Linux. Make cross-platform (e.g. `portfinder` or a Node script).
- [ ] Duplicate scripts: `vercel-build` and `build:vercel` are identical.
- [ ] `moment` is in dependencies — it's legacy; consider `date-fns`/`dayjs` when
  touching date code (not urgent).
- [ ] `sqlite3` still a dependency alongside `pg` — decide whether SQLite remains a
  supported target (see §6) and document it.

### 2.4 Documentation drift 🟡
- [ ] `README.md` is stale: says "Features in Development" and SQLite-only; actual
  app has multi-branch, loyalty, offline sync, Vercel/Neon deploy.
- [ ] `docs/DOCUMENTATION_INDEX.md` references files that don't exist in `docs/`
  (e.g. `PHASE1_CLOUD_SETUP.md`, `MIGRATION_PROGRESS.md`, `SIMPLE_INSTALL_GUIDE.md`).
  Prune or restore.
- [ ] Consolidate setup guides (`SETUP_GUIDE.md` vs `SETUP_ENV_INSTRUCTIONS.md` vs
  `INSTALL_NODEJS.md`).

---

## 3. Security 🔴

- [ ] **Verify the two unauthenticated endpoints are fixed** (§1 above) before any
  public deployment.
- [ ] **Default admin password** (`admin`/`admin123`) — force password change on
  first login, not just manually (per `DEPLOYMENT_READINESS.md` §4).
- [ ] **Rate limiting** — `express-rate-limit` is a dependency; confirm it's applied
  to login/SMS endpoints.
- [ ] **Sessions** — `express-session` + `user_sessions` table: review session
  expiry, logout-all, and cookie flags (`httpOnly`, `secure`, `sameSite`).
- [ ] **Audit logging** — `payment_audit_log` exists; consider extending to order
  edits, refunds, and permission changes.
- [ ] **File uploads** — `multer` + `/uploads/`: validate MIME types, size limits,
  randomize stored filenames (photos are user-controlled input).
- [ ] **Secrets** — `.env*` is gitignored, but keep `.env.example.vercel` the single
  source of truth for required vars; add a check for accidental secret commits
  (e.g. `gitleaks` in CI).
- [ ] **Dependency audit** — `npm audit` in CI; several deps are pinned with
  `overrides` for old vulnerabilities.

---

## 4. Performance & scale 🟠

- [ ] Missing Tier-1 indexes (see §1) — biggest win for tens of thousands of records.
- [ ] Confirm UI passes `limit`/`page` everywhere the API supports it
  (Orders/Customers default 200, max 500).
- [ ] Receipt lookup `WHERE` simplification (`TASK.md` §9) + `text_pattern_ops`
  index if using `UPPER()` comparisons.
- [ ] Consider query result caching for dashboard/reports hot paths.
- [ ] Load testing exists (`k6` scenarios in `package.json`: smoke/read/write/
  spike/soak) — but `load-testing/` is gitignored. Restore it to the repo and wire
  a scheduled run.
- [ ] Review `MAX(status)` grouping logic for multi-item receipts (`TASK.md` §3.4)
  — status should be ordered logically, not alphabetically.

---

## 5. Product features 🟢

Ideas already floating (README "in development" + design docs):

- [ ] **Multi-language (English/Swahili)** — big for Arusha front-office staff.
  Plan: centralize all UI strings first (i18next), then translate.
- [ ] **Inventory / consumables** — detergent, packaging stock linked to orders.
- [ ] **Staff management & payroll** — `payroll.js` route exists; what's its status?
  Map against README's "staff management" promise.
- [ ] **Online payments** — mobile money (M-Pesa / Airtel Money / Tigo Pesa) for
  Tanzanian customers; invoicing docs already exist (`MONTHLY_BILLING_DESIGN.md`).
- [ ] **Loyalty program** — tables + `loyalty.js` exist (`docs/LOYALTY_PROGRAM.md`);
  confirm UI is complete.
- [ ] **Monthly billing** — design doc exists (`docs/MONTHLY_BILLING_DESIGN.md`);
  confirm implementation status.
- [ ] **SMS marketing** — `adminSmsMarketing.js` route exists; review opt-in/opt-out
  compliance and cost controls.
- [ ] **WhatsApp notifications** — popular in TZ; alternative/supplement to SMS.
- [ ] **Receipt thermal-printer profiles** — 58mm/80mm paper presets.
- [ ] **Item photos in collection flow** — show attached photos when handing over
  (photos API already exists).
- [ ] **Analytics upgrades** — peak-hours heatmap, per-service profitability,
  customer retention (recharts already in client).

---

## 6. Architecture & deployment 🟠

- [ ] **Dual database story** — SQLite (local dev, `database/supaclean.db`) vs
  PostgreSQL/Neon (Vercel). Two provisioning paths (`init.js` SQLite-only vs
  `ensure*.js`). Decide the supported matrix and make one idempotent migration
  path work for both.
- [ ] **Vercel serverless vs single server** — recent commits show repeated fixes
  for serverless (tmp uploads, sqlite3 native crash, hanging API). Decide long-term:
  - Serverless (Vercel + Neon): zero ops, but file uploads and background jobs are
    awkward (multer → `/tmp`, no cron).
  - Single server (Render/`render.yaml` exists) or VPS + PM2 + Nginx: uploads,
    websockets, cron all simple.
  Document the winner in `DEPLOYMENT_READINESS.md`.
- [ ] **Background jobs** — SMS sending, daily summaries: move to a proper queue or
  scheduled job instead of fire-and-forget promises (`TASK.md` §9.4).
- [ ] **Offline sync** — implemented (`docs/OFFLINE_AND_ONLINE.md`); needs conflict
  resolution notes + tests (what happens if two devices edit the same order?).
- [ ] **Real-time updates** — ready-queue/dashboard currently manual refresh?
  Consider polling-with-backoff or SSE/WebSocket.
- [ ] **Backup strategy** — `backups/` is gitignored; add automated DB backups
  (Neon has PITR; SQLite needs a cron dump script).
- [ ] **Monitoring** — `/api/health` exists; add error tracking (Sentry) and basic
  uptime checks.

---

## 7. Suggested priority order (next session)

1. Verify/close the 🔴 items from §1 (schema, `canCollect`, unauthenticated endpoints).
2. Stand up a minimal test suite + CI (§2.1–2.2) so refactors are safe.
3. Add Tier-1 indexes (§4).
4. Decide deployment target (§6) — it constrains uploads, SMS, and backups.
5. Then pick product features (§5) based on business need.

