# SUPACLEAN POS — Deployment readiness

## ✅ Ready for deployment (with a few checks)

The app is in good shape to deploy. Use this list before and during go-live.

---

## Before you deploy

### 1. Environment
- [ ] **`DATABASE_URL`** — PostgreSQL connection string set in production (e.g. on your server or host).
- [ ] **`NODE_ENV=production`** — Set when running the server so it serves the built client and uses production behavior.
- [ ] **`CLIENT_URL`** — Set to your frontend/public URL (e.g. `https://pos.yourdomain.com`) so CORS allows the real origin.
- [ ] **`.env`** — Not committed; only on the server. No secrets in code.

### 2. Database
- [ ] Run pre-launch DB (works for **PostgreSQL** and **SQLite**):
  ```bash
  npm run pre-launch-db
  ```
  With `DATABASE_URL` set: runs PostgreSQL migrations. Without: runs SQLite migrations on `database/supaclean.db`. Creates `order_item_photos` and multi-branch indexes.

### 3. Build and run
- [ ] **Build client:**  
  `npm run build` (builds `client/build/`).
- [ ] **Run server in production:**  
  `NODE_ENV=production node server/index.js` or use your `server:prod` script.  
  The server will serve the built React app from `client/build` and handle SPA routing.

### 4. Security (important)
- [ ] **Change default admin password** — The setup guide mentions `admin` / `admin123`. Change this after first login on production.
- [ ] **HTTPS** — Use HTTPS in production (reverse proxy e.g. Nginx, or host that provides SSL).
- [ ] **Uploads folder** — Ensure `uploads/` (item photos) exists and is writable; the server serves it at `/uploads`.

### 5. Optional
- [ ] **SMS (Africa's Talking, etc.)** — If you use ready-for-collection SMS, set the SMS env vars in production.
- [ ] **Receipt QR (Terms link)** — Set `REACT_APP_PUBLIC_ORIGIN` (or equivalent) to your public URL before building so receipt QR codes point to the right domain (see SETUP_GUIDE.md).

---

## What’s already in place

| Item | Status |
|------|--------|
| Production server | Express serves `client/build` when `NODE_ENV=production` and SPA fallback for client routes |
| Health check | `GET /api/health` for monitoring |
| Multi-branch, pagination, reports toasts | Done (see PRE_LAUNCH_CHECKLIST.md) |
| Today’s income from payments | Fixed (payment_received included) |
| Offline/online (login + cache + sync) | Implemented |
| Order item photos API | Implemented; run SQL and have `uploads/` writable |

---

## Quick production run (single server)

```bash
# On the server (after cloning and installing)
npm run install-all
npm run build
# Set DATABASE_URL, NODE_ENV=production, CLIENT_URL, then:
NODE_ENV=production node server/index.js
# Or: npm run server:prod (ensure NODE_ENV is set)
```

Then open your server URL (e.g. `https://your-server:5000` if you use the same port, or the URL your reverse proxy uses). The app is single-page; the server serves the same `index.html` for all routes.

---

## After deployment

1. Log in with admin, change password, then do the **Quick regression checks** in PRE_LAUNCH_CHECKLIST.md §4.3.
2. Create branches and branch users (Admin → Branches). Use the **Branch** dropdown in the sidebar (admin only) to filter Orders by branch or to create orders for a selected branch.
3. Optionally run through OFFLINE_AND_ONLINE.md for offline/sync behavior on devices.

You’re ready for deployment once the “Before you deploy” items are done and you’ve run a quick smoke test after go-live.
