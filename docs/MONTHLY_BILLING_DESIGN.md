# Monthly Billing System Design

## Overview
This system enables tracking and invoicing for companies (hotels, businesses) that pay monthly instead of per-order. It includes:
- **Delivery Notes**: Daily entries for items/services delivered
- **Invoices**: Monthly aggregated invoices from delivery notes
- **Payment Notices**: Reminders for unpaid invoices
- **Print Functionality**: Generate PDFs for all documents

---

## Database Schema Changes

### 1. Update `customers` table
Add fields to identify monthly-billing customers:

```sql
ALTER TABLE customers ADD COLUMN billing_type TEXT DEFAULT 'per_order' CHECK (billing_type IN ('per_order', 'monthly'));
ALTER TABLE customers ADD COLUMN company_name TEXT;
ALTER TABLE customers ADD COLUMN tax_id TEXT;
ALTER TABLE customers ADD COLUMN billing_address TEXT;
ALTER TABLE customers ADD COLUMN billing_contact_name TEXT;
ALTER TABLE customers ADD COLUMN billing_contact_phone TEXT;
ALTER TABLE customers ADD COLUMN billing_contact_email TEXT;
```

### 2. Create `delivery_notes` table
Daily entries for monthly-billing customers:

```sql
CREATE TABLE delivery_notes (
  id SERIAL PRIMARY KEY,
  delivery_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  delivery_date DATE NOT NULL,
  service_id INTEGER REFERENCES services(id),
  item_name TEXT,
  quantity INTEGER DEFAULT 1,
  weight_kg REAL,
  unit_price REAL NOT NULL,
  total_amount REAL NOT NULL,
  notes TEXT,
  delivered_by TEXT,
  received_by TEXT,
  status TEXT DEFAULT 'delivered' CHECK (status IN ('delivered', 'returned', 'cancelled')),
  order_id INTEGER REFERENCES orders(id),
  invoice_id INTEGER REFERENCES invoices(id),
  branch_id INTEGER REFERENCES branches(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT
);

CREATE INDEX idx_delivery_notes_customer_date ON delivery_notes(customer_id, delivery_date);
CREATE INDEX idx_delivery_notes_order ON delivery_notes(order_id);
```

### 3. Create `invoices` table
Monthly invoices aggregating delivery notes:

```sql
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL DEFAULT 0.18,
  tax_amount REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  paid_amount REAL DEFAULT 0,
  balance_due REAL NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  payment_terms TEXT DEFAULT 'Net 30',
  notes TEXT,
  branch_id INTEGER REFERENCES branches(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  sent_at TIMESTAMP,
  paid_at TIMESTAMP
);

CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_date ON invoices(invoice_date);
```

### 4. Create `invoice_items` table
Link delivery notes to invoices:

```sql
CREATE TABLE invoice_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  delivery_note_id INTEGER REFERENCES delivery_notes(id),
  line_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER DEFAULT 1,
  unit_price REAL NOT NULL,
  total_amount REAL NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
```

### 5. Create `invoice_payments` table
Track payments against invoices:

```sql
CREATE TABLE invoice_payments (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  payment_date DATE NOT NULL,
  amount REAL NOT NULL,
  payment_method TEXT DEFAULT 'cash' CHECK (payment_method IN ('cash', 'bank_transfer', 'cheque', 'mobile_money', 'other')),
  reference_number TEXT,
  notes TEXT,
  branch_id INTEGER REFERENCES branches(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT
);

CREATE INDEX idx_invoice_payments_invoice ON invoice_payments(invoice_id);
```

---

## Workflow

### 1. **Setup Monthly-Billing Customer**
- Mark customer as `billing_type = 'monthly'`
- Add company details (company_name, tax_id, billing_address, contacts)
- Customer appears in "Monthly Billing" section

### 2. **Create Delivery Notes (Daily)**
When a hotel brings items:
- Create delivery note with:
  - Customer (monthly-billing)
  - Date
  - Service/item details
  - Quantity/weight
  - Unit price
  - Total amount
  - Delivery/receipt signatures
- Delivery note gets unique `delivery_number` (e.g., "DN-2024-001")
- Status: "delivered" (can be returned/cancelled later)

### 3. **Generate Monthly Invoice**
At month-end:
- Select customer
- Choose period (e.g., "January 2024")
- System aggregates all delivery notes in that period
- Creates invoice with:
  - Invoice number (e.g., "INV-2024-001")
  - Period (start/end dates)
  - Line items from delivery notes
  - Subtotal, tax, discount, total
  - Due date (e.g., 30 days from invoice date)
