const express = require('express');
const router = express.Router();
const db = require('../database/query');
const {
  generateReceiptNumber,
  calculateTotal,
  formatReceipt,
  formatReceiptAsync,
  generateReceiptQRCode,
  formatCustomerReceiptId,
  parseReceiptNumber,
  getBranchReceiptPrefix,
  buildPrefixedReceiptNumber,
  normalizeReceiptNumberForBranch,
  allocateBranchReceiptSequence,
  generateReceiptNumberAsync,
} = require('../utils/receipt');
const {
  generateOrderReceiptSms,
  generateCollectionReminder,
  daysOverdueFromEstimated
} = require('../utils/sms');
const { sendSmsWithWhatsAppFallback } = require('../utils/notifications');
const { authenticate, requireBranchAccess, requireBranchFeature, requireBranchFeatureAny, requireReceiptAccess } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../middleware/permissions');
const { getBranchFilter, getEffectiveBranchId } = require('../utils/branchFilter');
const { validatePayment } = require('../utils/paymentValidation');
const { roundMoney } = require('../utils/money');
const { recordPaymentTransaction, recordPaymentTransactionClient, logPaymentChange, logPaymentChangeClient } = require('../utils/paymentTransactions');
const { applyReceiptPaymentAtomic } = require('../utils/receiptPayment');
const { parseArchiveOptions, archiveOldOrders: runArchiveOldOrders } = require('../utils/archiveOldOrders');
const { voidReceiptByNumber } = require('../utils/orderVoid');
const {
  createVoidReceiptRequest,
  logAdminExecutedVoid,
  getPendingVoidForReceipt,
  assertNoPendingVoid,
} = require('../utils/adminInbox');
const { sqlActiveOrdersOnly, sqlUnarchivedOrdersOnly } = require('../utils/orderVoidFilter');
const cashManagement = require('./cashManagement');
const {
  readIdempotencyKey,
  getStoredIdempotencyResponse,
  storeIdempotencyResponse,
  pruneExpiredIdempotencyKeys,
} = require('../utils/idempotency');
const { assertNotFutureBusinessDate, getBusinessTodayYmd } = require('../utils/businessDate');
const { generatePlaceholderPhone, isPlaceholderPhone, normalizePhoneDigits, sanitizeImportPhone, resolveInsertId } = require('../utils/customerPhone');
const multer = require('multer');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

// Serverless-safe uploads directory (/tmp is writable on Vercel)
const uploadsDir = process.env.VERCEL
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, '../../uploads');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (error) {
  console.error('Upload directory unavailable:', error && error.message ? error.message : error);
}

const upload = multer({ dest: uploadsDir });

function paymentBookDateYmd(paymentDate) {
  return typeof paymentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate.trim())
    ? paymentDate.trim()
    : getBusinessTodayYmd();
}

function buildPaymentTimestampIso(paymentDate) {
  const todayIso = new Date().toISOString();
  const datePart = paymentBookDateYmd(paymentDate);
  return `${datePart}T${todayIso.slice(11, 19)}.000Z`;
}

function triggerDailySummaryRefreshAsync(paymentDate, branchId) {
  cashManagement.scheduleBackgroundDailySummaryRefresh(paymentDate, branchId).catch(err => {
    console.error('BACKGROUND: daily summary refresh failed:', err.message);
  });
}

function buildPerOrderPaidAllocations(orders, receiptPaidAmount) {
  const sorted = [...orders].sort((a, b) => Number(a.id) - Number(b.id));
  let remaining = Math.max(0, roundMoney(receiptPaidAmount));
  const allocations = [];

  for (const o of sorted) {
    const total = Math.max(0, roundMoney(Number(o.total_amount) || 0));
    const paidNow = Math.min(total, remaining);
    remaining -= paidNow;
    const status = paidNow >= total ? 'paid_full' : (paidNow > 0 ? 'advance' : 'not_paid');
    allocations.push({
      id: o.id,
      paid_amount: paidNow,
      payment_status: status
    });
  }

  return allocations;
}

// All order routes require new_order or order_processing (admin bypasses); collect route adds collection
router.use(authenticate, requireBranchFeatureAny('new_order', 'order_processing'));

