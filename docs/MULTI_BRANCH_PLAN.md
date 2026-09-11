# Multi-Branch System Implementation Plan

## 🏢 Business Context

- **10 Branches** in Arusha, Tanzania
- **8 Collection Units**: Receive orders and hand out ready laundry (no processing)
- **2 Workshops**: Full operations - receive, process/clean, and hand out orders

---

## 📊 Database Schema Changes

### New Tables Needed:

```sql
-- Branches Table
CREATE TABLE branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,  -- e.g., "AR01", "AR02"
  branch_type TEXT NOT NULL,  -- 'collection' or 'workshop'
  address TEXT,
  phone TEXT,
  manager_name TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Branch Features (Feature Flags)
CREATE TABLE branch_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL,
  feature_key TEXT NOT NULL,  -- e.g., 'order_processing', 'expense_tracking'
  is_enabled INTEGER DEFAULT 1,
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  UNIQUE(branch_id, feature_key)
);

-- Users/Staff Table (for branch assignment)
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  branch_id INTEGER,
  role TEXT NOT NULL,  -- 'admin', 'manager', 'cashier', 'processor'
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES branches(id)
);

-- Order Transfer/Assignment Table
CREATE TABLE order_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  from_branch_id INTEGER,
  to_branch_id INTEGER NOT NULL,
  transfer_type TEXT NOT NULL,  -- 'processing', 'collection'
  transferred_by INTEGER,
  transfer_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (from_branch_id) REFERENCES branches(id),
  FOREIGN KEY (to_branch_id) REFERENCES branches(id),
  FOREIGN KEY (transferred_by) REFERENCES users(id)
);
```

### Modified Tables:

```sql
-- Add branch_id to orders
ALTER TABLE orders ADD COLUMN branch_id INTEGER;
ALTER TABLE orders ADD COLUMN created_at_branch_id INTEGER;  -- Where order was created
ALTER TABLE orders ADD COLUMN ready_at_branch_id INTEGER;     -- Where order was marked ready
ALTER TABLE orders ADD COLUMN collected_at_branch_id INTEGER; -- Where order was collected

-- Add branch_id to customers (primary branch)
ALTER TABLE customers ADD COLUMN primary_branch_id INTEGER;

-- Add branch_id to transactions
ALTER TABLE transactions ADD COLUMN branch_id INTEGER;

-- Add branch_id to expenses
ALTER TABLE expenses ADD COLUMN branch_id INTEGER;
```

---

## 🔐 Feature Flags System

### Recommended Feature Permissions:

#### **Collection Units (8 branches):**
✅ **Enabled:**
- New Order Creation
- Order Collection (handing out ready orders)
- Customer Management
- Cash Management (for their branch)
- Basic Reports (sales, customers - for their branch only)
- Price List (view only)
- Collection Queue View