- Status: "draft" → "sent" (when emailed/printed)

### 4. **Record Invoice Payment**
When payment received:
- Record payment against invoice
- Update `invoice.paid_amount` and `invoice.balance_due`
- If fully paid, status → "paid"
- Link to cash management system

### 5. **Payment Notices**
- System identifies overdue invoices (status = "overdue")
- Generate payment notice PDF
- Can send via email/SMS

---

## API Endpoints

### Delivery Notes
- `GET /api/delivery-notes` - List delivery notes (filter by customer, date range)
- `POST /api/delivery-notes` - Create delivery note
- `GET /api/delivery-notes/:id` - Get delivery note
- `PUT /api/delivery-notes/:id` - Update delivery note
- `DELETE /api/delivery-notes/:id` - Cancel delivery note
- `GET /api/delivery-notes/:id/print` - Print delivery note PDF

### Invoices
- `GET /api/invoices` - List invoices (filter by customer, status, date)
- `POST /api/invoices` - Create invoice from delivery notes
- `GET /api/invoices/:id` - Get invoice with items
- `PUT /api/invoices/:id` - Update invoice (draft only)
- `POST /api/invoices/:id/send` - Mark as sent
- `GET /api/invoices/:id/print` - Print invoice PDF
- `GET /api/invoices/overdue` - Get overdue invoices

### Invoice Payments
- `POST /api/invoices/:id/payments` - Record payment
- `GET /api/invoices/:id/payments` - List payments for invoice
- `DELETE /api/invoice-payments/:id` - Delete payment

### Payment Notices
- `GET /api/payment-notices` - List overdue invoices (for notices)
- `GET /api/payment-notices/:invoice_id/print` - Print payment notice PDF
- **`POST /api/invoices/:id/send-notice`** - Send payment reminder via WhatsApp and/or SMS (see below)

---

## WhatsApp and SMS Reminders

Payment notices for unpaid/overdue invoices can be sent via **WhatsApp** and/or **SMS** using the existing notification stack.

### API: Send Payment Notice

**`POST /api/invoices/:id/send-notice`**

- **Auth**: Required (branch access).
- **Body** (JSON):
  - `channels` (optional): `['sms']`, `['whatsapp']`, or `['sms','whatsapp']`. Default: `['sms','whatsapp']`.
  - `useShort` (optional): `true` to use a shorter message (better for SMS character limits).
- **Response**: `{ success, message, channels, preview }` or error.

**Example**

```bash
curl -X POST /api/invoices/42/send-notice \
  -H "Content-Type: application/json" \
  -d '{"channels": ["sms","whatsapp"], "useShort": true}'
```

### Phone Number Used

- **Monthly billing**: `billing_contact_phone` (if set) otherwise main `customer.phone`.
- **Display name**: `company_name` or `billing_contact_name` or `customer.name`.

Ensure monthly-billing customers have `billing_contact_phone` (and optionally `company_name` / `billing_contact_name`) set so reminders go to the right person.

### SMS Configuration (e.g. Africa's Talking)

Set in `.env`:

- `SMS_API_KEY` – API key from provider
- `SMS_API_URL` – e.g. `https://api.africastalking.com/version1/messaging`
- `SMS_USERNAME` – Africa's Talking username
- `SMS_SENDER_ID` (optional) – Sender ID, e.g. `SUPACLEAN`

If `SMS_API_KEY` is missing, the message is only logged (useful for development).

### WhatsApp Configuration

Choose one provider via `WHATSAPP_PROVIDER` and set the matching env vars.

**Meta (WhatsApp Business / Cloud API)** – default

- `WHATSAPP_PROVIDER=meta` (or omit)
- `WHATSAPP_PHONE_NUMBER_ID` – Meta phone number ID
- `WHATSAPP_ACCESS_TOKEN` – Meta access token

**Twilio**

- `WHATSAPP_PROVIDER=twilio`
- `WHATSAPP_TWILIO_ACCOUNT_SID`
- `WHATSAPP_TWILIO_AUTH_TOKEN`
- `WHATSAPP_TWILIO_FROM` – e.g. `whatsapp:+255...`

**360dialog**

- `WHATSAPP_PROVIDER=360dialog` or `360`
- `WHATSAPP_360DIALOG_API_KEY`
- `WHATSAPP_360DIALOG_INSTANCE_ID`

If WhatsApp credentials are missing, the message is only logged (development mode).

### Message Content

- **Full** (default): Invoice number, company name, amount due, due date, and “X days overdue” when applicable.
- **Short** (`useShort: true`): One concise line, good for single-segment SMS.