// Get all orders
router.get('/', authenticate, requireBranchAccess(), async (req, res) => {
  const { 
    status, 
    customer_id, 
    date, 
    overdue_only,
    customer,
    date_from,
    date_to,
    min_amount,
    max_amount,
    payment_status,
    limit: limitParam,
    offset: offsetParam,
    page,
    include_voided,
    archived
  } = req.query;
  
  const branchFilter = getBranchFilter(req, 'o');
  
  let query = `
    SELECT o.*, s.name as service_name, c.name as customer_name, c.phone as customer_phone,
           b.name as branch_name,
           b.code as branch_code
    FROM orders o
    JOIN services s ON o.service_id = s.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN branches b ON o.branch_id = b.id
    WHERE 1=1
    ${branchFilter.clause}
  `;
  let params = [...branchFilter.params];

  const archivedOnly = archived === 'true' || status === 'archived';

  if (archivedOnly) {
    query += ' AND o.archived_at IS NOT NULL';
  } else if (status === 'voided') {
    query += ' AND COALESCE(o.is_voided, FALSE) = TRUE';
    query += ` ${sqlUnarchivedOrdersOnly('o')}`;
  } else {
    query += ` ${sqlUnarchivedOrdersOnly('o')}`;
    if (include_voided !== 'true') {
      query += ` ${sqlActiveOrdersOnly('o')}`;
    }
    if (status) {
      // "pending" tab shows both pending and processing (one in-progress tab)
      if (status === 'pending') {
        query += ' AND (o.status = ? OR o.status = ?)';
        params.push('pending', 'processing');
      } else {
        query += ' AND o.status = ?';
        params.push(status);
      }
    }
  }

  if (customer_id) {
    query += ' AND o.customer_id = ?';
    params.push(customer_id);
  }

  // Search by customer name or phone (case-insensitive)
  if (customer) {
    query += ' AND (c.name ILIKE ? OR c.phone ILIKE ?)';
    const customerSearch = `%${customer}%`;
    params.push(customerSearch, customerSearch);
  }

  if (date) {
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = new Date(`${date}T00:00:00.000Z`);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    query += ' AND o.order_date >= ? AND o.order_date < ?';
    params.push(dayStart, dayEnd.toISOString());
  }

  // Date range filters
  if (date_from) {
    query += ' AND o.order_date >= ?';
    params.push(`${date_from}T00:00:00.000Z`);
  }

  if (date_to) {
    const rangeEnd = new Date(`${date_to}T00:00:00.000Z`);
    rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);
    query += ' AND o.order_date < ?';
    params.push(rangeEnd.toISOString());
  }

  // Amount range filters
  if (min_amount) {
    query += ' AND o.total_amount >= ?';
    params.push(parseFloat(min_amount));
  }

  if (max_amount) {
    query += ' AND o.total_amount <= ?';
    params.push(parseFloat(max_amount));
  }

  // Payment status filter
  if (payment_status) {
    query += ' AND o.payment_status = ?';
    params.push(payment_status);
  }

  // Filter for overdue orders (ready but past estimated collection date)
  if (overdue_only === 'true') {
    query += ` AND o.status = 'ready' AND o.estimated_collection_date IS NOT NULL AND o.estimated_collection_date < CURRENT_TIMESTAMP`;
  }

  query += ' ORDER BY o.order_date DESC';

  // Pagination (default 50 for fast first load, max 500)
  const limit = Math.min(parseInt(limitParam, 10) || 50, 500);
  const offset = offsetParam !== undefined ? parseInt(offsetParam, 10) : (page ? (Math.max(1, parseInt(page, 10)) - 1) * limit : 0);
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  try {
    const rows = await db.all(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard counts (receipt-based, branch-scoped) to keep Dashboard and Orders figures consistent
router.get('/dashboard-stats', authenticate, requireBranchAccess(), async (req, res) => {
  const branchFilter = getBranchFilter(req, 'o');

  const query = `
    SELECT
      COUNT(DISTINCT UPPER(o.receipt_number)) AS total_receipts,
      COUNT(DISTINCT CASE
        WHEN o.status IN ('pending', 'processing')
        THEN UPPER(o.receipt_number)
      END) AS pending_receipts,
      COUNT(DISTINCT CASE
        WHEN o.status = 'ready'
        THEN UPPER(o.receipt_number)
      END) AS ready_receipts,
      COUNT(DISTINCT CASE
        WHEN o.status = 'collected'
        THEN UPPER(o.receipt_number)
      END) AS collected_receipts,
      COUNT(*) AS total_items
    FROM orders o
    WHERE 1=1
    ${sqlActiveOrdersOnly('o')}
    ${sqlUnarchivedOrdersOnly('o')}
    ${branchFilter.clause}
  `;

  try {
    const row = await db.get(query, [...branchFilter.params]);
    res.json({
      total_receipts: Number(row?.total_receipts || 0),
      pending_receipts: Number(row?.pending_receipts || 0),
      ready_receipts: Number(row?.ready_receipts || 0),
      collected_receipts: Number(row?.collected_receipts || 0),
      total_items: Number(row?.total_items || 0)
    });
  } catch (err) {
    console.error('Error fetching order dashboard stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Archive completed historical orders so active operational screens stay fast.
// This is a soft archive: records remain available for audit/history and cash summaries.
router.post('/archive-old', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can run order archive maintenance.' });
  }

  const branchFilter = getBranchFilter(req);
  const options = parseArchiveOptions({
    ...req.body,
    archived_by: req.user?.fullName || req.user?.username || 'Admin',
  });

  try {
    const result = await runArchiveOldOrders(branchFilter, options);
    res.json(result);
  } catch (err) {
    console.error('Error archiving old orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get collection queue (ready orders with queue info) - grouped by receipt number. Branch-scoped; optional customer name/phone search.
router.get('/collection-queue', authenticate, requireBranchAccess(), async (req, res) => {
  const { limit = 20, overdue_only, customer } = req.query;
  const branchFilter = getBranchFilter(req, 'o');
  
  // First, get all ready orders (branch-filtered; optional name/phone filter)
  let query = `
    SELECT o.*, s.name as service_name, c.name as customer_name, c.phone as customer_phone,
           b.name as branch_name,
           b.code as branch_code,
           CASE 
             WHEN o.estimated_collection_date IS NOT NULL AND o.estimated_collection_date < CURRENT_TIMESTAMP THEN 1
             ELSE 0
           END as is_overdue,
           CASE 
             WHEN o.estimated_collection_date IS NOT NULL THEN 
               CAST(EXTRACT(EPOCH FROM (NOW() - o.estimated_collection_date)) / 3600 AS INTEGER)
             ELSE NULL
           END as hours_overdue
    FROM orders o
    JOIN services s ON o.service_id = s.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN branches b ON o.branch_id = b.id
    WHERE o.status = 'ready'
    ${sqlActiveOrdersOnly('o')}
    ${sqlUnarchivedOrdersOnly('o')}
    ${branchFilter.clause}
  `;
  
  let params = [...branchFilter.params];
  
  if (customer && String(customer).trim()) {
    query += ' AND (c.name ILIKE ? OR c.phone ILIKE ?)';
    const customerSearch = `%${String(customer).trim()}%`;
    params.push(customerSearch, customerSearch);
  }
  
  if (overdue_only === 'true') {
    query += ` AND o.estimated_collection_date IS NOT NULL AND o.estimated_collection_date < CURRENT_TIMESTAMP`;
  }
  
  query += ` ORDER BY 
    is_overdue DESC,
    CASE WHEN o.estimated_collection_date IS NOT NULL THEN o.estimated_collection_date ELSE o.ready_date END ASC`;
  
  // Cap rows at DB level to avoid loading thousands of orders (scalability + faster response)
  const maxRows = Math.min(Math.max(parseInt(limit, 10) || 20, 20) * 25, 500);
  query += ' LIMIT ?';
  params.push(maxRows);

  try {
    const allOrders = await db.all(query, params);
    
    // Group orders by receipt_number
    const receiptGroups = {};
    allOrders.forEach(order => {
      const receiptNum = order.receipt_number;
      if (!receiptGroups[receiptNum]) {
        receiptGroups[receiptNum] = [];
      }
      receiptGroups[receiptNum].push(order);
    });
    
    // Create grouped receipt entries with totals
    const groupedReceipts = Object.keys(receiptGroups).map(receiptNum => {
      const items = receiptGroups[receiptNum];
      const firstItem = items[0];
      
      // Calculate totals across all items
      const receiptTotal = items.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0);
      const receiptPaid = items.reduce((sum, o) => sum + (parseFloat(o.paid_amount) || 0), 0);
      
      return {
        ...firstItem,
        receipt_number: receiptNum,
        total_amount: receiptTotal,
        paid_amount: receiptPaid,
        receipt_item_count: items.length,
        is_overdue: firstItem.is_overdue,
        hours_overdue: firstItem.hours_overdue,
        all_items: items // Include all items for reference
      };
    });
    
    // Sort grouped receipts and limit
    groupedReceipts.sort((a, b) => {
      if (a.is_overdue !== b.is_overdue) return b.is_overdue - a.is_overdue;
      const aDate = a.estimated_collection_date || a.ready_date;
      const bDate = b.estimated_collection_date || b.ready_date;
      return new Date(aDate) - new Date(bDate);
    });
    
    const limited = groupedReceipts.slice(0, parseInt(limit));
    res.json(limited);
  } catch (err) {
    console.error('Error fetching collection queue:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get order by receipt number - returns ALL items for the receipt with aggregated totals
// Case-insensitive receipt number search (receipt numbers are global identifiers, not branch-scoped)
router.get('/receipt/:receiptNumber', authenticate, requireReceiptAccess(), async (req, res) => {
  const { receiptNumber } = req.params;
  
  try {
    // Get ALL orders for this receipt number (case-insensitive) across all branches.
    // A receipt number is a global identifier; we do NOT filter by the user's branch so
    // that lookups succeed even when the receipt lives on a different branch or when
    // the user has no branch yet.
    const allOrders = await db.all(
      `SELECT o.*, s.name as service_name, s.description as service_description,
              c.name as customer_name, c.phone as customer_phone, c.email as customer_email,
              i.name as item_name, i.category as item_category,
              b.name as branch_name,
              b.code as branch_code
       FROM orders o
       JOIN services s ON o.service_id = s.id
       JOIN customers c ON o.customer_id = c.id
       LEFT JOIN items i ON o.item_id = i.id
       LEFT JOIN branches b ON o.branch_id = b.id
       WHERE UPPER(o.receipt_number) = UPPER(?)
       ORDER BY o.id`,
      [receiptNumber]
    );
    
    if (!allOrders || allOrders.length === 0) {
      return res.status(404).json({ error: 'Receipt not found' });
    }
    
    // Calculate receipt totals
    const receiptTotal = allOrders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0);
    const receiptPaid = allOrders.reduce((sum, o) => sum + (parseFloat(o.paid_amount) || 0), 0);
    
    // Return first order with receipt totals and all items
    const mainOrder = {
      ...allOrders[0],
      total_amount: receiptTotal,
      paid_amount: receiptPaid,
      receipt_item_count: allOrders.length,
      all_items: allOrders
    };
    
    res.json(mainOrder);
  } catch (err) {
    console.error('Error fetching order by receipt:', err);
    res.status(500).json({ error: err.message });
  }
});

// Partial receipt search (Collection page): match by any part of the receipt number.
// Returns grouped receipt summaries so the user can disambiguate multiple matches.
// Like the exact receipt lookup, receipt numbers are global identifiers — not branch-scoped
// — so we do not apply the user's branch filter here.
router.get('/search/receipt', authenticate, requireReceiptAccess(), async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Query is required' });
  }
  // Do NOT use branch filter — receipt numbers are global identifiers across all branches
  // (same as /receipt/:receiptNumber). Apply it only when explicitly restricting to the
  // user's branch for data-isolation purposes IF the caller is searching a different context.
  const term = `%${q.trim()}%`;
  try {
    const rows = await db.all(
      `SELECT o.receipt_number,
              c.name AS customer_name, c.phone AS customer_phone,
              MIN(o.order_date) AS order_date,
              MIN(o.estimated_collection_date) AS estimated_collection_date,
              (ARRAY_AGG(o.status ORDER BY
                CASE o.status
                  WHEN 'collected' THEN 7
                  WHEN 'ready' THEN 6
                  WHEN 'processing' THEN 5
                  WHEN 'pending' THEN 4
                  WHEN 'sent' THEN 3
                  WHEN 'voided' THEN 2
                  ELSE 1
                END DESC))[1] AS status,
              MAX(o.collected_date) AS collected_date,
              (ARRAY_AGG(o.payment_method ORDER BY o.id DESC))[1] AS payment_method,
              MIN(o.ready_date) AS ready_date,
              SUM(o.total_amount) AS total_amount,
              SUM(o.paid_amount) AS paid_amount,
              COUNT(o.id)::int AS item_count
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE UPPER(o.receipt_number) LIKE UPPER(?)
       GROUP BY o.receipt_number, c.name, c.phone
       ORDER BY MIN(o.id) DESC
       LIMIT 20`,
      [term]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error searching receipts:', err);
    res.status(500).json({ error: err.message });
  }
});

// Staff/manager: request void — appears in admin inbox for approve/decline
router.post('/receipt/:receiptNumber/void-request', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  const { receiptNumber } = req.params;
  const branchFilter = getBranchFilter(req, 'o');
  const acknowledgeReconciledDay = req.body?.acknowledge_reconciled_day === true
    || req.body?.acknowledge_reconciled_day === 'true'
    || req.body?.acknowledge_reconciled_day === 1
    || req.body?.acknowledge_reconciled_day === '1';

  // Admins may still use request flow, but normally void immediately via /void
  try {
    const { item, created } = await createVoidReceiptRequest({
      receiptNumber,
      voidReason: req.body?.void_reason || 'Voided by user',
      requestedBy: req.user?.fullName || req.user?.username || 'User',
      requestedByUserId: req.user?.id,
      branchFilterClause: branchFilter.clause,
      branchFilterParams: branchFilter.params,
      acknowledgeReconciledDay,
    });
    res.status(created ? 201 : 200).json({
      message: created
        ? 'Void request sent to admin inbox for approval'
        : 'A void request for this receipt is already pending admin approval',
      code: 'void_pending_approval',
      item,
    });
  } catch (err) {
    const status = err.status || 500;
    console.error('Error creating void request:', err);
    res.status(status).json({
      error: err.message || 'Failed to create void request',
      code: err.code,
      item: err.inboxItem || undefined,
    });
  }
});

// Admin-only immediate void — also logs an awareness item in the admin inbox
router.post('/receipt/:receiptNumber/void', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  const { receiptNumber } = req.params;
  const branchFilter = getBranchFilter(req, 'o');
  const acknowledgeReconciledDay = req.body?.acknowledge_reconciled_day === true
    || req.body?.acknowledge_reconciled_day === 'true'
    || req.body?.acknowledge_reconciled_day === 1
    || req.body?.acknowledge_reconciled_day === '1';

  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      error: 'Voiding a receipt requires admin approval. Submit a void request instead.',
      code: 'void_requires_approval',
    });
  }

  try {
    await assertNoPendingVoid(receiptNumber);
    const voidedBy = req.user?.fullName || req.user?.username || 'Admin';
    const result = await voidReceiptByNumber(receiptNumber, {
      voidReason: req.body?.void_reason || 'Voided by admin',
      voidedBy,
      acknowledgeReconciledDay,
      branchFilterClause: branchFilter.clause,
      branchFilterParams: branchFilter.params
    });

    try {
      const sample = await db.get(
        `SELECT branch_id FROM orders WHERE UPPER(receipt_number) = UPPER(?) LIMIT 1`,
        [receiptNumber]
      );
      await logAdminExecutedVoid({
        receiptNumber,
        voidReason: req.body?.void_reason || 'Voided by admin',
        voidedBy,
        voidedByUserId: req.user?.id,
        branchId: sample?.branch_id ?? null,
        result,
      });
    } catch (logErr) {
      console.error('Failed to log admin void to inbox:', logErr.message);
    }

    res.json(result);
  } catch (err) {
    if (err.status === 409 && err.code === 'reconciled_day') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    const status = err.status || 500;
    console.error('Error voiding receipt:', err);
    res.status(status).json({ error: err.message || 'Failed to void receipt', code: err.code });
  }
});

// Pending void-request status for a receipt (staff + admin)
router.get('/receipt/:receiptNumber/void-request', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  try {
    const item = await getPendingVoidForReceipt(req.params.receiptNumber);
    res.json({ pending: !!item, item: item || null });
  } catch (err) {
    console.error('Error fetching void request status:', err);
    res.status(500).json({ error: err.message });
  }
});

// List pending void requests visible to this user (branch-scoped; admin sees all or selected branch)
router.get('/void-requests/pending', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  try {
    const branchId = getEffectiveBranchId(req);
    const params = [];
    let branchClause = '';
    if (req.user?.role !== 'admin') {
      if (req.user?.branchId == null) {
        return res.json({ items: [] });
      }
      branchClause = ' AND branch_id = ?';
      params.push(req.user.branchId);
    } else if (branchId != null && branchId !== '') {
      branchClause = ' AND branch_id = ?';
      params.push(Number(branchId));
    }

    const rows = await db.all(
      `SELECT id, title, body, branch_id, branch_name, branch_code, payload,
              requested_by, created_at, action_status, status
       FROM admin_inbox
       WHERE type = 'void_receipt' AND action_status = 'pending'${branchClause}
       ORDER BY created_at DESC
       LIMIT 100`,
      params
    );

    res.json({
      items: (rows || []).map((row) => ({
        ...row,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}),
      })),
    });
  } catch (err) {
    console.error('Error listing pending void requests:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send receipt SMS after order created and receipt printed (customer name, ID, items, amount, status)
router.post('/receipt/:receiptNumber/send-receipt-sms', authenticate, requireBranchAccess(), async (req, res) => {
  const { receiptNumber } = req.params;
  const branchFilter = getBranchFilter(req, 'o');

  try {
    const allOrders = await db.all(
      `SELECT o.*, s.name as service_name,
              c.id as customer_id, c.name as customer_name, c.phone as customer_phone,
              c.sms_notifications_enabled,
              b.code as branch_code
       FROM orders o
       JOIN services s ON o.service_id = s.id
       JOIN customers c ON o.customer_id = c.id
       LEFT JOIN branches b ON o.branch_id = b.id
       WHERE UPPER(o.receipt_number) = UPPER(?)
       ${branchFilter.clause}
       ORDER BY o.id`,
      [receiptNumber, ...branchFilter.params]
    );

    if (!allOrders || allOrders.length === 0) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    const first = allOrders[0];
    const customerId = first.customer_id;
    const customerName = first.customer_name;
    const customerPhone = first.customer_phone;
    const smsEnabled = first.sms_notifications_enabled !== 0;

    if (!customerPhone || isPlaceholderPhone(customerPhone)) {
      return res.status(400).json({ error: 'Customer has no phone number for SMS' });
    }
    if (!smsEnabled) {
      return res.status(400).json({ error: 'SMS notifications are disabled for this customer' });
    }

    const receiptTotal = allOrders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0);
    const paymentStatus = first.payment_status || 'not_paid';

    const itemParts = allOrders.map((o) => {
      const qty = o.quantity || 1;
      const svc = o.service_name || 'Item';
      const extra = [o.color, o.garment_type].filter(Boolean).join(' ');
      return extra ? `${qty}x ${svc} (${extra})` : `${qty}x ${svc}`;
    });
    const itemsDescription = itemParts.join('; ');

    const estimatedDate = first.estimated_collection_date || null;
    const totalReceiptItems = allOrders.reduce((sum, row) => sum + (parseFloat(row.quantity) || 1), 0);
    const customerReceiptId = formatCustomerReceiptId(
      receiptNumber,
      totalReceiptItems,
      first.branch_code
    );
    const message = generateOrderReceiptSms(
      customerReceiptId,
      customerName,
      customerId,
      itemsDescription,
      receiptTotal,
      paymentStatus,
      estimatedDate
    );

    const result = await sendSmsWithWhatsAppFallback(customerPhone, message, {
      customerId,
      orderId: first.id,
      notificationType: 'receipt_sms',
      receiptNumber: String(receiptNumber).trim()
    });

    if (result?.smsSuppressed) {
      return res.json({
        success: true,
        sent: false,
        channel: null,
        preview: message,
        message: 'SMS sending is globally disabled by admin'
      });
    }

    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to send', sent: false });
    }
    if (result.skippedDuplicate) {
      return res.json({
        success: true,
        sent: false,
        skipped_duplicate: true,
        channel: null,
        preview: message,
        message: 'Receipt SMS was already sent recently for this receipt; not sending again.'
      });
    }
    res.json({ success: true, sent: true, channel: result.channel || 'sms', preview: message });
  } catch (err) {
    console.error('Error sending receipt SMS:', err);
    res.status(500).json({ error: err.message });
  }
});

// Search orders by customer phone or name
router.get('/search/customer', authenticate, requireBranchAccess(), async (req, res) => {
  const { phone, name, status } = req.query;
  
  if (!phone && !name) {
    return res.status(400).json({ error: 'Phone number or customer name is required' });
  }

  const branchFilter = getBranchFilter(req, 'o');

  let query = `
    SELECT o.*, s.name as service_name, s.description as service_description,
           c.name as customer_name, c.phone as customer_phone, c.email as customer_email,
           b.name as branch_name,
           b.code as branch_code
    FROM orders o
    JOIN services s ON o.service_id = s.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN branches b ON o.branch_id = b.id
    WHERE 1=1
    ${branchFilter.clause}
  `;
  let params = [...branchFilter.params];

  if (phone) {
    query += ' AND c.phone ILIKE ?';
    params.push(`%${phone}%`);
  }

  if (name) {
    query += ' AND c.name ILIKE ?';
    params.push(`%${name}%`);
  }

  if (status) {
    query += ' AND o.status = ?';
    params.push(status);
  }

  query += ' ORDER BY o.order_date DESC LIMIT 20';

  try {
    const rows = await db.all(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error searching orders by customer:', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate receipt number endpoint (for batch orders)
router.get('/generate-receipt-number', authenticate, requireBranchAccess(), async (req, res) => {
  try {
    const { for_date, branch_id: branchIdParam } = req.query;
    const targetDate = for_date ? new Date(for_date) : new Date();
    if (Number.isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'Invalid for_date. Use ISO date/time format.' });
    }
    const branchId =
      branchIdParam != null && String(branchIdParam).trim() !== ''
        ? parseInt(branchIdParam, 10)
        : getEffectiveBranchId(req);
    if (branchId == null) {
      return res.status(400).json({ error: 'Select a branch to generate a receipt number' });
    }
    const receipt_number = await generateReceiptNumberPromise(targetDate, branchId);
    res.json({ receipt_number });
  } catch (err) {
    return res.status(500).json({ error: 'Error generating receipt number' });
  }
});

// Generate QR code for receipt
router.get('/receipt/:receiptNumber/qrcode', authenticate, requireBranchAccess(), async (req, res) => {
  const { receiptNumber } = req.params;
  
  try {
    const order = await db.get(
      `SELECT o.*, s.name as service_name, s.description as service_description,
              c.name as customer_name, c.phone as customer_phone, c.email as customer_email
       FROM orders o
       JOIN services s ON o.service_id = s.id
       JOIN customers c ON o.customer_id = c.id
       WHERE o.receipt_number = ?
       LIMIT 1`,
      [receiptNumber]
    );
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const customer = {
      name: order.customer_name,
      phone: order.customer_phone,
      email: order.customer_email,
      id: order.customer_id
    };
    
    const service = {
      name: order.service_name,
      description: order.service_description,
      id: order.service_id
    };
    
    const qrCodeDataURL = await generateReceiptQRCode(order, customer, service);
    
    if (qrCodeDataURL) {
      res.json({ qrCode: qrCodeDataURL });
    } else {
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ error: 'Failed to generate QR code: ' + error.message });
  }
});

// Helper function to generate receipt number (uses async version directly)
async function generateReceiptNumberPromise(targetDate = new Date(), branchId = null) {
  const { generateReceiptNumberAsync } = require('../utils/receipt');
  return generateReceiptNumberAsync(targetDate, branchId);
}

const IDEMPOTENCY_ROUTE_ORDERS_BATCH = 'POST /api/orders/batch';
const IDEMPOTENCY_ROUTE_ORDERS = 'POST /api/orders';

/**
 * Create a multi-line receipt in one atomic request (one receipt number, all items).
 * Prevents duplicate lines and wrong totals when several cashiers work at once.
 */
router.post('/batch', authenticate, requireBranchAccess(), requirePermission('canCreateOrders'), async (req, res) => {
  const idempotencyKey = readIdempotencyKey(req);
  if (idempotencyKey) {
    pruneExpiredIdempotencyKeys().catch(() => {});
    const cached = await getStoredIdempotencyResponse(IDEMPOTENCY_ROUTE_ORDERS_BATCH, idempotencyKey);
    if (cached) {
      return res.status(cached.status).json(cached.body);
    }
  }

  const moment = require('moment');
  const client = await db.getPool().connect();
  try {
    const {
      customer_id,
      items,
      order_date,
      estimated_collection_date,
      payment_status,
      payment_method,
      created_by,
      branch_id,
      receipt_number: manualReceipt,
    } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items must be a non-empty array' });
    }

    const parsedOrderDate = order_date ? new Date(order_date) : new Date();
    if (Number.isNaN(parsedOrderDate.getTime())) {
      return res.status(400).json({ error: 'Invalid order_date. Use ISO date/time format.' });
    }
    if (!assertNotFutureBusinessDate(parsedOrderDate, res, 'order_date')) {
      return;
    }
    const finalOrderDateIso = parsedOrderDate.toISOString();
    const day = String(parsedOrderDate.getDate()).padStart(2, '0');
    const month = String(parsedOrderDate.getMonth() + 1).padStart(2, '0');
    const dateStr = moment(parsedOrderDate).format('YYYY-MM-DD');

    const orderBranchId =
      req.user.role === 'admin'
        ? branch_id || req.user?.branchId || null
        : req.user?.branchId || null;

    const customer = await db.get('SELECT * FROM customers WHERE id = ?', [customer_id]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    let branchName = null;
    let branchCode = null;
    if (orderBranchId) {
      const branchRow = await db.get('SELECT name, code FROM branches WHERE id = ?', [orderBranchId]).catch(() => null);
      branchName = branchRow?.name || null;
      branchCode = branchRow?.code || null;
    }

    await client.query('BEGIN');

    const trimmedManual = String(manualReceipt || '').trim();
    let sharedReceiptNumber = trimmedManual || null;
    if (!sharedReceiptNumber) {
      const prefix = orderBranchId != null ? await getBranchReceiptPrefix(orderBranchId) : null;
      const sequence = await allocateBranchReceiptSequence(
        orderBranchId,
        prefix,
        day,
        month,
        dateStr,
        client
      );
      sharedReceiptNumber =
        prefix && orderBranchId != null
          ? buildPrefixedReceiptNumber(prefix, sequence, day, month)
          : `${sequence}-${day}-${month}`;
    }

    const results = [];
    for (const line of items) {
      const service_id = line.service_id;
      if (!service_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Each item requires service_id' });
      }

      const serviceResult = await client.query('SELECT * FROM services WHERE id = $1', [service_id]);
      const service = serviceResult.rows[0];
      if (!service) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Service not found: ${service_id}` });
      }

      let expressMultiplier = line.express_surcharge_multiplier || 0;
      const delivery_type = line.delivery_type || 'standard';
      if (delivery_type && !expressMultiplier) {
        const settingsResult = await client.query(
          `SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('express_same_day_multiplier', 'express_next_day_multiplier')`
        );
        const settings = settingsResult.rows || [];
        if (delivery_type === 'same_day') {
          const setting = settings.find((s) => s.setting_key === 'express_same_day_multiplier');
          expressMultiplier = setting ? parseFloat(setting.setting_value) : 2;
        } else if (delivery_type === 'next_day') {
          const setting = settings.find((s) => s.setting_key === 'express_next_day_multiplier');
          expressMultiplier = setting ? parseFloat(setting.setting_value) : 3;
        }
      }

      let final_total_amount = line.total_amount;
      if (final_total_amount === undefined || final_total_amount === null) {
        final_total_amount = calculateTotal(
          service,
          line.quantity || 1,
          line.weight_kg || 0,
          delivery_type,
          expressMultiplier
        );
      } else {
        final_total_amount = parseFloat(final_total_amount) || 0;
      }

      const linePaid = line.paid_amount !== undefined ? parseFloat(line.paid_amount) || 0 : 0;
      const linePaymentStatus = line.payment_status || payment_status || 'not_paid';
      const linePaymentMethod = line.payment_method || payment_method || 'cash';

      const validation = validatePayment(
        {
          paid_amount: linePaid,
          payment_status: linePaymentStatus,
          payment_method: linePaymentMethod,
        },
        final_total_amount
      );
      if (!validation.valid) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: validation.error });
      }

      const insertResult = await client.query(
        `INSERT INTO orders (
          receipt_number, customer_id, service_id, quantity, weight_kg, color, garment_type,
          special_instructions, delivery_type, express_surcharge_multiplier, total_amount,
          paid_amount, payment_status, payment_method, created_by, order_date,
          estimated_collection_date, branch_id, item_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING id`,
        [
          sharedReceiptNumber,
          customer_id,
          service_id,
          line.quantity || 1,
          line.weight_kg || null,
          line.color || null,
          line.garment_type || null,
          line.special_instructions || null,
          delivery_type,
          expressMultiplier,
          final_total_amount,
          linePaid,
          linePaymentStatus,
          linePaymentMethod,
          created_by || null,
          finalOrderDateIso,
          estimated_collection_date || null,
          orderBranchId,
          line.item_id ? parseInt(line.item_id, 10) : null,
        ]
      );

      const orderId = insertResult.rows[0].id;
      const order = {
        id: orderId,
        receipt_number: sharedReceiptNumber,
        branch_id: orderBranchId,
        branch_name: branchName,
        branch_code: branchCode,
        customer_id,
        service_id,
        quantity: line.quantity || 1,
        weight_kg: line.weight_kg || null,
        color: line.color || null,
        garment_type: line.garment_type || null,
        special_instructions: line.special_instructions || null,
        delivery_type,
        express_surcharge_multiplier: expressMultiplier,
        total_amount: final_total_amount,
        paid_amount: linePaid,
        payment_status: linePaymentStatus,
        payment_method: linePaymentMethod,
        status: 'pending',
        order_date: finalOrderDateIso,
        estimated_collection_date: estimated_collection_date || null,
      };

      if (linePaid > 0 && linePaymentStatus === 'advance') {
        await recordPaymentTransactionClient(
          client,
          order,
          linePaid,
          linePaymentMethod,
          created_by || 'System',
          finalOrderDateIso
        );
      }

      await logPaymentChangeClient(client, {
        order_id: orderId,
        action: 'created',
        new_payment_status: linePaymentStatus,
        new_paid_amount: linePaid,
        new_payment_method: linePaymentMethod,
        changed_by: created_by || 'System',
        notes: 'Order created (batch)',
      });

      results.push({
        order,
        receipt: formatReceipt(order, customer, service),
        customer,
        service,
      });
    }

    await client.query('COMMIT');
    const payload = {
      receipt_number: sharedReceiptNumber,
      items: results,
    };
    if (orderBranchId != null) {
      cashManagement.scheduleBackgroundDailySummaryRefresh(paymentBookDateYmd(finalOrderDateIso), orderBranchId).catch(err => {
        console.error('BACKGROUND: daily summary refresh failed (batch):', err.message);
      });
    }
    if (idempotencyKey) {
      await storeIdempotencyResponse(IDEMPOTENCY_ROUTE_ORDERS_BATCH, idempotencyKey, 200, payload);
    }
    res.json(payload);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      console.error('ERROR: orders batch ROLLBACK failed:', rbErr.message);
    }
    console.error('POST /api/orders/batch error:', err);
    res.status(500).json({ error: err.message || 'Failed to create batch order' });
  } finally {
    client.release();
  }
});

// Create new order (cashiers, managers, and admins can create)
router.post('/', authenticate, requireBranchAccess(), requirePermission('canCreateOrders'), async (req, res) => {
  try {
    const idempotencyKey = readIdempotencyKey(req);
    if (idempotencyKey) {
      pruneExpiredIdempotencyKeys().catch(() => {});
      const cached = await getStoredIdempotencyResponse(IDEMPOTENCY_ROUTE_ORDERS, idempotencyKey);
      if (cached) {
        return res.status(cached.status).json(cached.body);
      }
    }

    console.log('POST /api/orders - Request received');
    console.log('User:', req.user?.username, 'Role:', req.user?.role, 'BranchId:', req.user?.branchId);
    
    const {
      customer_id,
      service_id,
      quantity,
      weight_kg,
      color,
      special_instructions,
      delivery_type,
      express_surcharge_multiplier,
      total_amount, // Optional: if provided, use this total (for items with custom pricing)
      paid_amount,
      payment_status,
      payment_method,
      created_by,
      receipt_number, // Optional: if provided, use this receipt number (for batch orders)
      estimated_collection_date, // Estimated collection date/time
      order_date, // Optional: supports backdated/new receipt date
      branch_id // Optional: for admins to specify which branch to create the order for
    } = req.body;
    const parsedOrderDate = order_date ? new Date(order_date) : new Date();
    if (Number.isNaN(parsedOrderDate.getTime())) {
      return res.status(400).json({ error: 'Invalid order_date. Use ISO date/time format.' });
    }
    if (!assertNotFutureBusinessDate(parsedOrderDate, res, 'order_date')) {
      return;
    }
    const finalOrderDateIso = parsedOrderDate.toISOString();


    console.log('Order data:', { customer_id, service_id, quantity, payment_status, branch_id });

    if (!customer_id || !service_id) {
      return res.status(400).json({ error: 'Customer ID and Service ID are required' });
    }

    // Get service details and settings to calculate total
    console.log('Fetching service with id:', service_id);
    const service = await db.get('SELECT * FROM services WHERE id = ?', [service_id]);
    
    if (!service) {
      console.error('Service not found with id:', service_id);
      return res.status(404).json({ error: 'Service not found' });
    }
    console.log('Service found:', service.name);

    // Get express multipliers from settings if not provided
    let expressMultiplier = express_surcharge_multiplier || 0;
    if (delivery_type && !expressMultiplier) {
      try {
        const settings = await db.all('SELECT setting_key, setting_value FROM settings WHERE setting_key IN (?, ?)', 
          ['express_same_day_multiplier', 'express_next_day_multiplier']);
        
        if (settings && settings.length > 0) {
          if (delivery_type === 'same_day') {
            const setting = settings.find(s => s.setting_key === 'express_same_day_multiplier');
            expressMultiplier = setting ? parseFloat(setting.setting_value) : 2;
          } else if (delivery_type === 'next_day') {
            const setting = settings.find(s => s.setting_key === 'express_next_day_multiplier');
            expressMultiplier = setting ? parseFloat(setting.setting_value) : 3;
          }
        }
      } catch (settingsErr) {
        console.error('Error fetching express multipliers:', settingsErr);
        // Use defaults if settings fetch fails
      }
    }

    // Helper function to create order (with retry logic)
    const createOrder = async (receiptNumberToUse = null, retryCount = 0) => {
      const orderBranchId =
        req.user.role === 'admin'
          ? branch_id || req.user?.branchId || null
          : req.user?.branchId || null;

      // Use provided total_amount if available (for items with custom pricing), otherwise calculate it
      let final_total_amount = total_amount;
      if (final_total_amount === undefined || final_total_amount === null) {
        // Calculate total with express surcharge using service pricing
        final_total_amount = calculateTotal(service, quantity || 1, weight_kg || 0, delivery_type || 'standard', expressMultiplier);
      } else {
        // Ensure it's a number
        final_total_amount = parseFloat(final_total_amount) || 0;
      }
      
      // Validate payment data
      const paymentData = {
        paid_amount: paid_amount !== undefined ? paid_amount : (payment_status === 'paid_full' ? final_total_amount : 0),
        payment_status: payment_status || 'not_paid',
        payment_method: payment_method || 'cash'
      };
      
      const validation = validatePayment(paymentData, final_total_amount);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      
      const insertOrder = async (receiptNumberToInsert) => {
        const finalReceiptNumber = receiptNumberToInsert || receipt_number;
        const final_paid_amount = paymentData.paid_amount;
        
        // Insert order
        // For admins: use branch_id from request body if provided, otherwise use user's branchId
        // For regular users: use their branchId (requireBranchAccess ensures they have one)
        const branchId = orderBranchId;
        
        console.log('Creating order with branchId:', branchId, 'for user:', req.user.username, 'role:', req.user.role);
        
        try {
          const result = await db.run(
            `INSERT INTO orders (receipt_number, customer_id, service_id, quantity, 
              weight_kg, color, garment_type, special_instructions, delivery_type, express_surcharge_multiplier, total_amount, paid_amount, payment_status, payment_method, created_by, order_date, estimated_collection_date, branch_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [finalReceiptNumber, customer_id, service_id,
              quantity || 1, weight_kg || null, color || null, req.body.garment_type || null, special_instructions || null,
              delivery_type || 'standard', expressMultiplier,
              final_total_amount, final_paid_amount, payment_status || 'not_paid', payment_method || 'cash', created_by || null, finalOrderDateIso, estimated_collection_date || null, branchId]
          );
          const orderId = result.lastID;

          const orderObj = {
            id: orderId,
            receipt_number: finalReceiptNumber,
            branch_id: branchId
          };

          // Record transaction for advances only. paid_full at order entry is counted in daily
          // cash_sales (orders); logging payment_received here too would double-count book_sales.
          if (final_paid_amount > 0 && payment_status === 'advance') {
            recordPaymentTransaction(orderObj, final_paid_amount, payment_method || 'cash', created_by || 'System')
              .then((transactionId) => {
                console.log(`OK:  Payment transaction recorded: Transaction ID ${transactionId} for Order ${orderId}`);
              })
              .catch((err) => {
                console.error('Error recording payment transaction:', err);
              });
          }

          // Log payment creation to audit log (awaited: a void with no audit trail is worse than a slow response)
          try {
            await logPaymentChange({
            order_id: orderId,
            action: 'created',
            new_payment_status: payment_status || 'not_paid',
            new_paid_amount: final_paid_amount,
            new_payment_method: payment_method || 'cash',
            changed_by: created_by || 'System',
            notes: 'Order created'
            });
          } catch (err) {
            console.error('Error logging payment change:', err);
          }

          if (branchId != null) {
            cashManagement.scheduleBackgroundDailySummaryRefresh(paymentBookDateYmd(finalOrderDateIso), branchId).catch(err => {
              console.error('BACKGROUND: daily summary refresh failed (single):', err.message);
            });
          }

          // Get customer details for receipt
          const customer = await db.get('SELECT * FROM customers WHERE id = ?', [customer_id]);
          let branchName = null;
          let branchCode = null;
          if (branchId) {
            const branchRow = await db
              .get('SELECT name, code FROM branches WHERE id = ?', [branchId])
              .catch(() => null);
            branchName = branchRow?.name || null;
            branchCode = branchRow?.code || null;
          }
          const order = {
            id: orderId,
            receipt_number: finalReceiptNumber,
            branch_id: branchId,
            branch_name: branchName,
            branch_code: branchCode,
            customer_id,
            service_id,
            quantity: quantity || 1,
            weight_kg,
            color: color || null,
            garment_type: req.body.garment_type || null,
            special_instructions,
            delivery_type: delivery_type || 'standard',
            express_surcharge_multiplier: expressMultiplier,
            total_amount: final_total_amount,
            paid_amount: final_paid_amount,
            payment_status: payment_status || 'not_paid',
            payment_method: payment_method || 'cash',
            status: 'pending',
            order_date: finalOrderDateIso,
            estimated_collection_date: estimated_collection_date || null
          };

          const receipt = formatReceipt(order, customer, service);

          // Only one SMS after receipt: sent by client after printing (POST /orders/receipt/:receiptNumber/send-receipt-sms).
          // No duplicate order-confirmation SMS here.

          const payload = {
            order,
            receipt,
            customer,
            service
          };
          if (idempotencyKey) {
            await storeIdempotencyResponse(IDEMPOTENCY_ROUTE_ORDERS, idempotencyKey, 200, payload);
          }
          res.json(payload);
        } catch (insertErr) {
          // Log the full error for debugging
          console.error('Order insertion error:', {
            error: insertErr.message,
            code: insertErr.code,
            receiptNumber: finalReceiptNumber,
            retryCount: retryCount
          });
          
          // Handle UNIQUE constraint error (duplicate receipt number) by retrying
          // NOTE: We removed UNIQUE constraint from receipt_number to allow multiple items per receipt
          // But if it still exists (old database), we'll handle it here
          const errorMsg = insertErr.message || '';
          const errorCode = insertErr.code || '';
          const isUniqueError = (errorMsg.includes('UNIQUE constraint failed') || 
                                errorMsg.includes('SQLITE_CONSTRAINT') ||
                                errorMsg.includes('UNIQUE constraint') ||
                                errorCode === 'SQLITE_CONSTRAINT_UNIQUE' ||
                                errorCode === 'SQLITE_CONSTRAINT') && 
                               (errorMsg.includes('receipt_number') || errorMsg.includes('receipt') || errorMsg.includes('orders'));
          
          if (isUniqueError && retryCount < 5) {
            console.log(`Duplicate receipt number detected: ${finalReceiptNumber}. Retrying (attempt ${retryCount + 1}/5)...`);
            // Retry with a new receipt number
            try {
              const newReceiptNumber = await generateReceiptNumberPromise(parsedOrderDate, orderBranchId);
              console.log(`Generated new receipt number for retry: ${newReceiptNumber}`);
              return createOrder(newReceiptNumber, retryCount + 1);
            } catch (receiptErr) {
              console.error('Error generating receipt number after retry:', receiptErr);
              return res.status(500).json({ error: 'Error generating receipt number after retry: ' + receiptErr.message });
            }
          }
          
          // If we've exhausted retries or it's a non-unique error
          if (isUniqueError && retryCount >= 5) {
            console.error(`Failed after ${retryCount} retries. Receipt number: ${finalReceiptNumber}`);
            return res.status(500).json({ 
              error: 'Duplicate receipt number detected. Please contact administrator.',
              details: `Receipt: ${finalReceiptNumber}, Retries: ${retryCount}. Error: ${errorMsg}`
            });
          }
          
          // Return the actual error for non-unique errors
          return res.status(500).json({ 
            error: insertErr.message,
            code: errorCode
          });
        }
      };

      // If receipt number was provided in request (for batch orders), use it directly
      if (receipt_number) {
        await insertOrder(receipt_number);
      }
      // If receipt number was provided as parameter (for retry), use it
      else if (receiptNumberToUse) {
        await insertOrder(receiptNumberToUse);
      } else {
        // Generate receipt number based on requested order date (for backdated orders)
        try {
          const generatedReceiptNumber = await generateReceiptNumberPromise(parsedOrderDate, orderBranchId);
          await insertOrder(generatedReceiptNumber);
        } catch (receiptErr) {
          return res.status(500).json({ error: 'Error generating receipt number: ' + receiptErr.message });
        }
      }
    };

    // Call createOrder to start the process
    await createOrder();
  } catch (error) {
    console.error('Error in order creation route:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Update order status (managers, processors, and admins can update)
router.put('/:id/status', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'processing', 'ready', 'collected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    // Verify user has access: match by branch, or allow orders with null branch_id (legacy) and assign to current branch
    const branchFilter = getBranchFilter(req, 'o');
    let order = await db.get(
      `SELECT o.id, o.total_amount, o.paid_amount, o.branch_id, o.is_voided, o.archived_at, o.receipt_number FROM orders o WHERE o.id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );
    if (!order && (branchFilter.clause || branchFilter.params?.length)) {
      order = await db.get('SELECT id, total_amount, paid_amount, branch_id, is_voided, archived_at, receipt_number FROM orders WHERE id = ?', [id]);
      if (order && order.branch_id != null) {
        return res.status(403).json({ error: 'Order belongs to another branch. You can only update orders for your branch.' });
      }
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found or access denied' });
    }
    if (order.is_voided) {
      return res.status(400).json({ error: 'Cannot update a voided order' });
    }
    if (order.archived_at) {
      return res.status(400).json({ error: 'Cannot update an archived order' });
    }

    if (order.receipt_number) {
      const pendingVoid = await getPendingVoidForReceipt(order.receipt_number);
      if (pendingVoid) {
        return res.status(409).json({
          error: 'This receipt has a void request awaiting admin approval',
          code: 'void_pending',
        });
      }
    }

    // Cannot mark as collected without payment
    if (status === 'collected') {
      const total = roundMoney(parseFloat(order.total_amount) || 0);
      const paid = roundMoney(parseFloat(order.paid_amount) || 0);
      const balanceDue = roundMoney(total - paid);
      if (balanceDue > 0) {
        return res.status(400).json({
          error: 'Cannot mark as collected without payment. Receive payment first (Pay button) or use the Collection page to collect with payment.'
        });
      }
    }

    // User has access, proceed with update
    const branchId = req.user?.branchId;
    let updateQuery = 'UPDATE orders SET status = ?';
    const params = [status];
    // If order had no branch (legacy), assign it to current user's branch
    if (order.branch_id == null && branchId != null) {
      updateQuery += ', branch_id = ?';
      params.push(branchId);
    }
    // Branch-audit columns: prefer the acting user's branch; admins acting
    // cross-branch fall back to the effective branch so the trail is never NULL.
    const atBranchId = branchId != null ? branchId : getEffectiveBranchId(req) || order.branch_id;
    if (status === 'ready') {
      updateQuery += ', ready_date = CURRENT_TIMESTAMP';
      if (atBranchId != null) {
        updateQuery += ', ready_at_branch_id = ?';
        params.push(atBranchId);
      }
    }
    if (status === 'collected') {
      updateQuery += ', collected_date = CURRENT_TIMESTAMP';
      if (atBranchId != null) {
        updateQuery += ', collected_at_branch_id = ?';
        params.push(atBranchId);
      }
    }
    updateQuery += ' WHERE id = ?';
    params.push(id);
    
    const result = await db.run(updateQuery, params);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // Send SMS notification when order becomes ready
    if (status === 'ready') {
      try {
        const orderWithCustomer = await db.get(
          `SELECT o.*, c.name as customer_name, c.phone as customer_phone, 
                  c.sms_notifications_enabled
           FROM orders o
           JOIN customers c ON o.customer_id = c.id
           WHERE o.id = ?`,
          [id]
        );
        
        if (orderWithCustomer) {
          // Check if customer has SMS notifications enabled (default to true if null)
          const smsEnabled = orderWithCustomer.sms_notifications_enabled !== 0;
          
          if (smsEnabled && orderWithCustomer.customer_phone && !isPlaceholderPhone(orderWithCustomer.customer_phone)) {
            // Send one ready notification per receipt (not per item)
            const otherReadyItems = await db.get(
              `SELECT id
               FROM orders
               WHERE UPPER(receipt_number) = UPPER(?)
                 AND customer_id = ?
                 AND id <> ?
                 AND status IN ('ready', 'collected')
               LIMIT 1`,
              [orderWithCustomer.receipt_number, orderWithCustomer.customer_id, orderWithCustomer.id]
            );

            if (!otherReadyItems) {
              const receiptSums = await db.get(
                `SELECT 
                   COALESCE(SUM(total_amount), 0) as receipt_total_amount,
                   COALESCE(SUM(paid_amount), 0) as receipt_paid_amount
                 FROM orders
                 WHERE UPPER(receipt_number) = UPPER(?)
                   AND customer_id = ?`,
                [orderWithCustomer.receipt_number, orderWithCustomer.customer_id]
              );
              const totalAmount = parseFloat(receiptSums?.receipt_total_amount || 0);
              const paidAmount = parseFloat(receiptSums?.receipt_paid_amount || 0);
              const balanceDue = Math.max(0, totalAmount - paidAmount);
              const daysOverdue = daysOverdueFromEstimated(orderWithCustomer.estimated_collection_date);
              const message = generateCollectionReminder(
                orderWithCustomer.receipt_number,
                orderWithCustomer.customer_name,
                daysOverdue,
                balanceDue
              );
              
              // Try SMS first; if SMS fails, send via WhatsApp (don't block the response)
              sendSmsWithWhatsAppFallback(orderWithCustomer.customer_phone, message, {
                customerId: orderWithCustomer.customer_id,
                orderId: orderWithCustomer.id,
                notificationType: 'ready',
                receiptNumber: orderWithCustomer.receipt_number
              }).then(result => {
                if (result.skippedDuplicate) {
                  console.log(`SMS:  Ready SMS skipped (duplicate window) for receipt ${orderWithCustomer.receipt_number}`);
                } else if (result?.smsSuppressed) {
                  console.log(
                    `SMS:  Ready SMS suppressed (globally disabled) for receipt ${orderWithCustomer.receipt_number}`
                  );
                } else if (result.success) {
                  console.log(`OK:  Ready notification sent via ${result.channel || 'sms'} to ${orderWithCustomer.customer_phone} for receipt ${orderWithCustomer.receipt_number}`);
                } else {
                  console.error(`ERROR:  Failed to send to ${orderWithCustomer.customer_phone}:`, result.error);
                }
              }).catch(err => {
                console.error(`ERROR:  Error sending ready notification:`, err);
              });
            } else {
              console.log(`MAIL:  Ready notification already sent for receipt ${orderWithCustomer.receipt_number}; skipping duplicate.`);
            }
          } else if (!smsEnabled) {
            console.log(`SMS:  SMS notifications disabled for customer ${orderWithCustomer.customer_name}`);
          }
        }
      } catch (smsErr) {
        console.error('Error fetching order for SMS:', smsErr);
        // Don't fail the status update if SMS fetch fails
      }
    }
    
    res.json({ message: 'Order status updated successfully' });
  } catch (err) {
    console.error('Error updating order status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update estimated collection date (managers, processors, and admins can update)
router.put('/:id/estimated-collection-date', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  const { id } = req.params;
  const { estimated_collection_date } = req.body;

  if (!estimated_collection_date) {
    return res.status(400).json({ error: 'Estimated collection date is required' });
  }

  try {
    // Verify user has access to this order
    const branchFilter = getBranchFilter(req, 'o');
    const order = await db.get(
      `SELECT o.id, o.is_voided, o.archived_at FROM orders o WHERE o.id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found or access denied' });
    }
    if (order.is_voided) {
      return res.status(400).json({ error: 'Cannot update a voided order' });
    }
    if (order.archived_at) {
      return res.status(400).json({ error: 'Cannot update an archived order' });
    }

    const result = await db.run(
        'UPDATE orders SET estimated_collection_date = ? WHERE id = ?',
        [estimated_collection_date, id]
      );
      
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      
      res.json({ message: 'Estimated collection date updated successfully' });
  } catch (err) {
    console.error('Error updating estimated collection date:', err);
    res.status(500).json({ error: err.message });
  }
});

// Collect order (by receipt number) with optional payment (cashiers, managers, processors, and admins can collect)
// This endpoint handles ALL items on a receipt together - collects the entire receipt, not individual items
router.post('/collect/:receiptNumber', authenticate, requireBranchFeature('collection'), requireBranchAccess(), requireAnyPermission('canCollect', 'canManageOrders'), async (req, res) => {
  const { receiptNumber } = req.params;
  const { payment_amount, payment_method = 'cash', payment_date, notes } = req.body;

  try {
    const pendingVoid = await getPendingVoidForReceipt(receiptNumber);
    if (pendingVoid) {
      return res.status(409).json({
        error: 'This receipt has a void request awaiting admin approval',
        code: 'void_pending',
      });
    }

    const branchFilter = getBranchFilter(req, 'o');
    const payAmount =
      payment_amount !== undefined && payment_amount > 0 ? roundMoney(parseFloat(payment_amount)) : 0;

    if (payAmount > 0 && !assertNotFutureBusinessDate(paymentBookDateYmd(payment_date), res, 'payment_date')) {
      return;
    }

    const paymentTimestampIso = buildPaymentTimestampIso(payment_date);
    const txResult = await applyReceiptPaymentAtomic({
      receiptNumber,
      branchFilter,
      paymentAmount: payAmount,
      paymentMethod: payment_method,
      paymentTimestampIso,
      notes,
      changedBy: 'Cashier',
      collect: true,
    });

    if (!txResult.ok) {
      return res.status(txResult.status).json({ error: txResult.error });
    }

    const { firstOrder, receiptTotal, receiptPaid, paymentAmount, transactionId, itemCount } = txResult.data;
    if (transactionId) {
      console.log(`OK:  Payment transaction recorded: Transaction ID ${transactionId} for Receipt ${receiptNumber}`);
      triggerDailySummaryRefreshAsync(paymentTimestampIso.slice(0, 10), firstOrder.branch_id);
    }

    if (txResult.data.receiptPaymentStatus === 'paid_full' && receiptTotal > 0) {
      try {
        const { awardPointsOnCollection } = require('./loyalty');
        const loyaltyResult = await awardPointsOnCollection(firstOrder.customer_id, firstOrder.id, receiptTotal);
        console.log(
          `OK:  Loyalty points awarded: ${loyaltyResult?.points_earned ?? 0} points to customer ${firstOrder.customer_id}`
        );
      } catch (err) {
        console.error('Error awarding loyalty points:', err);
      }
    }

    const updatedOrders = await db.all(
      `SELECT o.*, s.name as service_name, c.name as customer_name, c.phone as customer_phone,
              i.name as item_name, i.category as item_category
       FROM orders o
       JOIN services s ON o.service_id = s.id
       JOIN customers c ON o.customer_id = c.id
       LEFT JOIN items i ON o.item_id = i.id
       WHERE UPPER(o.receipt_number) = UPPER(?)
       ${branchFilter.clause}
       ORDER BY o.id`,
      [receiptNumber, ...branchFilter.params]
    );

    const finalReceiptTotal = updatedOrders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0);
    const finalReceiptPaid = updatedOrders.reduce((sum, o) => sum + (parseFloat(o.paid_amount) || 0), 0);
    const mainOrder = {
      ...updatedOrders[0],
      total_amount: finalReceiptTotal,
      paid_amount: finalReceiptPaid,
      receipt_item_count: updatedOrders.length,
    };

    res.json({
      message: `Receipt collected successfully (${itemCount} ${itemCount === 1 ? 'item' : 'items'})`,
      order: mainOrder,
      all_orders: updatedOrders,
      payment_collected: paymentAmount,
      balance_remaining: finalReceiptTotal - finalReceiptPaid,
      receipt_total: finalReceiptTotal,
      receipt_paid: finalReceiptPaid,
    });
  } catch (err) {
    console.error('Error collecting order:', err);
    res.status(500).json({ error: err.message });
  }
});

// Receive payment for an order (without collecting) - uses RECEIPT-level totals for multi-item receipts
router.post('/:id/receive-payment', authenticate, requireBranchAccess(), requirePermission('canManageCash'), async (req, res) => {
  // NOTE: :id is the numeric order id (client sends order.id); the payment itself applies receipt-wide via applyReceiptPaymentAtomic.
  const { id } = req.params;
  const { payment_amount, payment_method = 'cash', payment_date, notes } = req.body;

  if (!payment_amount || payment_amount <= 0) {
    return res.status(400).json({ error: 'Payment amount must be greater than 0' });
  }

  const branchFilter = getBranchFilter(req, 'o');

  try {
    const order = await db.get(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = ? ${branchFilter.clause}`,
      [id, ...branchFilter.params]
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.is_voided) {
      return res.status(400).json({ error: 'Cannot receive payment for a voided receipt' });
    }
    if (order.archived_at) {
      return res.status(400).json({ error: 'Cannot receive payment for an archived receipt' });
    }

    if (order.receipt_number) {
      const pendingVoid = await getPendingVoidForReceipt(order.receipt_number);
      if (pendingVoid) {
        return res.status(409).json({
          error: 'This receipt has a void request awaiting admin approval',
          code: 'void_pending',
        });
      }
    }

    if (!assertNotFutureBusinessDate(paymentBookDateYmd(payment_date), res, 'payment_date')) {
      return;
    }

    const paymentTimestampIso = buildPaymentTimestampIso(payment_date);
    const txResult = await applyReceiptPaymentAtomic({
      receiptNumber: order.receipt_number,
      branchFilter,
      paymentAmount: roundMoney(parseFloat(payment_amount)),
      paymentMethod: payment_method,
      paymentTimestampIso,
      notes,
      changedBy: 'Cashier',
      collect: false,
    });

    if (!txResult.ok) {
      return res.status(txResult.status).json({ error: txResult.error });
    }

    const { receiptTotal, receiptPaid, paymentAmount, transactionId, itemCount } = txResult.data;
    if (transactionId) {
      console.log(
        `OK:  Payment transaction recorded: Transaction ID ${transactionId} for Receipt ${order.receipt_number} (${itemCount} items)`
      );
      triggerDailySummaryRefreshAsync(paymentTimestampIso.slice(0, 10), order.branch_id);
    }

    res.json({
      message: 'Payment received successfully',
      order: { ...order, total_amount: receiptTotal, paid_amount: receiptPaid, receipt_item_count: itemCount },
      payment_received: paymentAmount,
      total_paid: receiptPaid,
      balance_remaining: txResult.data.balanceRemaining,
      receipt_total: receiptTotal,
      receipt_item_count: itemCount,
    });
  } catch (err) {
    console.error('Error receiving payment:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Derive order_date from receipt / CUST ID (the printed receipt day — same rules as POS).
 * - Full: {seq}-{DD}-{MM} ({YY}) e.g. 15-15-03 (26) → 15 Mar 2026
 * - Compact: {seq}-{DD}-{MM} e.g. 9-7-12 → 7 Dec (year inferred so cash reports stay sane)
 */
function deriveOrderDateFromReceiptId(receiptId) {
  const parsed = parseReceiptNumber(receiptId);
  const raw = parsed.core || String(receiptId || '').trim();
  if (!raw) return null;
  const withYear = raw.match(/^(\d+)-(\d{1,2})-(\d{1,2})\s*\((\d{2})\)\s*$/);
  if (withYear) {
    const dd = parseInt(withYear[2], 10);
    const mm = parseInt(withYear[3], 10);
    const yy = parseInt(withYear[4], 10);
    if (Number.isNaN(yy) || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const fullYear = yy < 100 ? (yy >= 70 ? 1900 + yy : 2000 + yy) : yy;
    const d = new Date(Date.UTC(fullYear, mm - 1, dd, 12, 0, 0));
    if (d.getUTCFullYear() !== fullYear || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
    return dateToOrderTimestampIso(d);
  }
  const noYear = raw.match(/^(\d+)-(\d{1,2})-(\d{1,2})$/);
  if (noYear) {
    const dd = parseInt(noYear[2], 10);
    const mm = parseInt(noYear[3], 10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const now = new Date();
    let fullYear = now.getUTCFullYear();
    let d = new Date(Date.UTC(fullYear, mm - 1, dd, 12, 0, 0));
    if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
    const twoDaysAhead = now.getTime() + 2 * 86400000;
    if (d.getTime() > twoDaysAhead) {
      fullYear -= 1;
      d = new Date(Date.UTC(fullYear, mm - 1, dd, 12, 0, 0));
    }
    if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
    return dateToOrderTimestampIso(d);
  }
  return null;
}

function dateToOrderTimestampIso(d) {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}T12:00:00.000Z`;
}

function getYesterdayNoonUtcIso() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return dateToOrderTimestampIso(d);
}

/** Collection due date = receipt/received day + this many days (e.g. 3 days to collect). */
const COLLECTION_DUE_AFTER_RECEIPT_DAYS = 3;

function addUtcDaysToOrderIso(orderDateIso, daysToAdd) {
  const d = new Date(orderDateIso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return d.toISOString();
}

// Add or update customer phone from Orders screen (managers with canManageOrders)
router.patch('/customer/:customerId/phone', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  const { customerId } = req.params;
  const { phone } = req.body;

  if (!phone || !String(phone).trim()) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  const trimmedPhone = String(phone).trim();
  if (isPlaceholderPhone(trimmedPhone)) {
    return res.status(400).json({ error: 'Enter a valid phone number' });
  }

  try {
    const customer = await db.get('SELECT id, name, phone FROM customers WHERE id = ?', [customerId]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const normalized = normalizePhoneDigits(trimmedPhone);
    const existing = await db.get(
      `SELECT id FROM customers
       WHERE id != ?
         AND (
           phone = ?
           OR phone = ?
           OR TRIM(phone) = ?
           OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
         )
       LIMIT 1`,
      [customerId, trimmedPhone, normalized, trimmedPhone, normalized.replace(/\D/g, '')]
    );
    if (existing) {
      return res.status(400).json({ error: 'Phone number already in use by another customer' });
    }

    await db.run(
      'UPDATE customers SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [trimmedPhone, customerId]
    );

    res.json({ message: 'Phone updated successfully', customer_id: Number(customerId), phone: trimmedPhone });
  } catch (err) {
    if (err.message && (err.message.includes('UNIQUE') || err.message.includes('customers_phone_key'))) {
      return res.status(400).json({ error: 'Phone number already in use by another customer' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Upload Excel file and import stock/orders
router.post('/upload-stock-excel', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filePath = req.file.path;
  let data = [];

  const normalizeCellValue = (value) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      // ExcelJS may return rich objects for formulas/rich-text/hyperlinks.
      if (value.text != null) return String(value.text).trim();
      if (value.result != null) return String(value.result).trim();
      if (value.richText && Array.isArray(value.richText)) {
        return value.richText.map((part) => part?.text || '').join('').trim();
      }
      if (value.hyperlink != null) return String(value.hyperlink).trim();
    }
    return String(value).trim();
  };

  try {
    // Read Excel file using ExcelJS (more secure than xlsx).
    const workbook = new ExcelJS.Workbook();
    const lowerPath = String(filePath).toLowerCase();
    if (lowerPath.endsWith('.csv')) {
      await workbook.csv.readFile(filePath);
    } else if (lowerPath.endsWith('.xlsx')) {
      await workbook.xlsx.readFile(filePath);
    } else if (lowerPath.endsWith('.xls')) {
      fs.unlinkSync(filePath);
      return res.status(400).json({
        error: 'Legacy .xls format is not supported. Save the file as .xlsx or .csv and upload again.',
      });
    } else {
      await workbook.xlsx.readFile(filePath);
    }

    const worksheet = workbook.worksheets.find((ws) => ws && ws.rowCount > 0);
    if (!worksheet) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Find header row dynamically (first row with at least 2 non-empty cells).
    let headerRowNumber = null;
    let headersByCol = {};
    for (let r = 1; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      const rowHeaders = {};
      let nonEmpty = 0;
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const header = normalizeCellValue(cell.value);
        if (header) {
          rowHeaders[colNumber] = header;
          nonEmpty += 1;
        }
      });
      if (nonEmpty >= 2) {
        headerRowNumber = r;
        headersByCol = rowHeaders;
        break;
      }
    }

    if (!headerRowNumber || Object.keys(headersByCol).length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Convert worksheet rows under detected header row into records.
    for (let r = headerRowNumber + 1; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      const rowData = {};
      let hasData = false;
      Object.entries(headersByCol).forEach(([colNumberStr, header]) => {
        const colNumber = Number.parseInt(colNumberStr, 10);
        const value = normalizeCellValue(row.getCell(colNumber).value);
        if (value !== '') {
          rowData[header] = value;
          hasData = true;
        }
      });
      if (hasData) data.push(rowData);
    }

    if (data.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Excel file is empty' });
    }
  } catch (error) {
    // Clean up uploaded file on error
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (unlinkErr) {
      console.error('Error deleting file:', unlinkErr);
    }
    return res.status(500).json({ error: 'Error processing Excel file: ' + error.message });
  }

  let imported = 0;
  let skipped = 0;
  let importedWithoutPhone = 0;
  const errors = [];
  let missingRequiredRows = 0;
  let processed = 0;

  // Define sendResponse function before db.get so it's accessible from nested callbacks
  function sendResponse() {
    // Clean up uploaded file
    try {
      fs.unlinkSync(filePath);
    } catch (unlinkErr) {
      console.error('Error deleting file:', unlinkErr);
    }

    const payload = {
      imported,
      skipped,
      imported_without_phone: importedWithoutPhone,
      total: data.length,
      missing_required_rows: missingRequiredRows,
      errors: errors.slice(0, 20) // Limit errors to first 20
    };

    if (imported === 0 && missingRequiredRows > 0) {
      return res.status(400).json({
        error: `Upload failed: ${missingRequiredRows} row(s) missing required id/receipt or customer name`,
        ...payload
      });
    }

    if (missingRequiredRows > 0 || skipped > 0) {
      payload.message = `Imported ${imported} order(s)${importedWithoutPhone ? ` (${importedWithoutPhone} without phone — add numbers on Orders)` : ''}. ${skipped} row(s) skipped.`;
    }

    res.json(payload);
  }

  // Get default service (first active service) as fallback
  try {
    const defaultService = await db.get('SELECT id FROM services WHERE is_active = TRUE LIMIT 1', []);
    const defaultServiceId = defaultService ? defaultService.id : null;

    const branchId = getEffectiveBranchId(req);
    if (branchId == null) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Select a branch to upload stock' });
    }

    // Cache branch prefix + existing receipts once (avoids 1–2 DB hits per row → Render 502 timeouts).
    const branchPrefix = await getBranchReceiptPrefix(branchId);
    const existingReceiptRows = await db.all(
      'SELECT receipt_number FROM orders WHERE branch_id = ?',
      [branchId]
    ).catch(() => []);
    const existingReceipts = new Set(
      (existingReceiptRows || []).map((r) => String(r.receipt_number || '').trim().toUpperCase()).filter(Boolean)
    );

    const customerByName = new Map(); // lower(name) → { id, phone }
    const uniqueNames = [];
    const seenNames = new Set();
    for (const row of data) {
      const n = String(
        row.name || row.Name || row.NAME || row['Customer Name'] || row['Customer name'] || row.Customer || row['FULL NAME'] || row['Full Name'] || ''
      ).trim();
      if (!n) continue;
      const key = n.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      uniqueNames.push(n);
    }
    // Chunk IN lookups to stay under parameter limits
    for (let i = 0; i < uniqueNames.length; i += 80) {
      const chunk = uniqueNames.slice(i, i + 80);
      const placeholders = chunk.map(() => '?').join(',');
      const found = await db.all(
        `SELECT id, name, phone FROM customers WHERE LOWER(name) IN (${placeholders})`,
        chunk.map((n) => n.toLowerCase())
      ).catch(() => []);
      for (const c of found || []) {
        customerByName.set(String(c.name || '').toLowerCase(), { id: c.id, phone: c.phone });
      }
    }

    // Process each row sequentially. Key columns (any casing): id, name, phone, amount, paid/not paid.
    // All uploaded stock is created as uncollected (status 'ready').
    for (let index = 0; index < data.length; index++) {
      const row = data[index];
      const getVal = (...names) => {
        for (const n of names) {
          const v = row[n];
          if (v !== undefined && v !== null && String(v).trim() !== '') return v;
        }
        return null;
      };

      // Primary format: id, name, phone, amount, paid (or payment_status)
      // Also accept common ledger headers: CUST ID, PHONE NO., AMOUNT (TZS), STATUS
      let receiptId = String(
        getVal(
          'id',
          'Id',
          'ID',
          'Receipt ID',
          'Receipt',
          'Receipt Number',
          'receipt_id',
          'CUST ID',
          'Cust ID',
          'cust id',
          'Customer ID',
          'Customer Id'
        ) || ''
      ).trim();
      const customerName = String(
        getVal(
          'name',
          'Name',
          'NAME',
          'Customer Name',
          'Customer name',
          'Customer',
          'FULL NAME',
          'Full Name'
        ) || ''
      ).trim();
      const phone = sanitizeImportPhone(
        getVal(
          'phone',
          'Phone',
          'PHONE',
          'Phone Number',
          'Mobile',
          'PHONE NO.',
          'Phone No.',
          'PHONE NO',
          'Phone No',
          'Phone number'
        )
      );
      const amountRaw = getVal(
        'amount',
        'Amount',
        'AMOUNT',
        'Total Amount',
        'Total',
        'total amount',
        'AMOUNT (TZS)',
        'Amount (TZS)',
        'AMOUNT TZS'
      );
      let amount = 0;
      if (amountRaw !== undefined && amountRaw !== null && String(amountRaw).trim() !== '') {
        const s = String(amountRaw).replace(/,/g, '').replace(/[^\d.-]/g, '');
        amount = parseFloat(s) || 0;
      }
      const paidRaw = getVal(
        'paid',
        'Paid',
        'PAID',
        'payment_status',
        'Payment Status',
        'Payment',
        'STATUS',
        'Status',
        'status'
      );
      const paidAmountCol = parseFloat(getVal('paid_amount', 'Paid Amount', 'Paid amount') || NaN);
      const unpaidBalance = parseFloat(getVal('unpaid_balance', 'Unpaid Balance', 'Balance', 'balance') || NaN);

      const serviceName = String(getVal('Service', 'service', 'Service Name') || '').trim();
      const quantity = parseInt(getVal('Quantity', 'quantity', 'Qty', 'qty') || 1);

      // Receipt / CUST ID encodes the service day (printed receipt).
      // Paid rows stay on that historical day (must not inflate today's cash).
      // NOT PAID / advance rows use upload day so Credit Sales appear on today's closing.
      const receiptOrderDateIso =
        deriveOrderDateFromReceiptId(receiptId) || getYesterdayNoonUtcIso();
      let orderDateIso = receiptOrderDateIso;
      const estimatedCollectionIso =
        addUtcDaysToOrderIso(receiptOrderDateIso, COLLECTION_DUE_AFTER_RECEIPT_DAYS) || null;

      if (!receiptId || !customerName) {
        const missingFields = [];
        if (!receiptId) missingFields.push('id/receipt');
        if (!customerName) missingFields.push('customer name');
        errors.push(`Row ${index + 2}: Missing required ${missingFields.join(' and ')}`);
        missingRequiredRows++;
        skipped++;
        processed++;
        continue;
      }

      const normReceipt = await normalizeReceiptNumberForBranch(receiptId, branchId, branchPrefix);
      if (!normReceipt.ok) {
        errors.push(`Row ${index + 2}: ${normReceipt.error}`);
        skipped++;
        processed++;
        continue;
      }
      receiptId = normReceipt.receiptNumber;

      const finalTotalAmount = amount > 0 ? amount : 0;
      let paidAmount = 0;
      let paymentStatus = 'not_paid';
      if (!Number.isNaN(paidAmountCol) && paidAmountCol >= 0) {
        paidAmount = paidAmountCol;
        paymentStatus = paidAmount >= finalTotalAmount ? 'paid_full' : (paidAmount > 0 ? 'advance' : 'not_paid');
      } else if (!Number.isNaN(unpaidBalance) && unpaidBalance >= 0) {
        paidAmount = Math.max(0, finalTotalAmount - unpaidBalance);
        paymentStatus = paidAmount >= finalTotalAmount ? 'paid_full' : (paidAmount > 0 ? 'advance' : 'not_paid');
      } else if (paidRaw != null) {
        const paidStr = String(paidRaw).toLowerCase().trim();
        const isExplicitUnpaid =
          /not\s*paid|unpaid|^no$|^n$|^0$|^false$/.test(paidStr) || paidStr === '';
        const isPaid =
          !isExplicitUnpaid &&
          (/^(paid|yes|1|true|full)$/.test(paidStr) || paidStr === 'y');
        paidAmount = isPaid ? finalTotalAmount : 0;
        paymentStatus = isPaid ? 'paid_full' : 'not_paid';
      }

      if (paymentStatus === 'not_paid' || paymentStatus === 'advance') {
        const todayYmd = getBusinessTodayYmd();
        orderDateIso = `${todayYmd}T12:00:00.000Z`;
      }

      // Find or create customer (phone optional — can be added later on Orders screen)
      try {
        const nameKey = customerName.toLowerCase();
        let customer = customerByName.get(nameKey) || null;
        let customerId = customer ? customer.id : null;
        let customerPhoneAfter = phone || (customer ? customer.phone : '');

        if (!customerId) {
          const phoneToStore = phone || generatePlaceholderPhone();
          customerPhoneAfter = phoneToStore;
          try {
            const result = await db.run(
              'INSERT INTO customers (name, phone, primary_branch_id) VALUES (?, ?, ?) RETURNING id',
              [customerName, phoneToStore, branchId]
            );
            customerId = resolveInsertId(result);
            if (!customerId) {
              throw new Error('Could not read new customer id from database');
            }
            customerByName.set(nameKey, { id: customerId, phone: phoneToStore });
          } catch (insertErr) {
            // Race / unique phone: try lookup again
            const again = await db.get('SELECT id, phone FROM customers WHERE LOWER(name) = LOWER(?)', [customerName]).catch(() => null);
            if (again?.id) {
              customerId = again.id;
              customerPhoneAfter = again.phone;
              customerByName.set(nameKey, { id: again.id, phone: again.phone });
            } else {
              errors.push(`Row ${index + 2}: Error creating customer - ${insertErr.message}`);
              skipped++;
              processed++;
              continue;
            }
          }
        } else if (phone && isPlaceholderPhone(customer.phone)) {
          try {
            const normalized = normalizePhoneDigits(phone);
            const phoneTaken = await db.get(
              `SELECT id FROM customers
               WHERE id != ?
                 AND (
                   phone = ?
                   OR phone = ?
                   OR TRIM(phone) = ?
                 )
               LIMIT 1`,
              [customerId, phone, normalized, phone]
            );
            if (!phoneTaken) {
              await db.run(
                'UPDATE customers SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [phone, customerId]
              );
              customerPhoneAfter = phone;
              customerByName.set(nameKey, { id: customerId, phone });
            }
          } catch (updateErr) {
            console.warn(`Row ${index + 2}: Could not update placeholder phone - ${updateErr.message}`);
          }
        } else if (customer) {
          customerPhoneAfter = customer.phone;
        }

        if (!customerId) {
          errors.push(`Row ${index + 2}: Could not resolve customer for "${customerName}"`);
          skipped++;
          processed++;
          continue;
        }

        // Find service by name if provided, otherwise use default
        let serviceId = defaultServiceId;
        if (serviceName) {
          try {
            const service = await db.get('SELECT id FROM services WHERE LOWER(name) = LOWER(?) AND is_active = TRUE', [serviceName]);
            if (service) {
              serviceId = service.id;
            }
          } catch (serviceErr) {
            // Use default service if service lookup fails
          }
        }

        if (!serviceId) {
          errors.push(`Row ${index + 2}: No service found and no default service available`);
          skipped++;
          processed++;
          continue;
        }

        const receiptKey = String(receiptId).trim().toUpperCase();
        if (existingReceipts.has(receiptKey)) {
          errors.push(`Row ${index + 2}: Order with receipt "${receiptId}" already exists`);
          skipped++;
          processed++;
          continue;
        }

        // Create order as uncollected stock (status 'ready').
        // order_date from receipt/CUST ID (printed day) so paid bulk rows do not inflate today's cash.
        // No transaction rows: "paid" reflects payment when receipt was issued, not cash taken at upload.
        try {
          await db.run(
            `INSERT INTO orders (receipt_number, customer_id, service_id, quantity, total_amount, paid_amount, payment_status, payment_method, status, order_date, estimated_collection_date, branch_id, created_at_branch_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?) RETURNING id`,
            [receiptId, customerId, serviceId, quantity, finalTotalAmount, paidAmount, paymentStatus, 'cash', orderDateIso, estimatedCollectionIso, branchId, branchId]
          );

          existingReceipts.add(receiptKey);
          processed++;
          imported++;
          if (isPlaceholderPhone(customerPhoneAfter)) importedWithoutPhone++;
        } catch (insertErr) {
          processed++;
          // Unique violation → treat as already exists
          if (/unique|duplicate/i.test(String(insertErr.message || ''))) {
            existingReceipts.add(receiptKey);
            errors.push(`Row ${index + 2}: Order with receipt "${receiptId}" already exists`);
          } else {
            errors.push(`Row ${index + 2}: Error creating order - ${insertErr.message}`);
          }
          skipped++;
        }
      } catch (rowErr) {
        errors.push(`Row ${index + 2}: Error processing row - ${rowErr.message}`);
        skipped++;
        processed++;
      }
    }

    if (!res.headersSent) {
      sendResponse();
    }
  } catch (err) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) { /* ignore */ }
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Error importing stock: ' + err.message });
    }
  }
});

// Get notification history for an order or customer
router.get('/notifications', authenticate, requireBranchAccess(), async (req, res) => {
  const { order_id, customer_id, limit = 50 } = req.query;
  
  let query = `
    SELECT n.*, c.name as customer_name, o.receipt_number
    FROM notifications n
    JOIN customers c ON n.customer_id = c.id
    LEFT JOIN orders o ON n.order_id = o.id
    WHERE 1=1
  `;
  let params = [];
  
  if (order_id) {
    query += ' AND n.order_id = ?';
    params.push(order_id);
  }
  
  if (customer_id) {
    query += ' AND n.customer_id = ?';
    params.push(customer_id);
  }
  
  query += ' ORDER BY n.created_at DESC LIMIT ?';
  params.push(parseInt(limit));
  
  try {
    const rows = await db.all(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manually send notification
router.post('/:id/send-notification', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  const { id } = req.params;
  const { notification_type = 'ready' } = req.body;
  
  try {
    const order = await db.get(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone, 
              c.sms_notifications_enabled, c.id as customer_id
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = ?`,
      [id]
    );
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const smsEnabled = order.sms_notifications_enabled !== 0;
    if (!smsEnabled) {
      return res.status(400).json({ error: 'SMS notifications are disabled for this customer' });
    }
    
    if (!order.customer_phone || isPlaceholderPhone(order.customer_phone)) {
      return res.status(400).json({ error: 'Customer phone number not available' });
    }
    
    let message;
    if (notification_type === 'ready') {
      const receiptSums = await db.get(
        `SELECT 
           COALESCE(SUM(total_amount), 0) as receipt_total_amount,
           COALESCE(SUM(paid_amount), 0) as receipt_paid_amount
         FROM orders
         WHERE UPPER(receipt_number) = UPPER(?)
           AND customer_id = ?`,
        [order.receipt_number, order.customer_id]
      );
      const totalAmount = parseFloat(receiptSums?.receipt_total_amount || 0);
      const paidAmount = parseFloat(receiptSums?.receipt_paid_amount || 0);
      const balanceDue = Math.max(0, totalAmount - paidAmount);
      const daysOverdueReady = daysOverdueFromEstimated(order.estimated_collection_date);
      message = generateCollectionReminder(
        order.receipt_number,
        order.customer_name,
        daysOverdueReady,
        balanceDue
      );
    } else if (notification_type === 'reminder') {
      const daysOverdue = daysOverdueFromEstimated(order.estimated_collection_date);
      const receiptSums = await db.get(
        `SELECT 
           COALESCE(SUM(total_amount), 0) as receipt_total_amount,
           COALESCE(SUM(paid_amount), 0) as receipt_paid_amount
         FROM orders
         WHERE UPPER(receipt_number) = UPPER(?)
         AND customer_id = ?`,
        [order.receipt_number, order.customer_id]
      );
      const balanceDue = Math.max(
        0,
        (parseFloat(receiptSums?.receipt_total_amount || 0) - parseFloat(receiptSums?.receipt_paid_amount || 0))
      );
      message = generateCollectionReminder(order.receipt_number, order.customer_name, daysOverdue, balanceDue);
    } else {
      return res.status(400).json({ error: 'Invalid notification type' });
    }
    
    const result = await sendSmsWithWhatsAppFallback(order.customer_phone, message, {
      customerId: order.customer_id,
      orderId: order.id,
      notificationType: notification_type,
      receiptNumber: order.receipt_number
    });

    if (result.skippedDuplicate) {
      return res.json({
        message: 'This notification was already sent recently for this receipt; not sending again.',
        skipped_duplicate: true,
        channel: null
      });
    }

    if (result?.smsSuppressed) {
      return res.json({
        message: 'SMS sending is globally disabled by admin',
        channel: null,
        notification_id: result.notificationId,
        sent: false,
        sms_suppressed: true
      });
    }

    if (result.success) {
      res.json({ 
        message: 'Notification sent successfully',
        channel: result.channel || 'sms',
        notification_id: result.notificationId
      });
    } else {
      res.status(500).json({ 
        error: 'Failed to send notification',
        details: result.error
      });
    }
  } catch (err) {
    console.error('Error sending notification:', err);
    res.status(500).json({ error: 'Error sending notification: ' + err.message });
  }
});

// Send collection reminder for a specific order
router.post('/:id/send-reminder', authenticate, requireBranchAccess(), requirePermission('canManageOrders'), async (req, res) => {
  const { id } = req.params;
  const { channels = ['sms'] } = req.body;
  const { sendCollectionReminder } = require('../utils/notifications');

  try {
    const result = await sendCollectionReminder(null, id, Array.isArray(channels) ? channels : [channels]);
    if (result.success) {
      res.json({
        message: 'Reminder sent successfully',
        result
      });
    } else if (result?.channels?.sms?.smsSuppressed && !result?.channels?.whatsapp?.success) {
      // Controlled outcome: admin globally suppressed SMS.
      res.json({
        message: 'SMS sending is globally disabled by admin',
        channel: null,
        sent: false,
        sms_suppressed: true,
        result
      });
    } else {
      res.status(400).json({
        error: result.error || 'Failed to send reminder',
        result
      });
    }
  } catch (err) {
    console.error('Error sending reminder:', err);
    res.status(500).json({ error: 'Error sending reminder: ' + err.message });
  }
});

module.exports = router;
