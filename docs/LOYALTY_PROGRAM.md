# Loyalty Program - Configuration

## 🎯 Loyalty Points System

### Points Calculation
- **1 point = 20,000 TSh spent**
- Points are only awarded when:
  - Order is **collected** (`status = 'collected'`)
  - Order is **fully paid** (`payment_status = 'paid_full'`)
  - Points are automatically calculated and awarded on collection

### Points Redemption
- **Minimum redemption: 10 points**
- **10 points = 10,000 TSh discount** (redemptions in multiples of 10 points)
- Redemption applies discount to orders

### Loyalty Tiers
- **Bronze**: 0+ points
- **Silver**: 500+ lifetime points
- **Gold**: 2,000+ lifetime points  
- **Platinum**: 5,000+ lifetime points

## 📊 Reports Integration

### Top Customers Report (Monthly)
The loyalty program is now integrated into the **Reports** section:

1. **Location**: Reports → Top Customers - Loyalty Program
2. **Monthly Filter**: Select month and year to view monthly points
3. **Columns Displayed**:
   - Customer Name
   - Phone
   - Total Orders (for selected period)
   - Total Spent (for selected period)
   - **Monthly Points Earned** (points earned in selected month)
   - **Current Points** (available for redemption)
   - **Lifetime Points** (total points ever earned)
   - **Tier** (Bronze/Silver/Gold/Platinum)
   - Last Order Date

### Points Calculation Logic
- Monthly points = Sum of `floor(order_amount / 20000)` for all collected & paid orders in that month
- Only orders with `status = 'collected'` AND `payment_status = 'paid_full'` count
- Points are calculated based on `collected_date` field

## 🔄 How It Works

### Earning Points
1. Customer places order
2. Order is collected and fully paid
3. System automatically calculates: `points = floor(total_amount / 20000)`
4. Points added to customer's account
5. Lifetime points updated
6. Tier recalculated if needed

### Redeeming Points
1. Customer needs minimum 10 points
2. Cashier redeems via API: `POST /api/loyalty/redeem`
3. System calculates discount: `floor(points / 10) * 10000`
4. Points deducted from customer account
5. Transaction recorded in `loyalty_transactions`

### Example Scenarios

**Scenario 1: Earning Points**
- Order amount: 50,000 TSh
- Points earned: `floor(50000 / 20000) = 2 points`

**Scenario 2: Earning Points (Small Order)**
- Order amount: 15,000 TSh
- Points earned: `floor(15000 / 20000) = 0 points` (need 20,000+ to earn 1 point)

**Scenario 3: Redeeming a Discount**
- Customer has: 150 points
- Redeems: 10 points
- Gets: 10,000 TSh discount
- Remaining: 140 points

**Scenario 4: Redeeming Multiple Discounts**
- Customer has: 35 points
- Redeems: 30 points
- Gets: 30,000 TSh discount (3 × 10,000 TSh)
- Remaining: 5 points

## 🗄️ Database Structure

### loyalty_points Table
```sql
- customer_id (INTEGER, UNIQUE)
- current_points (INTEGER) - Available for redemption
- lifetime_points (INTEGER) - Total ever earned
- tier (TEXT) - Bronze/Silver/Gold/Platinum
```

### loyalty_transactions Table
```sql
- customer_id (INTEGER)
- order_id (INTEGER, nullable)
- transaction_type (TEXT) - 'earned' or 'redeemed'
- points (INTEGER) - Positive for earned, negative for redeemed
- description (TEXT)
- balance_after (INTEGER) - Points balance after transaction
```

### loyalty_rewards Table
```sql
- name (TEXT) - "Free Wash"
- description (TEXT)
- points_required (INTEGER) - 10
- service_value (REAL) - 10000
- discount_amount (REAL) - 10000
```

## 🔌 API Endpoints

### Get Customer Loyalty Info
```
GET /api/loyalty/customer/:customerId
```
Returns: current_points, lifetime_points, tier, next_tier, points_to_next_tier

### Get Loyalty Transactions
```
GET /api/loyalty/customer/:customerId/transactions?limit=50
```

### Redeem Points
```
POST /api/loyalty/redeem
Body: {
  "customerId": 1,
  "points": 10,
  "orderId": 123 (optional)
}
```

### Get Available Rewards
```
GET /api/loyalty/rewards
```

### Get Customer Report (with Points)
```
GET /api/reports/customers?month=12&year=2024
```

## 📝 Notes

1. **Points are only awarded on collection**, not on order creation
2. **Only fully paid orders** count towards points
3. **Minimum spend per point**: 20,000 TSh (orders under 20,000 TSh earn 0 points)
4. **Minimum redemption**: 10 points (= 10,000 TSh discount)
5. **Points never expire** (stored as lifetime_points)
6. **Tiers are based on lifetime points**, not current points

## 🎨 UI Integration

The loyalty program is now visible in:
- **Reports Page** → Top Customers section
- Shows monthly points earned
- Displays current points balance
- Shows tier status with color coding
- Filterable by month and year

---

**All loyalty features are now active and integrated into the Reports section!** 🎉
