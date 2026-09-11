# Database Connection Troubleshooting

## Error: `getaddrinfo ENOTFOUND`

This error means the hostname cannot be resolved. Here's how to fix it:

---

## Step 1: Verify Connection String Format

Your connection string should look like:
```
postgresql://postgres:YOUR_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
```

**Important checks:**
- ✅ Starts with `postgresql://`
- ✅ Has `postgres:` before the password
- ✅ Password is correct (no special characters that need encoding)
- ✅ Hostname is `db.PROJECT_REF.supabase.co` (not `xxxxx`)
- ✅ Port is `5432`
- ✅ Database is `postgres`

---

## Step 2: Get the Correct Connection String from Supabase

1. **Go to Supabase Dashboard**:
   - https://app.supabase.com
   - Select your project

2. **Get Connection String**:
   - Click "Project Settings" (gear icon ⚙️)
   - Click "Database"
   - Scroll to "Connection string" section
   - **Select "URI" tab** (not "Connection pooling")
   - Copy the **entire string** shown

3. **Verify the String**:
   - Should start with `postgresql://`
   - Should have your actual project reference (not `xxxxx`)
   - Should have `:5432` for the port
   - Should end with `/postgres`

---

## Step 3: Common Issues

### Issue 1: Wrong Tab Selected
- ❌ **Wrong**: "Connection pooling" tab (starts with `postgresql://postgres.xxx`)
- ✅ **Correct**: "URI" tab (starts with `postgresql://postgres@db.xxx`)

### Issue 2: Password with Special Characters
If your password has special characters like `!`, `@`, `#`, etc., they may need URL encoding:
- `!` → `%21`
- `@` → `%40`
- `#` → `%23`
- `$` → `%24`
- `%` → `%25`

**Example:**
```
# If password is: Tuntchy1871!
# Encoded: Tuntchy1871%21
```

### Issue 3: Project Not Active
- Check Supabase dashboard shows project is "Active"
- If paused, click "Resume" or "Restore"

### Issue 4: Network/Firewall
- Check internet connection
- Try accessing Supabase dashboard in browser
- Check if firewall is blocking port 5432

---

## Step 4: Test Connection String Format

Run this to check your connection string:
```bash
node -e "require('dotenv').config(); console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');"
```

---

## Step 5: Manual Connection Test

You can also test the connection string directly:
```bash
node -e "const { Pool } = require('pg'); require('dotenv').config(); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); pool.query('SELECT NOW()').then(r => { console.log('✅ Success!', r.rows[0]); pool.end(); }).catch(e => { console.error('❌ Error:', e.message); pool.end(); });"
```

---

## Quick Fix Checklist

- [ ] Connection string copied from "URI" tab (not "Connection pooling")
- [ ] Password is correct
- [ ] No `xxxxx` placeholder in hostname
- [ ] Format: `postgresql://postgres:PASSWORD@db.REF.supabase.co:5432/postgres`
- [ ] Supabase project is active
- [ ] Internet connection working
- [ ] `.env` file is in project root
- [ ] `.env` file has no extra spaces or quotes

---

## Still Not Working?

1. **Double-check in Supabase**:
   - Project Settings → Database
   - Copy the connection string again
   - Make sure you're using the "URI" tab

2. **Try resetting password**:
   - Supabase → Project Settings → Database
   - Click "Reset database password"
   - Update `.env` with new password

3. **Verify project status**:
   - Check if project shows as "Active" in dashboard
   - If paused, restore it

---

**Once fixed, run:** `node test-postgres-connection.js`
