const express = require('express');
const router = express.Router();
const db = require('../database/query');
const { authenticate, requireBranchAccess } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getBranchFilter } = require('../utils/branchFilter');
const { sendInvoiceReminder } = require('../utils/notifications');
const { roundMoney, roundCents } = require('../utils/money');

const TAX_RATE = 0.18;

function generateInvoiceNumber() {
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  const r = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `INV-${y}-${m}-${r}`;
}

// List invoices
router.get('/', authenticate, requireBranchAccess(), async (req, res) => {
  const { customer_id, status, unpaid } = req.query;
  const branchFilter = getBranchFilter(req, 'inv');

  let query = `
    SELECT inv.*, c.name as customer_name, c.phone as customer_phone,
           c.company_name, c.billing_address
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    WHERE 1=1 ${branchFilter.clause}
  `;
  let params = [...branchFilter.params];

  if (customer_id) {
    query += ' AND inv.customer_id = ?';
    params.push(customer_id);
  }
  if (status) {
    query += ' AND inv.status = ?';
    params.push(status);
  }
  if (unpaid === '1' || unpaid === 'true') {
    query += " AND inv.status IN ('draft', 'sent', 'overdue') AND inv.balance_due > 0";
  }

  query += ' ORDER BY inv.invoice_date DESC, inv.created_at DESC';

  try {
    const rows = await db.all(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching invoices:', err);
    res.status(500).json({ error: err.message });
  }
});

// Unpaid invoices (must be before /:id)
router.get('/overdue', authenticate, requireBranchAccess(), async (req, res) => {
  const branchFilter = getBranchFilter(req, 'inv');
  const query = `
    SELECT inv.*, c.name as customer_name, c.phone as customer_phone,
           c.company_name, c.billing_address
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    WHERE inv.status IN ('draft', 'sent', 'overdue') AND inv.balance_due > 0
    ${branchFilter.clause}
    ORDER BY inv.due_date ASC, inv.invoice_date DESC
  `;
  try {
    const rows = await db.all(query, branchFilter.params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching overdue invoices:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get single invoice with items
router.get('/:id', authenticate, requireBranchAccess(), async (req, res) => {
  const { id } = req.params;
  const branchFilter = getBranchFilter(req, 'inv');

  try {
    const inv = await db.get(
      `SELECT inv.*, c.name as customer_name, c.phone as customer_phone,
              c.company_name, c.billing_address, c.billing_contact_name,
              c.billing_contact_phone, c.billing_contact_email, c.tax_id
       FROM invoices inv
       JOIN customers c ON inv.customer_id = c.id
       WHERE inv.id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const items = await db.all(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY line_number',
      [id]
    );
    const payments = await db.all(
      'SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY payment_date DESC',
      [id]
    );

    res.json({ ...inv, items, payments });
  } catch (err) {
    console.error('Error fetching invoice:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send payment notice / reminder via WhatsApp and/or SMS
router.post('/:id/send-notice', authenticate, requireBranchAccess(), async (req, res) => {
  const { id } = req.params;
  const { channels = ['sms', 'whatsapp'], useShort } = req.body;
  const branchFilter = getBranchFilter(req, 'inv');

  try {
    const inv = await db.get(
      `SELECT inv.*, c.id as customer_id, c.name as customer_name, c.phone as customer_phone,
              c.company_name, c.billing_contact_name, c.billing_contact_phone, c.billing_contact_email
       FROM invoices inv
       JOIN customers c ON inv.customer_id = c.id
       WHERE inv.id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const balance = parseFloat(inv.balance_due || inv.total_amount || 0);
    if (balance <= 0) {
      return res.status(400).json({ error: 'Invoice has no balance due; nothing to remind' });
    }

    const invoice = {
      invoice_number: inv.invoice_number,
      balance_due: balance,
      due_date: inv.due_date,
      total_amount: inv.total_amount
    };
    const customer = {
      id: inv.customer_id,
      name: inv.customer_name,
      phone: inv.customer_phone,
      company_name: inv.company_name,
      billing_contact_name: inv.billing_contact_name,
      billing_contact_phone: inv.billing_contact_phone
    };

    const result = await sendInvoiceReminder(invoice, customer, channels, { useShort: useShort === true });
    if (result?.channels?.sms?.smsSuppressed && !result?.channels?.whatsapp?.success) {
      return res.json({
        success: true,
        message: 'SMS sending is globally disabled by admin',
        channels: result.channels,
        preview: result.message,
        sent: false,
        sms_suppressed: true,
      });
    }
    if (!result.success && result.error) {
      return res.status(400).json({ error: result.error, channels: result.channels });
    }
    if (result.skippedDuplicate) {
      return res.json({
        success: true,
        skipped_duplicate: true,
        message: 'Payment notice was already sent recently for this invoice; not sending again.',
        channels: result.channels,
        preview: result.message
      });
    }
    res.json({
      success: true,
      message: 'Payment notice sent',
      channels: result.channels,
      preview: result.message
    });
  } catch (err) {
    console.error('Error sending payment notice:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create invoice from bills (monthly: bill id, billing date, amount per line)
router.post('/', authenticate, requireBranchAccess(), requirePermission('canCreateOrders'), async (req, res) => {
  const { customer_id, period_start, period_end, discount, credit_amount, notes } = req.body;

  if (!customer_id || !period_start || !period_end) {
    return res.status(400).json({ error: 'customer_id, period_start, and period_end are required' });
  }

  const branchFilter = getBranchFilter(req, 'b');
  const branchId = req.user?.branchId || null;

  try {
    const billRows = await db.all(
      `SELECT b.*, c.name as customer_name
       FROM bills b
       JOIN customers c ON b.customer_id = c.id
       WHERE b.customer_id = ? AND b.billing_date >= ? AND b.billing_date <= ?
         AND b.invoice_id IS NULL
         ${branchFilter.clause}
       ORDER BY b.billing_date, b.id`,
      [customer_id, period_start, period_end, ...branchFilter.params]
    );

    if (!billRows.length) {
      return res.status(400).json({ error: 'No uninvoiced bills found for this customer and period' });
    }

    let subtotal = 0;
    for (const b of billRows) subtotal += roundMoney(parseFloat(b.total_amount || 0));
    const disc = roundMoney(parseFloat(discount || 0));
    const cred = roundMoney(parseFloat(credit_amount || 0));
    const afterDisc = Math.max(0, subtotal - disc - cred);
    const taxAmount = roundMoney(roundCents(afterDisc * TAX_RATE));
    const totalAmount = roundMoney(afterDisc + taxAmount);
    const dueDate = new Date(period_end);
    dueDate.setDate(dueDate.getDate() + 30);
    const dueDateStr = dueDate.toISOString().slice(0, 10);

    const invNum = generateInvoiceNumber();
    const r = await db.run(
      `INSERT INTO invoices (
        invoice_number, customer_id, invoice_date, due_date,
        period_start, period_end, subtotal, tax_rate, tax_amount, discount, credit_amount,
        total_amount, paid_amount, balance_due, status, notes, branch_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'draft', ?, ?, ?) RETURNING id`,
      [
        invNum,
        customer_id,
        period_end,
        dueDateStr,
        period_start,
        period_end,
        subtotal,
        TAX_RATE,
        taxAmount,
        disc,
        cred,
        totalAmount,
        totalAmount,
        notes || null,
        branchId,
        req.user?.username || null
      ]
    );

    const invoiceId = r.lastID;
    let lineNum = 1;
    for (const b of billRows) {
      const amt = roundMoney(parseFloat(b.total_amount || 0));
      const dateStr = b.billing_date ? new Date(b.billing_date).toISOString().slice(0, 10) : '';
      const desc = `Bill ${b.bill_number} • ${dateStr}`;
      await db.run(
        `INSERT INTO invoice_items (invoice_id, bill_id, billing_date, line_number, description, quantity, unit_price, total_amount)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [invoiceId, b.id, b.billing_date, lineNum++, desc, amt, amt]
      );
      await db.run('UPDATE bills SET invoice_id = ? WHERE id = ?', [invoiceId, b.id]);
    }

    const inv = await db.get(
      `SELECT inv.*, c.name as customer_name, c.company_name, c.billing_address
       FROM invoices inv JOIN customers c ON inv.customer_id = c.id WHERE inv.id = ?`,
      [invoiceId]
    );
    const items = await db.all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY line_number', [invoiceId]);
    res.status(201).json({ ...inv, items, payments: [] });
  } catch (err) {
    console.error('Error creating invoice:', err);
    res.status(500).json({ error: err.message });
  }
});

// Record payment (full payment only)
router.post('/:id/payments', authenticate, requireBranchAccess(), requirePermission('canManageCash'), async (req, res) => {
  const { id } = req.params;
  const { amount, payment_date, payment_method, reference_number, notes } = req.body;

  if (!amount || !payment_date) {
    return res.status(400).json({ error: 'amount and payment_date are required' });
  }

  const branchFilter = getBranchFilter(req, 'inv');
  const branchId = req.user?.branchId || null;
  const payAmt = roundMoney(parseFloat(amount));

  try {
    const inv = await db.get(
      `SELECT id, total_amount, paid_amount, balance_due, status FROM invoices WHERE id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const balance = roundMoney(parseFloat(inv.balance_due || 0));
    if (balance <= 0) {
      return res.status(400).json({ error: 'Invoice is already fully paid' });
    }
    const diff = Math.abs(payAmt - balance);
    if (diff > 0.02) {
      return res.status(400).json({
        error: 'Only full payment is accepted. Amount must equal balance due (TSh ' + balance.toLocaleString() + ').'
      });
    }

    await db.run(
      `INSERT INTO invoice_payments (invoice_id, payment_date, amount, payment_method, reference_number, notes, branch_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        payment_date,
        payAmt,
        payment_method || 'cash',
        reference_number || null,
        notes || null,
        branchId,
        req.user?.username || null
      ]
    );

    const newPaid = roundMoney(parseFloat(inv.paid_amount || 0) + payAmt);
    const newBalance = roundMoney(parseFloat(inv.total_amount || 0) - newPaid);

    await db.run(
      `UPDATE invoices SET paid_amount = ?, balance_due = ?, status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ? ${branchFilter.clause}`,
      [newPaid, newBalance, id, ...branchFilter.params]
    );

    const updated = await db.get(
      `SELECT inv.*, c.name as customer_name, c.company_name FROM invoices inv
       JOIN customers c ON inv.customer_id = c.id WHERE inv.id = ?`,
      [id]
    );
    const payments = await db.all('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY payment_date DESC', [id]);
    res.json({ ...updated, payments });
  } catch (err) {
    console.error('Error recording invoice payment:', err);
    res.status(500).json({ error: err.message });
  }
});

// List payments for an invoice
router.get('/:id/payments', authenticate, requireBranchAccess(), async (req, res) => {
  const { id } = req.params;
  const branchFilter = getBranchFilter(req, 'inv');

  try {
    const inv = await db.get(
      `SELECT id FROM invoices WHERE id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const rows = await db.all('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY payment_date DESC', [id]);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching invoice payments:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