### Frontend Integration

On the Invoices (or Payment Notices) UI:

1. For an unpaid/overdue invoice, add a **“Send reminder”** or **“Send via WhatsApp/SMS”** action.
2. Call `POST /api/invoices/:id/send-notice` with the chosen channels (and optionally `useShort: true`).
3. Show success/failure and optionally the `preview` text.

Optional: a “Remind all overdue” action that calls `send-notice` for each invoice returned by `GET /api/invoices/overdue`.

---

## Frontend Pages

### 1. **Monthly Billing Dashboard**
- List of monthly-billing customers
- Quick stats (pending invoices, overdue, total due)
- Recent delivery notes
- Upcoming invoices

### 2. **Delivery Notes Page**
- Create new delivery note
- List delivery notes (table view)
- Filter by customer, date range
- Print delivery notes
- Link to invoice (if invoiced)

### 3. **Invoices Page**
- List invoices (table: number, customer, period, amount, status, due date)
- Create invoice (select customer, period, delivery notes)
- View invoice details
- Print invoice
- Record payment
- Send payment notice

### 4. **Customer Settings**
- Toggle billing type (per_order / monthly)
- Add company details for monthly billing

---

## Print Templates

### Delivery Note Template
- Header: Company logo, "DELIVERY NOTE", delivery number, date
- Customer: Name, address, contact
- Items: Table (date, description, qty, unit price, total)
- Totals: Subtotal, tax (if any), total
- Signatures: Delivered by, Received by
- Footer: Terms, notes

### Invoice Template
- Header: Company logo, "INVOICE", invoice number, date, due date
- Customer: Company name, billing address, tax ID
- Period: "For services rendered: [start] to [end]"
- Items: Table (date, description, qty, unit price, total)
- Totals: Subtotal, discount, tax, total
- Payment: Balance due, payment terms
- Footer: Payment instructions, bank details

### Payment Notice Template
- Header: "PAYMENT NOTICE", invoice number
- Customer: Company name, address
- Notice: "This is a reminder that payment for Invoice [number] is overdue"
- Details: Invoice date, due date, amount due, days overdue
- Payment instructions

---

## Implementation Steps

### Phase 1: Database & Backend
1. Create migration script for new tables
2. Update customers table (add billing fields)
3. Create delivery notes API routes
4. Create invoices API routes
5. Create invoice payments API routes
6. Add print PDF generation utilities

### Phase 2: Frontend
1. Add "Monthly Billing" section to Customers page
2. Create Delivery Notes page
3. Create Invoices page
4. Add print functionality (PDF generation)
5. Add payment recording UI

### Phase 3: Integration
1. **Auto-create delivery notes from orders**: When order created for monthly-billing customer, auto-create delivery note (with editable wholesale price)
2. **Auto-generate invoices for credit customers**: All orders with payment_status='credit' automatically create invoices
3. Integrate invoice payments with cash management
4. Add email/SMS notifications for invoices
5. Add reports (monthly billing summary, outstanding invoices)
6. Add "Monthly Billing" button/access in navigation menu

---

## Example Use Case

**Hotel "Mountain View" brings sheets 5x/week:**

1. **Monday**: Create delivery note DN-2024-001
   - 50 sheets, wash & fold, TSh 5,000
   
2. **Tuesday**: Create delivery note DN-2024-002
   - 45 sheets, wash & fold, TSh 4,500

3. **... (daily entries throughout month)**

4. **End of January**: Generate invoice INV-2024-001
   - Period: Jan 1-31, 2024
   - Aggregates all 20+ delivery notes
   - Total: TSh 95,000
   - Due date: Feb 30, 2024

5. **February 15**: Payment received
   - Record payment TSh 95,000
   - Invoice status → "paid"

---

## Requirements Confirmed

1. **Tax**: 18% VAT applied to invoices
2. **Discounts & Credits**: Fully supported on invoices
3. **Partial Payments**: NOT allowed - only full payments accepted
4. **Auto-Invoicing**: 
   - Auto-generate invoices from delivery notes (with option to edit items/quantities)
   - All credit customers automatically get invoices created and appear in "Unpaid Invoices" section
5. **Delivery Notes**: Auto-created from orders (with option to edit price for wholesale/bulk orders)
6. **Multi-Branch**: Invoices tracked per branch
7. **Access**: Button/feature in navigation for admins and branches to access monthly billing

---

## Next Steps

1. Review and approve this design
2. Create database migration script
3. Implement backend APIs
4. Build frontend pages
5. Test with sample data
6. Deploy and train users
