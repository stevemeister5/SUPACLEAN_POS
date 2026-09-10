const express = require('express');
const router = express.Router();
const db = require('../database/query');
const { authenticate, requireBranchAccess } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getBranchFilter } = require('../utils/branchFilter');
const { roundMoney, roundCents } = require('../utils/money');

function generateBillNumber() {
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  const d = String(new Date().getDate()).padStart(2, '0');
  const r = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `BIL-${y}-${m}-${d}-${r}`;
}

// List bills
router.get('/', authenticate, requireBranchAccess(), async (req, res) => {
  const { customer_id, date_from, date_to } = req.query;
  const branchFilter = getBranchFilter(req, 'b');

  let query = `
    SELECT b.*, c.name as customer_name, c.phone as customer_phone, c.tin, c.vrn,
           i.invoice_number
    FROM bills b
    JOIN customers c ON b.customer_id = c.id
    LEFT JOIN invoices i ON b.invoice_id = i.id
    WHERE 1=1 ${branchFilter.clause}
  `;
  let params = [...branchFilter.params];

  if (customer_id) {
    query += ' AND b.customer_id = ?';
    params.push(customer_id);
  }
  if (date_from) {
    query += ' AND b.billing_date >= ?';
    params.push(date_from);
  }
  if (date_to) {
    query += ' AND b.billing_date <= ?';
    params.push(date_to);
  }

  query += ' ORDER BY b.billing_date DESC, b.created_at DESC';

  try {
    const rows = await db.all(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching bills:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get single bill with items
router.get('/:id', authenticate, requireBranchAccess(), async (req, res) => {
  const { id } = req.params;
  const branchFilter = getBranchFilter(req, 'b');

  try {
    const bill = await db.get(
      `SELECT b.*, c.name as customer_name, c.phone as customer_phone, c.tin, c.vrn,
              i.invoice_number
       FROM bills b
       JOIN customers c ON b.customer_id = c.id
       LEFT JOIN invoices i ON b.invoice_id = i.id
       WHERE b.id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const items = await db.all(
      'SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id',
      [id]
    );
    res.json({ ...bill, items });
  } catch (err) {
    console.error('Error fetching bill:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create bill (customer + multiple items)
router.post('/', authenticate, requireBranchAccess(), requirePermission('canCreateOrders'), async (req, res) => {
  const { customer_id, billing_date, items } = req.body;

  if (!customer_id || !billing_date) {
    return res.status(400).json({ error: 'customer_id and billing_date are required' });
  }

  const rawItems = Array.isArray(items) ? items : [];
  if (!rawItems.length) {
    return res.status(400).json({ error: 'At least one item is required' });
  }

  const branchId = req.user?.branchId || null;

  try {
    const custCheck = await db.get('SELECT id, name, phone FROM customers WHERE id = ?', [customer_id]);
    if (!custCheck) return res.status(404).json({ error: 'Customer not found' });

    let subtotal = 0;
    const lineItems = rawItems.map((it) => {
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const up = roundMoney(parseFloat(it.unit_price) || 0);
      const amt = roundMoney(qty * up);
      subtotal += amt;
      return {
        description: String(it.description || 'Item').trim() || 'Item',
        quantity: qty,
        unit_price: up,
        total_amount: amt
      };
    });

    const totalAmount = roundMoney(subtotal);
    const billNumber = generateBillNumber();

    const r = await db.run(
      `INSERT INTO bills (bill_number, customer_id, billing_date, subtotal, total_amount, branch_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [billNumber, customer_id, billing_date, subtotal, totalAmount, branchId, req.user?.username || null]
    );

    const billId = r.lastID;
    for (const it of lineItems) {
      await db.run(
        `INSERT INTO bill_items (bill_id, description, quantity, unit_price, total_amount)
         VALUES (?, ?, ?, ?, ?)`,
        [billId, it.description, it.quantity, it.unit_price, it.total_amount]
      );
    }

    const bill = await db.get(
      `SELECT b.*, c.name as customer_name, c.phone as customer_phone, c.tin, c.vrn
       FROM bills b JOIN customers c ON b.customer_id = c.id WHERE b.id = ?`,
      [billId]
    );
    const createdItems = await db.all('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id', [billId]);
    res.status(201).json({ ...bill, items: createdItems });
  } catch (err) {
    console.error('Error creating bill:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