❌ **Disabled:**
- Order Status Changes (can't mark as processing/ready)
- Order Processing Dashboard
- Expenses Management (they don't incur cleaning expenses)
- Advanced Reports (workshop-specific analytics)
- Service Management (price changes)
- Bank Deposits (handled centrally)

#### **Workshops (2 branches):**
✅ **Enabled:**
- **All features** from Collection Units, PLUS:
- Order Status Management (pending → processing → ready)
- Expenses Management
- Advanced Reports (processing analytics, workshop metrics)
- Service Management (can modify prices for their branch)
- Bank Deposits
- Inventory/Stock Management (if implemented)

---

## 🎛️ Admin Dashboard Features

### Admin Access Level:
- View data from **ALL branches**
- Switch between branch views
- Configure branch settings
- Manage feature flags per branch
- View consolidated reports
- Transfer orders between branches
- Manage users and permissions
- Set branch-specific pricing (if needed)

### Admin Dashboard Sections:

1. **Branch Overview**
   - List all 10 branches with status
   - Quick stats per branch (orders today, revenue, pending)
   - Branch health indicators

2. **Branch Profile/Details**
   - View/edit branch information
   - Configure feature flags
   - View branch-specific reports
   - Manage branch users

3. **Consolidated Reports**
   - Company-wide sales
   - Branch comparison reports
   - Transfer/processing analytics
   - Multi-branch customer views

4. **Order Transfer Management**
   - Transfer orders from collection units to workshops
   - Track order journey across branches
   - Processing queue management

5. **User Management**
   - Create/manage users per branch
   - Assign roles and permissions
   - Branch access control

---

## 🚀 Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Create branches table
- [ ] Create branch_features table
- [ ] Create users table
- [ ] Add branch_id to existing tables
- [ ] Migration script for existing data

### Phase 2: Authentication & Authorization (Week 1-2)
- [ ] User login system
- [ ] Session management
- [ ] Role-based access control (RBAC)
- [ ] Branch context switching

### Phase 3: Feature Flags (Week 2)
- [ ] Feature flag system
- [ ] Conditional UI rendering based on features
- [ ] Branch-specific route protection
- [ ] Default feature sets per branch type

### Phase 4: Admin Dashboard (Week 2-3)
- [ ] Admin dashboard UI
- [ ] Branch overview page
- [ ] Branch profile/management page
- [ ] Feature flag management interface

### Phase 5: Branch Isolation (Week 3)
- [ ] Filter all queries by branch_id
- [ ] Branch-specific reports
- [ ] Branch-specific dashboards
- [ ] Data isolation testing

### Phase 6: Order Transfer System (Week 3-4)
- [ ] Order transfer functionality
- [ ] Transfer history tracking
- [ ] Processing queue for workshops
- [ ] Notification system for transfers

### Phase 7: Consolidated Reports (Week 4)
- [ ] Admin multi-branch reports
- [ ] Branch comparison charts
- [ ] Company-wide analytics
- [ ] Export functionality

---

## 🔄 What's Left in the Pipeline

### ✅ **Completed:**
1. Basic POS system
2. Customer management
3. Order creation and management
4. Collection system
5. Cash management
6. Reports (basic)
7. Loyalty program
8. Estimated collection dates
9. Excel import (customers & stock)
10. SMS/WhatsApp notifications (placeholder)
11. Receipt QR codes
12. Color description input (replacing dropdown)
13. UI/UX improvements (compact tables, tabs)

### ⚠️ **In Progress / Needs Completion:**
1. **SMS Integration** - Currently placeholder, needs actual API integration
2. **WhatsApp Integration** - Placeholder, needs Meta/Twilio integration
3. **Reminder buttons** - UI exists, needs testing

### 🔜 **Planned / Pending:**
1. **Multi-Branch System** (this new requirement)
2. **Authentication/Login System** (needed for multi-branch)
3. **User Management** (needed for multi-branch)
4. **Order Transfer System** (between branches)
5. **Inventory Management** (for workshops)
6. **Stock Tracking** (cleaning supplies, etc.)
7. **Advanced Analytics** (predictive, trends)
8. **Mobile App** (for field collection)
9. **Online Customer Portal** (check order status)
10. **Multi-language Support** (English/Swahili)
11. **Backup & Sync System** (cloud backup for branches)
12. **Real-time Updates** (WebSocket for multi-branch coordination)

---

## 💡 Recommendations

### Priority 1 (Critical for Multi-Branch):
1. **Branch & User System** - Foundation for everything
2. **Authentication** - Secure access control
3. **Feature Flags** - Different capabilities per branch type
4. **Data Isolation** - Each branch sees only their data
5. **Admin Dashboard** - Central oversight

### Priority 2 (Important but can wait):
1. **Order Transfer** - Initially manual, automate later
2. **Consolidated Reports** - Nice to have for admin
3. **Advanced Analytics** - Can add incrementally

### Priority 3 (Future Enhancements):
1. **Mobile App**
2. **Customer Portal**
3. **Real-time Sync**

---

## 🎯 Recommended Approach

**Start with:**
1. Database schema updates (branches, users, feature flags)
2. Basic authentication (simple login, no complex OAuth)
3. Branch context in all queries
4. Feature flag system with UI hiding
5. Admin dashboard for branch management

**Branch Assignment for Existing Data:**
- Default all existing orders/customers to "Main Branch" or create a default branch
- Allow admin to reassign data during migration

**Branch Types Setup:**
- Create 8 collection units with limited features
- Create 2 workshops with full features
- Admin account to manage all

Would you like me to start implementing this? I suggest we begin with Phase 1 (database schema) and Phase 2 (authentication) as they're foundational.
