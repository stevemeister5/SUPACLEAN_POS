# Deploy SUPACLEAN POS on Render – Step by Step

Follow these steps in order. At each **👉 YOU DO** step, do the action, then we can move to the next. If anything fails, tell me the step number and the error or screenshot.

---

## Before you start

- [ ] Your code is in a **Git** repo (GitHub or GitLab).
- [ ] You have a **Supabase** project with the database set up (your app uses PostgreSQL via `DATABASE_URL`).
- [ ] You have your **Supabase connection string** (URI) ready.  
  Get it: Supabase Dashboard → **Project Settings** → **Database** → **Connection string** (URI). Use the one that includes your password, or the **Connection pooling** URI (often port **6543**) if shown.

---

## Step 1: Push your code to GitHub/GitLab

**👉 YOU DO**

1. Open a terminal in your project folder.
2. Run:
   ```bash
   git status
   ```
3. If you have uncommitted changes:
   ```bash
   git add .
   git commit -m "Prepare for Render deployment"
   ```
4. Push to your remote (use your branch name if it’s not `main`):
   ```bash
   git push origin main
   ```
   (Or `git push origin master` if your default branch is `master`.)

**When you’re done:** Reply with: **“Step 1 done – code is pushed”** (or say if you had an error).

---

## Step 2: Create a Render account and connect the repo

**👉 YOU DO**

1. Go to **https://render.com** and sign up or log in (GitHub/GitLab login is fine).
2. In the dashboard, click **New +** → **Web Service**.
3. Connect your **GitHub** or **GitLab** account if asked.
4. Find and select the repository that contains **SUPACLEAN POS** (the one you pushed in Step 1).
5. Click **Connect** (or **Connect repository**).

**When you’re done:** Reply with: **“Step 2 done – repo connected”** (or the exact error message if something failed).

---

## Step 3: Configure the Web Service (name, region, runtime)

**👉 YOU DO**

On the “Create Web Service” page, set:

| Field | Value to enter |
|--------|-----------------|
| **Name** | `supaclean-pos` (or any name you like) |
| **Region** | Choose the closest to you (e.g. **Frankfurt** or **Oregon**) |
| **Branch** | `main` (or your default branch) |
| **Runtime** | **Node** |

Do **not** click **Create Web Service** yet. We’ll set Build & Start commands and env vars in the next steps.

**When you’re done:** Reply with: **“Step 3 done – name/region/runtime set”**.

---

## Step 4: Set Build and Start commands

**👉 YOU DO**

On the same page, find **Build & Deploy** (or **Build Command** / **Start Command**):

1. **Build Command** – set to exactly:
   ```bash
   npm run build:render
   ```
2. **Start Command** – set to exactly:
   ```bash
   npm run server:prod
   ```

(If Render shows a default like `npm install`, replace the build command with the line above. Start command must be exactly `npm run server:prod`.)

**When you’re done:** Reply with: **“Step 4 done – build and start commands set”**.

---

## Step 5: Add environment variables (do not deploy yet)

**👉 YOU DO**

1. On the same “Create Web Service” page, find **Environment** or **Environment Variables**.
2. Add these variables **one by one** (use **Add Environment Variable** or **Add variable**):

   | Key | Value | Secret? |
   |-----|--------|--------|
   | `NODE_ENV` | `production` | No |
   | `DATABASE_URL` | Your full Supabase connection URI (e.g. `postgresql://postgres.xxx:password@aws-0-xx.pooler.supabase.com:6543/postgres`) | Yes (toggle “Secret”) |
   | `CLIENT_URL` | `https://supaclean-pos.onrender.com` | No |
   | `REACT_APP_API_URL` | `https://supaclean-pos.onrender.com/api` | No |

   **Important:**

   - Replace `supaclean-pos` in the URLs with the **exact name** you gave the service in Step 3. If your service name is different (e.g. `my-pos`), use:
     - `CLIENT_URL` = `https://my-pos.onrender.com`
     - `REACT_APP_API_URL` = `https://my-pos.onrender.com/api`
   - For **DATABASE_URL**: paste the full URI from Supabase (with your real password). Prefer the **Connection pooling** URI (port 6543) if Supabase shows it.

3. Save the variables (e.g. **Save** or **Add** for each).

**When you’re done:** Reply with: **“Step 5 done – env vars added”** (do **not** paste your real `DATABASE_URL` here).

---

## Step 6: Create the Web Service and first deploy

**👉 YOU DO**

1. Click **Create Web Service** (or **Deploy**).
2. Wait for the first deploy to run. Render will:
   - Clone the repo
   - Run `npm run build:render` (install deps, build React)
   - Run `npm run server:prod` to start the server
3. Watch the **Logs** tab. Wait until you see something like:
   - “Build successful” or “Build completed”
   - “SUPACLEAN POS Server running on port …”

**If the build or start fails:** Copy the **last 20–30 lines** of the log and reply with: **“Step 6 – build/start failed”** and paste those lines (you can redact passwords).

**When deploy succeeds:** Reply with: **“Step 6 done – deploy succeeded”** and tell me the **exact URL** Render shows (e.g. `https://supaclean-pos.onrender.com`).

---

## Step 7: Update CLIENT_URL and REACT_APP_API_URL (if needed)

Sometimes the first deploy happens before Render shows the final URL. If your service URL is **different** from what you used in Step 5 (e.g. `https://supaclean-pos-xxxx.onrender.com`):

**👉 YOU DO**

1. In Render, open your **Web Service** → **Environment**.
2. Set **CLIENT_URL** to your **exact** service URL (e.g. `https://supaclean-pos-xxxx.onrender.com`), no trailing slash.
3. Set **REACT_APP_API_URL** to that URL + `/api` (e.g. `https://supaclean-pos-xxxx.onrender.com/api`).
4. Save.
5. Go to **Manual Deploy** → **Deploy latest commit** (so the app is rebuilt with the correct `REACT_APP_API_URL`).

**When you’re done:** Reply with: **“Step 7 done – URLs updated and redeployed”** (or “Step 7 skipped – URL was already correct”).

---

## Step 8: Test the app in the browser

**👉 YOU DO**

1. Open your Render URL in the browser (e.g. `https://supaclean-pos.onrender.com`).
2. You should see the **SUPACLEAN POS** login page.
3. Log in with your admin user (the one that exists in your Supabase database).

**If the app doesn’t load or login fails:** Reply with:
- **“Step 8 – app doesn’t load”** and what you see (blank page, error message, etc.), or
- **“Step 8 – login fails”** and the exact error (e.g. “Invalid or expired session”, network error).

**When it works:** Reply with: **“Step 8 done – I can log in and use the app.”**

---

## Optional: Health check (recommended)

In Render: **Settings** → **Health Check Path** set to:

```text
/api/health
```

This helps Render know when your app is up. Save if there’s a **Save** button.

---

## Summary

| Step | What you do |
|------|------------------|
| 1 | Push code to GitHub/GitLab |
| 2 | Render account + connect repo |
| 3 | Set name, region, runtime = Node |
| 4 | Build: `npm run build:render`, Start: `npm run server:prod` |
| 5 | Add NODE_ENV, DATABASE_URL, CLIENT_URL, REACT_APP_API_URL |
| 6 | Create Web Service, wait for deploy |
| 7 | Fix CLIENT_URL / REACT_APP_API_URL if URL changed, redeploy |
| 8 | Open URL, log in, confirm it works |

Start with **Step 1**. When you’ve done it, reply with **“Step 1 done”** (or paste any error), and we’ll continue from there.
