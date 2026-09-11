# 🚀 SUPACLEAN Migration Quick Reference

Quick lookup guide for common tasks and conversions.

---

## 📋 Common Conversions

### Import Statement
```javascript
// OLD (SQLite)
const db = require('../database/init');

// NEW (PostgreSQL)
const db = require('../database/query');
```

### Route Handler
```javascript
// OLD
router.get('/endpoint', (req, res) => {

// NEW
router.get('/endpoint', async (req, res) => {
```

### db.all() - Get Multiple Rows
```javascript
// OLD (SQLite callback)
db.all('SELECT * FROM table', [], (err, rows) => {
  if (err) return res.status(500).json({ error: err.message });
  res.json(rows);
});

// NEW (PostgreSQL async/await)
try {
  const rows = await db.all('SELECT * FROM table', []);
  res.json(rows);
} catch (err) {
  res.status(500).json({ error: err.message });
}
```

### db.get() - Get Single Row
```javascript
// OLD (SQLite callback)
db.get('SELECT * FROM table WHERE id = ?', [id], (err, row) => {
  if (err) return res.status(500).json({ error: err.message });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// NEW (PostgreSQL async/await)
try {
  const row = await db.get('SELECT * FROM table WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
} catch (err) {
  res.status(500).json({ error: err.message });
}
```

### db.run() - INSERT/UPDATE/DELETE
```javascript
// OLD (SQLite callback)
db.run('INSERT INTO table (name) VALUES (?)', [name], function(err) {
  if (err) return res.status(500).json({ error: err.message });
  res.json({ id: this.lastID });
});

// NEW (PostgreSQL async/await)
try {
  const result = await db.run(
    'INSERT INTO table (name) VALUES (?) RETURNING id',
    [name]
  );
  res.json({ id: result.lastID });
} catch (err) {
  res.status(500).json({ error: err.message });
}
```

---

## 🔄 SQLite to PostgreSQL Function Conversions

### Date Functions

| SQLite | PostgreSQL | Example |
|--------|-----------|---------|
| `strftime('%Y-%m', date)` | `TO_CHAR(date, 'YYYY-MM')` | Format date |
| `strftime('%Y-%m-%d', date)` | `TO_CHAR(date, 'YYYY-MM-DD')` | Format date |
| `datetime('now')` | `NOW()` | Current datetime |
| `date('now')` | `CURRENT_DATE` | Current date |
| `julianday('now') - julianday(date)` | `CURRENT_DATE - date` | Date difference |
| `DATE(date)` | `DATE(date)` or `date::date` | Cast to date |

### Common Patterns

```sql
-- SQLite
WHERE strftime('%Y-%m', o.order_date) = '2026-01'

-- PostgreSQL
WHERE TO_CHAR(o.order_date, 'YYYY-MM') = '2026-01'
-- OR
WHERE DATE_TRUNC('month', o.order_date)::text LIKE '2026-01%'
```

```sql
-- SQLite
WHERE julianday('now') - julianday(date) < 7

-- PostgreSQL
WHERE CURRENT_DATE - date < INTERVAL '7 days'
-- OR
WHERE date > CURRENT_DATE - INTERVAL '7 days'
```

```sql
-- SQLite
WHERE datetime('now')

-- PostgreSQL
WHERE NOW()
-- OR
WHERE CURRENT_TIMESTAMP
```

---

## 🛠️ Common Commands

### Testing
```bash
# Test PostgreSQL connection
node test-postgres-connection.js

# Count database calls in routes
node scripts/count-db-calls.js

# Validate route conversion
node scripts/validate-route-conversion.js server/routes/orders.js

# Find SQLite functions
node scripts/find-sqlite-functions.js
```

### Development
```bash
# Start server
npm run server

# Start frontend
cd client && npm start

# Kill port 5000 (Windows)
.\scripts\kill-port-5000.ps1
```

### Database
```bash
# Export schema
node scripts/export-schema.js

# Convert schema
node scripts/sqlite-to-postgres-converter.js
```

---

## 📝 Environment Variables

### Required (.env file)
```env
# Database
DATABASE_URL=postgresql://user:password@host:port/database

# Server
PORT=5000
CLIENT_URL=http://localhost:3000

# JWT
JWT_SECRET=your-secret-key-here

# SMS (Optional)
SMS_API_KEY=your-key
SMS_API_URL=https://api.africastalking.com/version1/messaging
SMS_USERNAME=your-username
```

### Getting DATABASE_URL from Supabase
1. Go to Supabase Dashboard
2. Project Settings → Database
3. Connection string → URI
4. Copy and replace `[YOUR-PASSWORD]` with your password

---

## ✅ Conversion Checklist

For each route file:
- [ ] Import changed to `require('../database/query')`
- [ ] All route handlers are `async`
- [ ] All `db.all()` use `await` with try/catch
- [ ] All `db.get()` use `await` with try/catch
- [ ] All `db.run()` use `await` with try/catch
- [ ] INSERT statements have `RETURNING id` (if needed)
- [ ] `this.lastID` replaced with `result.lastID`
- [ ] `strftime()` converted to `TO_CHAR()` or `DATE_TRUNC()`
- [ ] `julianday()` converted to date arithmetic
- [ ] `datetime('now')` converted to `NOW()`
- [ ] Error handling uses try/catch
- [ ] File tested and working

---

## 🐛 Common Issues & Fixes

### Issue: "Cannot find module '../database/query'"
**Fix**: Make sure `server/database/query.js` exists

### Issue: "this.lastID is undefined"
**Fix**: Use `result.lastID` from `await db.run()`

### Issue: "strftime is not a function"
**Fix**: Convert to PostgreSQL date functions (see above)

### Issue: "INSERT without RETURNING"
**Fix**: Add `RETURNING id` to INSERT statement if you need the ID

### Issue: "Port 5000 already in use"
**Fix**: Run `.\scripts\kill-port-5000.ps1` (Windows)

---

## 📚 Documentation Links

- **Full Conversion Guide**: `PHASE4_ROUTE_UPDATES.md`
- **Cloud Setup**: `PHASE1_CLOUD_SETUP.md`
- **Database Connection**: `PHASE3_CODE_UPDATES.md`
- **Progress Tracker**: `MIGRATION_PROGRESS.md`
- **Complete Index**: `DOCUMENTATION_INDEX.md`

---

## 🎯 Phase Status

- ✅ Phase 0: Complete
- ⏳ Phase 1: User action (create accounts)
- ⏳ Phase 2: Ready (schema exported)
- ⏳ Phase 3: Ready (code prepared)
- ⏳ Phase 4: Ready (guide created)
- ⏳ Phase 5-7: Pending

---

**Last Updated**: 2026-01-13
