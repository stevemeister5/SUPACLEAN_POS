const express = require('express');
const router = express.Router();
const db = require('../database/query');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const MIN_ORDER_DEFAULT = 20000; // TSh — coupon program minimum order (Task 4)
const roundMoney = (x) => (typeof x !== 'number' || Number.isNaN(x) ? 0 : Math.round(x * 100) / 100);

router.use(authenticate);

/**
 * Validate a coupon against a receipt subtotal and compute the discount.
 * Shared helper: called from /api/coupons/validate (client) and from the
 * order-creation route (server re-validation, never trust the client's math).
 *
 * @param {Object} opts { code, subtotal, branchId, customerId, client }
 *   - client: optional pg client/transaction to run the used_count increment
 *     atomically with the order insert. When omitted, no increment happens
 *     (pure validation).
 * @returns {Object} { valid, error?, coupon?, discount_amount? }
 */
async function validateCoupon({ code, subtotal, branchId = null, customerId = null, client = null, increment = false }) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) {
    return { valid: false, error: 'Coupon code is required' };
  }
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return { valid: false, error: 'Invalid subtotal' };
  }

  const run = (sql, params) => (client ? client.query(sql, params) : db.get(sql, params));

  const result = await run(
    `SELECT id, code, type, value, min_order_amount, max_uses, used_count,
            starts_at, expires_at, is_active, branch_id
       FROM coupons WHERE UPPER(code) = UPPER($1) LIMIT 1`,
    [cleanCode]
  );
  const row = client ? (result.rows && result.rows[0]) : result;

  if (!row) {
    return { valid: false, error: 'Coupon not found' };
  }
  if (!row.is_active) {
    return { valid: false, error: 'This coupon is no longer active' };
  }
  const now = new Date();
  if (row.starts_at && now < new Date(row.starts_at)) {
    return { valid: false, error: 'This coupon is not active yet' };
  }
  if (row.expires_at && now > new Date(row.expires_at)) {
    return { valid: false, error: 'This coupon has expired' };
  }
  if (row.max_uses > 0 && row.used_count >= row.max_uses) {
    return { valid: false, error: 'This coupon has been fully used' };
  }
  if (row.branch_id != null && branchId != null && Number(row.branch_id) !== Number(branchId)) {
    return { valid: false, error: 'This coupon is not valid at this branch' };
  }
  const minOrder = row.min_order_amount != null ? parseFloat(row.min_order_amount) : MIN_ORDER_DEFAULT;
  if (subtotal < minOrder) {
    return { valid: false, error: `Order subtotal must be at least TSh ${roundMoney(minOrder).toLocaleString()} to use this coupon` };
  }

  // Compute discount
  let discount;
  if (row.type === 'fixed') {
    discount = roundMoney(parseFloat(row.value) || 0);
  } else {
    discount = roundMoney(subtotal * ((parseFloat(row.value) || 0) / 100));
  }
  discount = Math.max(0, Math.min(discount, subtotal));

  if (increment) {
    if (client) {
      await client.query('UPDATE coupons SET used_count = used_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
    } else {
      await db.run('UPDATE coupons SET used_count = used_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
    }
  }

  return {
    valid: true,
    coupon: {
      id: row.id,
      code: row.code,
      type: row.type,
      value: parseFloat(row.value),
      min_order_amount: minOrder,
    },
    discount_amount: discount,
  };
}

// POST /api/coupons/validate — apply-at-checkout validation (cashier-facing)
router.post('/validate', async (req, res) => {
  const { code, subtotal, branch_id, customer_id } = req.body || {};
  const branchId = branch_id != null ? parseInt(branch_id, 10) : (req.user?.branchId ?? null);
  try {
    const outcome = await validateCoupon({
      code,
      subtotal: parseFloat(subtotal),
      branchId: Number.isNaN(branchId) ? null : branchId,
      customerId: customer_id || null,
      increment: false,
    });
    if (!outcome.valid) {
      return res.status(400).json({ valid: false, error: outcome.error });
    }
    res.json(outcome);
  } catch (err) {
    console.error('Coupon validate error:', err);
    res.status(500).json({ error: 'Error validating coupon' });
  }
});

// GET /api/coupons/summary — coupon usage/discount totals (for Reports, Task 4.8)
router.get('/summary', requirePermission('canManageBranches'), async (req, res) => {
  const branchId = req.effectiveBranchId != null ? req.effectiveBranchId : (req.user?.branchId ?? null);
  try {
    const params = branchId != null ? [branchId] : [];
    const branchClause = branchId != null ? 'AND o.branch_id = $1' : '';
    const summary = await db.get(
      `SELECT COUNT(DISTINCT o.id) AS orders_with_coupon,
              COALESCE(SUM(o.discount_amount), 0) AS total_discount
         FROM orders o
        WHERE o.coupon_id IS NOT NULL
          AND COALESCE(o.is_voided, FALSE) = FALSE
          ${branchClause}`,
      params
    );
    const topCoupons = await db.all(
      `SELECT c.code, c.type, c.value, c.used_count,
              COUNT(DISTINCT o.id) AS times_applied,
              COALESCE(SUM(o.discount_amount), 0) AS discount_given
         FROM coupons c
         LEFT JOIN orders o ON o.coupon_id = c.id AND COALESCE(o.is_voided, FALSE) = FALSE
        GROUP BY c.id, c.code, c.type, c.value, c.used_count
        HAVING COUNT(DISTINCT o.id) > 0
        ORDER BY discount_given DESC
        LIMIT 10`,
      []
    );
    res.json({ summary, top_coupons: topCoupons });
  } catch (err) {
    console.error('Error building coupon summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin CRUD (Task 4.6) ----

// GET /api/coupons — list all coupons (admin)
router.get('/', requirePermission('canManageBranches'), async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT id, code, type, value, min_order_amount, max_uses, used_count,
              starts_at, expires_at, is_active, branch_id, created_by, created_at
         FROM coupons ORDER BY created_at DESC`
    );
    res.json(rows || []);
  } catch (err) {
    console.error('Error listing coupons:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coupons — create a coupon (admin)
router.post('/', requirePermission('canManageBranches'), async (req, res) => {
  const {
    code,
    type = 'percent',
    value,
    min_order_amount = MIN_ORDER_DEFAULT,
    max_uses = 0,
    starts_at = null,
    expires_at = null,
    is_active = true,
    branch_id = null,
  } = req.body || {};

  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) return res.status(400).json({ error: 'Coupon code is required' });
  if (!['percent', 'fixed'].includes(type)) return res.status(400).json({ error: "Type must be 'percent' or 'fixed'" });
  const parsedValue = parseFloat(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) return res.status(400).json({ error: 'Value must be a positive number' });
  if (type === 'percent' && parsedValue > 100) return res.status(400).json({ error: 'Percent value cannot exceed 100' });

  try {
    const r = await db.run(
      `INSERT INTO coupons (code, type, value, min_order_amount, max_uses, starts_at, expires_at, is_active, branch_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        cleanCode, type, parsedValue, parseFloat(min_order_amount) || MIN_ORDER_DEFAULT,
        parseInt(max_uses, 10) || 0, starts_at || null, expires_at || null,
        is_active ? 1 : 0, branch_id != null ? parseInt(branch_id, 10) : null, req.user?.id ?? null,
      ]
    );
    const id = r?.row?.id ?? r?.lastID;
    const created = await db.get('SELECT * FROM coupons WHERE id = ?', [id]);
    res.status(201).json(created);
  } catch (err) {
    if (err.message && /UNIQUE|unique/i.test(err.message)) {
      return res.status(400).json({ error: 'A coupon with this code already exists' });
    }
    console.error('Error creating coupon:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/coupons/:id — update (including deactivate) a coupon (admin)
router.put('/:id', requirePermission('canManageBranches'), async (req, res) => {
  const { id } = req.params;
  const {
    type, value, min_order_amount, max_uses, starts_at, expires_at, is_active, branch_id,
  } = req.body || {};
  try {
    const existing = await db.get('SELECT * FROM coupons WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Coupon not found' });

    const newType = type ?? existing.type;
    const newValue = value != null ? parseFloat(value) : parseFloat(existing.value);
    if (!['percent', 'fixed'].includes(newType)) return res.status(400).json({ error: "Type must be 'percent' or 'fixed'" });
    if (!Number.isFinite(newValue) || newValue <= 0) return res.status(400).json({ error: 'Value must be a positive number' });
    if (newType === 'percent' && newValue > 100) return res.status(400).json({ error: 'Percent value cannot exceed 100' });

    const newIsActive = is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active;

    await db.run(
      `UPDATE coupons SET type = ?, value = ?, min_order_amount = ?, max_uses = ?,
              starts_at = ?, expires_at = ?, is_active = ?, branch_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        newType, newValue,
        min_order_amount != null ? parseFloat(min_order_amount) : parseFloat(existing.min_order_amount),
        max_uses != null ? parseInt(max_uses, 10) : existing.max_uses,
        starts_at !== undefined ? starts_at : existing.starts_at,
        expires_at !== undefined ? expires_at : existing.expires_at,
        newIsActive,
        branch_id !== undefined ? (branch_id != null ? parseInt(branch_id, 10) : null) : existing.branch_id,
        id,
      ]
    );
    const updated = await db.get('SELECT * FROM coupons WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    console.error('Error updating coupon:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.validateCoupon = validateCoupon;
