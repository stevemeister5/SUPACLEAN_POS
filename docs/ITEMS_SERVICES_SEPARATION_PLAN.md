# Items & Services Separation - Implementation Plan

## Overview
This document outlines the changes needed to separate **Items** (laundry items like Shirts, Suits) from **Services** (delivery types like Express, Regular).

## Current State
- Services table contains both items and delivery types mixed together
- Orders reference services directly
- No branch-specific pricing

## Target State
- **Items Table**: Laundry items (Shirts, Suits, etc.) with base prices
- **Services Table**: Delivery types (Regular 1x, Express < 8HRS 2x, Express < 3HRS 3x)
- **Branch Item Prices**: Branch-specific pricing for items
- **Orders**: Reference both item_id and service_id

---

## Step 1: Database Migration ✅ COMPLETED

**File**: `scripts/migrate-items-services.sql`

This script:
1. Creates `items` table with laundry items from price list
2. Creates `branch_item_prices` table for branch-specific pricing
3. Updates `services` table to represent delivery types only
4. Adds `item_id` column to `orders` table
5. Populates items from the provided price list

**To Run:**
```bash
# Connect to your PostgreSQL database and run:
psql $DATABASE_URL -f scripts/migrate-items-services.sql
```

Or import via Supabase SQL Editor.

---

## Step 2: Backend API Routes ✅ COMPLETED

### Items API (`server/routes/items.js`) ✅
- `GET /api/items` - Get all items (with branch pricing)
- `GET /api/items/:id` - Get item by ID
- `GET /api/items/category/:category` - Get items by category
- `POST /api/items` - Create item (admin only)
- `PUT /api/items/:id` - Update item (admin only)
- `POST /api/items/:id/branch-price/:branchId` - Set branch price (admin only)
- `DELETE /api/items/:id/branch-price/:branchId` - Delete branch price (admin only)

### Services API (`server/routes/services.js`)
**Status**: ✅ Already exists, will be used for delivery types

Services now represent:
- Regular Service (multiplier 1.0)
- Express Service < 8HRS (multiplier 2.0)
- Express Service < 3HRS (multiplier 3.0)

---

## Step 3: Frontend API Functions ✅ COMPLETED

**File**: `client/src/api/api.js`

Added:
- `getItems()`, `getItem()`, `getItemsByCategory()`
- `createItem()`, `updateItem()`
- `getBranchItemPrice()`, `setBranchItemPrice()`, `deleteBranchItemPrice()`

---

## Step 4: Update Price List Page ⏳ IN PROGRESS

**File**: `client/src/pages/PriceList.js`

**Changes Needed:**
1. Replace services with items
2. Show items grouped by category (Gents, Ladies, General)
3. Display base prices
4. Admin can edit item prices (global and branch-specific)
5. Show service types (delivery types) separately

---

## Step 5: Update New Order Page ⏳ PENDING

**File**: `client/src/pages/NewOrder.js`

**Changes Needed:**
1. Select **Item** first (Shirts, Suits, etc.)
2. Select **Service** (Delivery Type: Regular, Express)
3. Calculate price: `item_price × service_multiplier`
4. Show item name and price in cart (not just service category)
5. Support branch-specific pricing

**Example Flow:**
- Customer selects: "Shirts - White" (Item)
- Customer selects: "Express Service < 8HRS" (Service, multiplier 2.0)
- Price = 3,000 (item) × 2.0 (service) = 6,000 TSh

---

## Step 6: Update Orders API ⏳ PENDING

**File**: `server/routes/orders.js`

**Changes Needed:**
1. Accept both `item_id` and `service_id` in order creation
2. Calculate total: `item_price × service_multiplier × quantity`
3. Store both `item_id` and `service_id` in orders
4. Update order queries to join with items table

---

## Step 7: Branch Feature Management ⏳ PENDING

**Status**: ✅ Already implemented in Admin Dashboard

The `branch_features` table already exists and allows:
- Admin to set feature flags per branch
- Control access to features like:
  - `new_order`
  - `order_processing`
  - `expenses`
  - `cash_management`
  - etc.

**Admin Dashboard**: Already shows branch features management

---

## Testing Checklist

### After Migration:
- [ ] Run database migration script
- [ ] Verify items table has all items from price list
- [ ] Verify services table has only delivery types
- [ ] Test items API endpoints
- [ ] Test branch pricing API

### After Frontend Updates:
- [ ] Price List shows items grouped by category
- [ ] Admin can edit item prices
- [ ] Admin can set branch-specific prices
- [ ] New Order page shows items and services separately
- [ ] Cart shows item name and calculated price
- [ ] Order creation uses items and services correctly

---

## Migration Notes

### Historical Data
- Old orders will keep `service_id` (backward compatible)
- New orders will have both `item_id` and `service_id`
- You may want to migrate old orders later (optional)

### Branch Pricing
- If no branch-specific price exists, use base price
- Admin can override base price per branch
- Useful for different locations with different costs

---

## Priority Order

1. ✅ **Database Migration** - CRITICAL
2. ✅ **Backend API** - CRITICAL
3. ✅ **Frontend API Functions** - CRITICAL
4. **Price List Page Update** - HIGH
5. **New Order Page Update** - HIGH
6. **Orders API Update** - HIGH
7. **Testing & Bug Fixes** - HIGH

---

## Next Steps

1. **Run the migration script** on your PostgreSQL database
2. **Test the Items API** using Postman or curl
3. **Update Price List page** to show items (see Step 4)
4. **Update New Order page** to use items + services (see Step 5)
5. **Update Orders API** to handle items (see Step 6)

---

**Questions?** Check the code comments or refer to the API documentation in each route file.
