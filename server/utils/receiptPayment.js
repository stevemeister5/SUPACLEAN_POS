/**
 * Atomic receipt-level payments: row locks + single DB transaction.
 * Prevents double payment / stale balance when multiple cashiers pay the same receipt.
 */
const db = require('../database/query');
const { convertQuery } = require('../database/query');
const {
  recordPaymentTransactionClient,
  logPaymentChangeClient,
} = require('./paymentTransactions');

const { roundMoney } = require('./money');

function buildPerOrderPaidAllocations(orders, receiptPaidAmount) {
  const sorted = [...orders].sort((a, b) => Number(a.id) - Number(b.id));
  let remaining = Math.max(0, roundMoney(receiptPaidAmount));
  const allocations = [];

  for (const o of sorted) {
    const total = Math.max(0, roundMoney(Number(o.total_amount) || 0));
    const paidNow = Math.min(total, remaining);
    remaining -= paidNow;
    const status = paidNow >= total ? 'paid_full' : paidNow > 0 ? 'advance' : 'not_paid';
    allocations.push({
      id: o.id,
      paid_amount: paidNow,
      payment_status: status,
    });
  }
  return allocations;
}

async function lockReceiptOrders(client, receiptNumber, branchFilter) {
  const { query, params } = convertQuery(
    `SELECT o.*
     FROM orders o
     WHERE UPPER(o.receipt_number) = UPPER(?)
       AND COALESCE(o.is_voided, FALSE) = FALSE
       AND o.archived_at IS NULL
       ${branchFilter.clause || ''}
     ORDER BY o.id
     FOR UPDATE OF o`,
    [receiptNumber, ...(branchFilter.params || [])]
  );
  const result = await client.query(query, params);
  return result.rows || [];
}

async function checkDuplicatePaymentClient(client, orderId, amount, timestamp) {
  const result = await client.query(
    `SELECT id FROM transactions
     WHERE order_id = $1
       AND amount = $2
       AND transaction_type = 'payment_received'
       AND COALESCE(is_voided, FALSE) = FALSE
       AND transaction_date >= $3::timestamp - INTERVAL '1 minute'
       AND transaction_date <= $3::timestamp + INTERVAL '1 minute'
     LIMIT 1`,
    [orderId, amount, timestamp]
  );
  return (result.rows || []).length > 0;
}

/**
 * Apply payment and/or collection atomically for all line items on a receipt.
 * @param {Object} opts
 * @param {string} opts.receiptNumber
 * @param {{ clause: string, params: any[] }} opts.branchFilter
 * @param {number} opts.paymentAmount - 0 when collecting an already-paid receipt
 * @param {string} opts.paymentMethod
 * @param {string} opts.paymentTimestampIso
 * @param {string} [opts.notes]
 * @param {string} [opts.changedBy]
 * @param {boolean} [opts.collect] - mark receipt collected
 * @returns {Promise<{ ok: true, data: object } | { ok: false, status: number, error: string }>}
 */
