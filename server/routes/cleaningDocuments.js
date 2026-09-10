const express = require('express');
const router = express.Router();
const db = require('../database/query');
const { authenticate, requireBranchAccess } = require('../middleware/auth');
const { requireCleaningAccess } = require('../middleware/auth');
const { getBranchFilter } = require('../utils/branchFilter');
const { roundMoney } = require('../utils/money');

router.use(authenticate, requireBranchAccess(), requireCleaningAccess());

function generateDocumentNumber(prefix) {
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  const r = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}-${y}-${m}-${r}`;
}

// Financial summary for cleaning (income from payments, expenses) - independent from laundry
router.get('/financial-summary', async (req, res) => {
  const { date_from, date_to } = req.query;
  const branchFilter = getBranchFilter(req, 'cp');
  const branchFilterE = getBranchFilter(req, 'ce');
  let payClause = `1=1 ${branchFilter.clause}`;
  let expClause = `1=1 ${branchFilterE.clause}`;
  const payParams = [...branchFilter.params];
  const expParams = [...branchFilterE.params];
  if (date_from) {
    payClause += ' AND cp.payment_date >= ?';
    payParams.push(date_from);
    expClause += ' AND ce.date >= ?';
    expParams.push(date_from);
  }
  if (date_to) {
    payClause += ' AND cp.payment_date <= ?';
    payParams.push(date_to);
    expClause += ' AND ce.date <= ?';
    expParams.push(date_to);
  }
  try {
    const [payRow, expRow] = await Promise.all([
      db.get(`SELECT COALESCE(SUM(cp.amount), 0) as total FROM cleaning_payments cp WHERE ${payClause}`, payParams),
      db.get(`SELECT COALESCE(SUM(ce.amount), 0) as total FROM cleaning_expenses ce WHERE ${expClause}`, expParams)
    ]);
    const totalIncome = roundMoney(parseFloat(payRow?.total || 0));
    const totalExpenses = roundMoney(parseFloat(expRow?.total || 0));
    res.json({
      totalIncome,
      totalExpenses,
      balance: roundMoney(totalIncome - totalExpenses)
    });
  } catch (err) {
    console.error('Error fetching cleaning financial summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// List cleaning documents (quotations and invoices)
router.get('/', async (req, res) => {
  const { document_type, cleaning_customer_id } = req.query;
  const branchFilter = getBranchFilter(req, 'cd');

  let query = `
    SELECT cd.*, cc.name as customer_name, cc.phone as customer_phone, cc.email, cc.address
    FROM cleaning_documents cd
    JOIN cleaning_customers cc ON cd.cleaning_customer_id = cc.id
    WHERE 1=1 ${branchFilter.clause}
  `;
  let params = [...branchFilter.params];

  if (document_type) {
    query += ' AND cd.document_type = ?';
    params.push(document_type);
  }
  if (cleaning_customer_id) {
    query += ' AND cd.cleaning_customer_id = ?';
    params.push(cleaning_customer_id);
  }

  query += ' ORDER BY cd.document_date DESC, cd.created_at DESC';

  try {
    const rows = await db.all(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching cleaning documents:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get single cleaning document with items and payments
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const branchFilter = getBranchFilter(req, 'cd');

  try {
    const doc = await db.get(
      `SELECT cd.*, cc.name as customer_name, cc.phone as customer_phone, cc.email, cc.address
       FROM cleaning_documents cd
       JOIN cleaning_customers cc ON cd.cleaning_customer_id = cc.id
       WHERE cd.id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const [items, payments] = await Promise.all([
      db.all('SELECT * FROM cleaning_document_items WHERE cleaning_document_id = ? ORDER BY line_number, id', [id]),
      db.all('SELECT * FROM cleaning_payments WHERE cleaning_document_id = ? ORDER BY payment_date DESC', [id])
    ]);
    res.json({ ...doc, items, payments });
  } catch (err) {
    console.error('Error fetching cleaning document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create quotation or invoice (cleaning_customer_id; invoice due date = document_date + 30)
router.post('/', async (req, res) => {
  const { document_type, cleaning_customer_id, document_date, due_date, notes, items } = req.body;

  if (!document_type || !['quotation', 'invoice'].includes(document_type)) {
    return res.status(400).json({ error: 'document_type must be "quotation" or "invoice"' });
  }
  if (!cleaning_customer_id) {
    return res.status(400).json({ error: 'cleaning_customer_id is required' });
  }

  const rawItems = Array.isArray(items) ? items : [];
  if (!rawItems.length) {
    return res.status(400).json({ error: 'At least one line item is required' });
  }

  const branchId = req.user?.branchId ?? req.effectiveBranchId ?? null;
  const branchFilter = getBranchFilter(req, 'cc');

  try {
    const cust = await db.get(
      'SELECT id, name, phone, email, address FROM cleaning_customers WHERE id = ? ' + branchFilter.clause,
      [cleaning_customer_id, ...branchFilter.params]
    );
    if (!cust) return res.status(404).json({ error: 'Cleaning customer not found' });

    let subtotal = 0;
    const lineItems = rawItems.map((it, idx) => {
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const up = roundMoney(parseFloat(it.unit_price) || 0);
      const amt = roundMoney(qty * up);
      subtotal += amt;
      return {
        line_number: idx + 1,
        service_type: String(it.service_type || '').trim() || null,
        description: String(it.description || 'Service').trim() || 'Service',
        quantity: qty,
        unit_price: up,
        total_amount: amt
      };
    });

    const totalAmount = roundMoney(subtotal);
    const prefix = document_type === 'quotation' ? 'QT' : 'INV-CL';
    const documentNumber = generateDocumentNumber(prefix);
    const docDate = document_date || new Date().toISOString().slice(0, 10);
    // Invoices: due date default 30 days from document date
    let dueDateVal = due_date || null;
    if (document_type === 'invoice' && !dueDateVal) {
      const d = new Date(docDate);
      d.setDate(d.getDate() + 30);
      dueDateVal = d.toISOString().slice(0, 10);
    }
    const paidAmount = 0;
    const balanceDue = document_type === 'invoice' ? totalAmount : null;

    const r = await db.run(
      `INSERT INTO cleaning_documents (
        document_type, document_number, cleaning_customer_id, document_date, due_date,
        subtotal, total_amount, paid_amount, balance_due, notes, branch_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        document_type,
        documentNumber,
        cleaning_customer_id,
        docDate,
        dueDateVal,
        subtotal,
        totalAmount,
        paidAmount,
        balanceDue,
        notes || null,
        branchId,
        req.user?.username || null
      ]
    );

    const docId = r.lastID;
    for (const it of lineItems) {
      await db.run(
        `INSERT INTO cleaning_document_items (
          cleaning_document_id, line_number, service_type, description, quantity, unit_price, total_amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [docId, it.line_number, it.service_type, it.description, it.quantity, it.unit_price, it.total_amount]
      );
    }

    const doc = await db.get(
      `SELECT cd.*, cc.name as customer_name, cc.phone as customer_phone, cc.email, cc.address
       FROM cleaning_documents cd
       JOIN cleaning_customers cc ON cd.cleaning_customer_id = cc.id
       WHERE cd.id = ?`,
      [docId]
    );
    const createdItems = await db.all(
      'SELECT * FROM cleaning_document_items WHERE cleaning_document_id = ? ORDER BY line_number, id',
      [docId]
    );
    res.status(201).json({ ...doc, items: createdItems, payments: [] });
  } catch (err) {
    console.error('Error creating cleaning document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Record payment for an invoice (cleaning cash flow)
router.post('/:id/payments', async (req, res) => {
  const { id } = req.params;
  const { amount, payment_date, payment_method, reference_number, notes } = req.body;

  if (!amount || !payment_date) {
    return res.status(400).json({ error: 'amount and payment_date are required' });
  }

  const branchFilter = getBranchFilter(req, 'cd');
  const branchId = req.user?.branchId ?? req.effectiveBranchId ?? null;
  const payAmt = roundMoney(parseFloat(amount));

  try {
    const doc = await db.get(
      `SELECT id, document_type, total_amount, paid_amount, balance_due FROM cleaning_documents WHERE id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.document_type !== 'invoice') {
      return res.status(400).json({ error: 'Payments can only be recorded for invoices' });
    }

    const balance = roundMoney(parseFloat(doc.balance_due ?? doc.total_amount ?? 0));
    if (balance <= 0) {
      return res.status(400).json({ error: 'Invoice is already fully paid' });
    }
    if (payAmt <= 0 || payAmt > balance) {
      return res.status(400).json({ error: 'Amount must be greater than 0 and not exceed balance due (TSh ' + balance.toLocaleString() + ')' });
    }

    await db.run(
      `INSERT INTO cleaning_payments (cleaning_document_id, amount, payment_date, payment_method, reference_number, notes, branch_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        payAmt,
        payment_date,
        payment_method || 'cash',
        reference_number || null,
        notes || null,
        branchId,
        req.user?.username || null
      ]
    );

    const newPaid = roundMoney(parseFloat(doc.paid_amount || 0) + payAmt);
    const newBalance = roundMoney(parseFloat(doc.total_amount || 0) - newPaid);

    await db.run(
      `UPDATE cleaning_documents SET paid_amount = ?, balance_due = ? WHERE id = ? ${branchFilter.clause}`,
      [newPaid, newBalance, id, ...branchFilter.params]
    );

    const updated = await db.get(
      `SELECT cd.*, cc.name as customer_name, cc.phone as customer_phone
       FROM cleaning_documents cd
       JOIN cleaning_customers cc ON cd.cleaning_customer_id = cc.id
       WHERE cd.id = ?`,
      [id]
    );
    const payments = await db.all('SELECT * FROM cleaning_payments WHERE cleaning_document_id = ? ORDER BY payment_date DESC', [id]);
    res.json({ ...updated, payments });
  } catch (err) {
    console.error('Error recording cleaning payment:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
