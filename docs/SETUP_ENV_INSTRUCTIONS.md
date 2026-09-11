# .env File Setup Instructions

## ✅ JWT_SECRET Verified!

Your `.env` file has been created with:
- ✅ JWT_SECRET: Set and verified (64 characters, valid hex format)
- ⚠️ DATABASE_URL: Needs your Supabase connection string

---

## 🔧 What You Need to Do Next

### Step 1: Get Your Supabase Connection String

1. **Go to Supabase Dashboard**:
   - https://app.supabase.com
   - Select your project

2. **Get Connection String**:
   - Click "Project Settings" (gear icon ⚙️ in left sidebar)
   - Click "Database" in the settings menu
   - Scroll down to "Connection string" section
   - Select the "URI" tab
   - You'll see something like:
     ```
     postgresql://postgres:[YOUR-PASSWORD]@db.xxxxx.supabase.co:5432/postgres
     ```

3. **Copy the Full String**:
   - Click the copy button or manually copy
   - Replace `[YOUR-PASSWORD]` with your actual database password
   - If you don't know your password, click "Reset database password"

---

### Step 2: Update .env File

1. **Open `.env` file** in your project root

2. **Find this line**:
   ```env
   DATABASE_URL=postgresql://postgres:YOUR_PASSWORD_HERE@db.xxxxx.supabase.co:5432/postgres
   ```

3. **Replace with your actual connection string**:
   ```env
   DATABASE_URL=postgresql://postgres:your_actual_password@db.yourproject.supabase.co:5432/postgres
   ```

4. **Save the file**

---

### Step 3: Verify Everything

Run this command to check all environment variables:
```bash
node -e "require('dotenv').config(); console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET ✅' : 'NOT SET ❌'); console.log('JWT_SECRET:', process.env.JWT_SECRET ? 'SET ✅' : 'NOT SET ❌');"
```

---

### Step 4: Test Database Connection

Once DATABASE_URL is set, test the connection:
```bash
node test-postgres-connection.js
```

Expected output:
```
✅ PostgreSQL connection successful!
Current time: 2026-01-13T...
✅ Query test successful!
Branches count: 1
```

---

## 📋 Current Status

- ✅ `.env` file created
- ✅ JWT_SECRET set and verified
- ⚠️ DATABASE_URL needs your Supabase connection string
- ✅ PORT, NODE_ENV, CLIENT_URL set (defaults)

---

## 🔒 Security Notes

- ✅ `.env` is already in `.gitignore` (won't be committed to Git)
- ⚠️ Never share your `.env` file
- ⚠️ Never commit it to version control
- ⚠️ Use different secrets for production

---

## 🆘 Troubleshooting

### "DATABASE_URL not found"
- Make sure `.env` file is in project root
- Check file name is exactly `.env` (not `.env.txt` or `env`)

### "Connection refused"
- Check DATABASE_URL format is correct
- Verify password is correct
- Ensure Supabase project is active
- Check internet connection

### "Invalid connection string"
- Make sure there are no extra spaces
- Verify format: `postgresql://postgres:password@host:port/database`
- Check special characters in password are URL-encoded

---

**Ready?** Get your Supabase connection string and update the `.env` file!