async function applyReceiptPaymentAtomic({
  receiptNumber,
  branchFilter,
  paymentAmount = 0,
  paymentMethod = 'cash',
  paymentTimestampIso,
  notes = '',
  changedBy = 'Cashier',
  collect = false,
}) {
  const client = await db.getPool().connect();
  const tol = 0.01;

  try {
    await client.query('BEGIN');

    const orders = await lockReceiptOrders(client, receiptNumber, branchFilter);
    if (!orders.length) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Receipt not found' };
    }

    if (orders.some((o) => o.is_voided)) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'This receipt has been voided' };
    }

    if (collect && orders.some((o) => o.status === 'collected')) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'Receipt already collected' };
    }

    const receiptTotal = roundMoney(orders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0));
    const receiptPaid = roundMoney(orders.reduce((sum, o) => sum + (parseFloat(o.paid_amount) || 0), 0));
    const balanceDue = roundMoney(receiptTotal - receiptPaid);
    const payAmount = roundMoney(Number(paymentAmount) || 0);
    const firstOrder = orders[0];

    if (payAmount > 0) {
      if (payAmount > balanceDue + tol) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          status: 400,
          error: `Payment cannot exceed the balance due of TSh ${balanceDue.toLocaleString()}.`,
        };
      }
      const isDuplicate = await checkDuplicatePaymentClient(client, firstOrder.id, payAmount, paymentTimestampIso);
      if (isDuplicate) {
        await client.query('ROLLBACK');
        return { ok: false, status: 400, error: 'Duplicate payment detected. This payment was already recorded.' };
      }
    } else if (collect && balanceDue > tol) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        status: 400,
        error:
          'Cannot collect without payment. Record the balance due in the payment modal, or receive payment first (Orders or Collection page).',
      };
    } else if (!collect && payAmount <= 0) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'Payment amount must be greater than 0' };
    } else if (!collect && balanceDue <= tol) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'Receipt is already fully paid.' };
    }

    let newReceiptPaid = receiptPaid;
    let transactionId = null;
    let receiptPaymentStatus = firstOrder.payment_status;

    if (payAmount > 0) {
      newReceiptPaid = roundMoney(receiptPaid + payAmount);
      receiptPaymentStatus = newReceiptPaid >= receiptTotal - tol ? 'paid_full' : 'advance';
      const orderObj = {
        id: firstOrder.id,
        receipt_number: firstOrder.receipt_number,
        branch_id: firstOrder.branch_id || null,
      };
      transactionId = await recordPaymentTransactionClient(
        client,
        orderObj,
        payAmount,
        paymentMethod,
        changedBy,
        paymentTimestampIso
      );
    }

    const allocations = buildPerOrderPaidAllocations(orders, newReceiptPaid);
    const auditAction = collect ? 'collected' : 'payment_received';

    for (const alloc of allocations) {
      const oldOrder = orders.find((o) => Number(o.id) === Number(alloc.id));
      if (collect) {
        await client.query(
          `UPDATE orders
           SET status = 'collected',
               collected_date = CURRENT_TIMESTAMP,
               paid_amount = $1,
               payment_status = $2,
               payment_method = $3
           WHERE id = $4`,
          [alloc.paid_amount, alloc.payment_status, paymentMethod, alloc.id]
        );
      } else {
        await client.query(
          `UPDATE orders SET paid_amount = $1, payment_status = $2, payment_method = $3 WHERE id = $4`,
          [alloc.paid_amount, alloc.payment_status, paymentMethod, alloc.id]
        );
      }

      await logPaymentChangeClient(client, {
        order_id: alloc.id,
        action: auditAction,
        old_payment_status: oldOrder?.payment_status,
        new_payment_status: alloc.payment_status,
        old_paid_amount: parseFloat(oldOrder?.paid_amount) || 0,
        new_paid_amount: alloc.paid_amount,
        old_payment_method: oldOrder?.payment_method,
        new_payment_method: paymentMethod,
        changed_by: changedBy,
        notes:
          notes ||
          (collect
            ? `Payment at collection for receipt ${receiptNumber} (${orders.length} items)`
            : `Payment for receipt ${receiptNumber} (${orders.length} items)`),
      });
    }

    await client.query('COMMIT');

    return {
      ok: true,
      data: {
        receiptNumber,
        orders,
        firstOrder,
        receiptTotal,
        receiptPaid: newReceiptPaid,
        paymentAmount: payAmount,
        transactionId,
        receiptPaymentStatus,
        balanceRemaining: roundMoney(Math.max(0, receiptTotal - newReceiptPaid)),
        itemCount: orders.length,
      },
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      console.error('ERROR: receipt payment ROLLBACK failed:', rbErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  applyReceiptPaymentAtomic,
  buildPerOrderPaidAllocations,
  roundMoney,
};
