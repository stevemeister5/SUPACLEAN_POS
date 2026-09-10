const { sendSMS, generateOrderConfirmation, generateCollectionReminder, calendarDaysUtc, daysOverdueFromEstimated, generateInvoiceReminder, generatePaymentNoticeShort } = require('./sms');
const { sendWhatsApp } = require('./whatsapp');
const db = require('../database/db');
const { computeDedupeKey, hasRecentDuplicate } = require('./smsDedupe');

/**
 * Unified notification service
 * Sends notifications via SMS and/or WhatsApp based on customer preferences and system settings
 */

/**
 * Send notification to customer (SMS and/or WhatsApp)
 * @param {Object} options - Notification options
 * @param {number} options.customerId - Customer ID
 * @param {number} options.orderId - Order ID (optional)
 * @param {string} options.phone - Customer phone number
 * @param {string} options.customerName - Customer name
 * @param {string} options.notificationType - Type: 'ready', 'reminder', 'confirmation'
 * @param {Object} options.orderData - Order data (receipt, amount, estimated date, etc.)
 * @param {string[]} options.channels - Channels to use: ['sms', 'whatsapp'] or ['sms'] or ['whatsapp']
 */
async function sendNotification(options) {
  const {
    customerId,
    orderId,
    phone,
    customerName,
    notificationType = 'ready',
    orderData = {},
    channels = ['sms'] // Default to SMS only
  } = options;

  if (!phone || !customerName) {
    return { success: false, error: 'Phone and customer name are required' };
  }

  // Get customer preferences
  let smsEnabled = true;
  let whatsappEnabled = false;
  
  if (customerId) {
    db.get(
      'SELECT sms_notifications_enabled FROM customers WHERE id = ?',
      [customerId],
      (err, customer) => {
        if (!err && customer) {
          smsEnabled = customer.sms_notifications_enabled !== 0;
        }
      }
    );
  }

  // Generate message based on type
  let message = '';
  switch (notificationType) {
    case 'ready': {
      const daysOverdue = daysOverdueFromEstimated(orderData.estimatedDate);
      message = generateCollectionReminder(
        orderData.receiptNumber,
        customerName,
        daysOverdue,
        orderData.balanceDue ?? 0
      );
      break;
    }
    case 'confirmation':
      message = generateOrderConfirmation(
        orderData.receiptNumber,
        customerName,
        orderData.totalAmount,
        orderData.estimatedDate
      );
      break;
    case 'reminder':
      message = generateCollectionReminder(
        orderData.receiptNumber,
        customerName,
        orderData.daysOverdue ?? 0,
        orderData.balanceDue ?? 0
      );
      break;
    case 'balance_reminder':
      message = generateBalanceReminder(
        customerName,
        orderData.balance,
        orderData.receiptNumbers
      );
      break;
    case 'invoice_reminder':
      message = (options.useShort && options.useShort === true)
        ? generatePaymentNoticeShort(
            orderData.invoiceNumber,
            customerName,
            orderData.amountDue,
            orderData.daysOverdue || 0
          )
        : generateInvoiceReminder(
            orderData.invoiceNumber,
            customerName,
            orderData.amountDue,
            orderData.dueDate || '',
            orderData.daysOverdue || 0
          );
      break;
    default:
      message = options.message || `Habari ${customerName}, this is a message from us.`;
  }

  const dedupeKey = computeDedupeKey({
    customerId,
    notificationType,
    receiptNumber: orderData.receiptNumber,
    invoiceNumber: orderData.invoiceNumber,
    dedupeKey: options.dedupeKey
  });
  if (dedupeKey && customerId) {
    const dup = await hasRecentDuplicate(db, { customerId, notificationType, dedupeKey });
    if (dup) {
      console.log(
        `SMS:  Notification skipped (duplicate within window): customer ${customerId} type ${notificationType} key ${dedupeKey}`
      );
      return {
        success: true,
        skippedDuplicate: true,
        message,
        channels: { sms: { skippedDuplicate: true }, whatsapp: { skippedDuplicate: true } }
      };
    }
  }

  const results = {
    sms: null,
    whatsapp: null
  };

  // Send via requested channels
  const sendPromises = [];

  if (channels.includes('sms') && smsEnabled) {
    sendPromises.push(
      sendSMS(phone, message, {
        customerId,
        orderId,
        notificationType,
        receiptNumber: orderData.receiptNumber,
        invoiceNumber: orderData.invoiceNumber,
        dedupeKey: options.dedupeKey
      }).then(result => {
        results.sms = result;
        return result;
      }).catch(err => {
        results.sms = { success: false, error: err.message };
        return results.sms;
      })
    );
  }

  if (channels.includes('whatsapp')) {
    sendPromises.push(
      sendWhatsApp(phone, message, {
        customerId,
        orderId,
        notificationType
      }).then(result => {
        results.whatsapp = result;
        return result;
      }).catch(err => {
        results.whatsapp = { success: false, error: err.message };
        return results.whatsapp;
      })
    );
  }

  await Promise.all(sendPromises);

  const smsWasSuppressed = results.sms?.smsSuppressed;
  const smsSuccess = (results.sms?.success && !smsWasSuppressed) || false;
  const whatsappSuccess = results.whatsapp?.success || false;
  const success = smsSuccess || whatsappSuccess;
  
  return {
    success,
    channels: results,
    message
  };
}

/**
 * Generate balance reminder message
 */
function generateBalanceReminder(customerName, balance, receiptNumbers = []) {
  let message = `Habari ${customerName}, reminder: You have an outstanding balance of TSh ${balance.toLocaleString()}`;
  
  if (receiptNumbers && receiptNumbers.length > 0) {
    message += ` for receipt${receiptNumbers.length > 1 ? 's' : ''}: ${receiptNumbers.join(', ')}`;
  }
  
  message += `. Please visit us to collect your items. Thank you.`;
  return message;
}

/**
 * Send collection reminder (ready orders)
 */
async function sendCollectionReminder(customerId, orderId, channels = ['sms']) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone,
              c.sms_notifications_enabled,
              (
                SELECT COALESCE(SUM(r.total_amount), 0)
                FROM orders r
                WHERE UPPER(r.receipt_number) = UPPER(o.receipt_number)
                  AND r.customer_id = o.customer_id
              ) as receipt_total_amount,
              (
                SELECT COALESCE(SUM(r.paid_amount), 0)
                FROM orders r
                WHERE UPPER(r.receipt_number) = UPPER(o.receipt_number)
                  AND r.customer_id = o.customer_id
              ) as receipt_paid_amount
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = ?`,
      [orderId],
      async (err, order) => {
        if (err) {
          return reject(err);
        }
        if (!order) {
          return reject(new Error('Order not found'));
        }

        const smsEnabled = order.sms_notifications_enabled !== 0;
        const actualChannels = channels.filter(ch => {
          if (ch === 'sms' && !smsEnabled) return false;
          return true;
        });

        if (actualChannels.length === 0) {
          return resolve({
            success: false,
            error: 'No enabled notification channels for this customer'
          });
        }

        const now = new Date();
        let daysOverdue = 0;
        if (order.estimated_collection_date) {
          const due = new Date(order.estimated_collection_date);
          if (due < now) {
            daysOverdue = calendarDaysUtc(due, now);
          }
        }

        try {
          const receiptTotal = parseFloat(order.receipt_total_amount || 0);
          const receiptPaid = parseFloat(order.receipt_paid_amount || 0);
          const balanceDue = Math.max(0, receiptTotal - receiptPaid);
          const result = await sendNotification({
            customerId: order.customer_id,
            orderId: order.id,
            phone: order.customer_phone,
            customerName: order.customer_name,
            notificationType: 'reminder',
            orderData: {
              receiptNumber: order.receipt_number,
              daysOverdue,
              estimatedDate: order.estimated_collection_date,
              balanceDue
            },
            channels: actualChannels
          });
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

/**
 * Send balance reminder for customer with outstanding orders
 */
async function sendBalanceReminder(customerId, channels = ['sms']) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT o.receipt_number, (o.total_amount - COALESCE(o.paid_amount, 0)) as balance
       FROM orders o
       WHERE o.customer_id = ? 
         AND o.status != 'collected'
         AND (o.total_amount - COALESCE(o.paid_amount, 0)) > 0`,
      [customerId],
      async (err, orders) => {
        if (err) {
          return reject(err);
        }

        if (!orders || orders.length === 0) {
          return resolve({
            success: false,
            error: 'No outstanding orders for this customer'
          });
        }

        const totalBalance = orders.reduce((sum, o) => sum + parseFloat(o.balance || 0), 0);
        const receiptNumbers = orders.map(o => o.receipt_number);

        db.get(
          'SELECT name, phone, sms_notifications_enabled FROM customers WHERE id = ?',
          [customerId],
          async (customerErr, customer) => {
            if (customerErr) {
              return reject(customerErr);
            }
            if (!customer) {
              return reject(new Error('Customer not found'));
            }

            const smsEnabled = customer.sms_notifications_enabled !== 0;
            const actualChannels = channels.filter(ch => {
              if (ch === 'sms' && !smsEnabled) return false;
              return true;
            });

            if (actualChannels.length === 0) {
              return resolve({
                success: false,
                error: 'No enabled notification channels for this customer'
              });
            }

            try {
              const result = await sendNotification({
                customerId: customer.id,
                phone: customer.phone,
                customerName: customer.name,
                notificationType: 'balance_reminder',
                orderData: {
                  balance: totalBalance,
                  receiptNumbers
                },
                channels: actualChannels
              });
              resolve(result);
            } catch (error) {
              reject(error);
            }
          }
        );
      }
    );
  });
}

/**
 * Send invoice / payment-notice reminder via SMS and/or WhatsApp
 * Use this for monthly billing: overdue or upcoming-due invoices.
 *
 * @param {Object} invoice - Invoice record: invoice_number, balance_due, due_date
 * @param {Object} customer - Customer record: id, name, phone, company_name?, billing_contact_phone?
 * @param {string[]} channels - ['sms', 'whatsapp'] or subset
 * @param {Object} options - { useShort: true } to use shorter message (better for SMS length)
 * @returns {Promise<{ success, channels, message }>}
 */
async function sendInvoiceReminder(invoice, customer, channels = ['sms', 'whatsapp'], options = {}) {
  const phone = customer.billing_contact_phone || customer.phone;
  const name = customer.company_name || customer.billing_contact_name || customer.name;

  if (!phone || !name) {
    return {
      success: false,
      error: 'Customer has no phone number (or billing_contact_phone) for reminders'
    };
  }

  const dueDate = invoice.due_date
    ? new Date(invoice.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '';
  const now = new Date();
  const due = invoice.due_date ? new Date(invoice.due_date) : null;
  const daysOverdue = due && due < now
    ? Math.floor((now - due) / (24 * 60 * 60 * 1000))
    : 0;
  const amountDue = parseFloat(invoice.balance_due || invoice.total_amount || 0);

  return sendNotification({
    customerId: customer.id,
    phone,
    customerName: name,
    notificationType: 'invoice_reminder',
    orderData: {
      invoiceNumber: invoice.invoice_number,
      amountDue,
      dueDate,
      daysOverdue
    },
    channels: Array.isArray(channels) ? channels : ['sms'],
    useShort: options.useShort === true
  });
}

/**
 * True when SMS was handed to a carrier (Twilio / Africa's Talking) successfully.
 * sendSMS() returns success: true for "logged only" dev mode (no API key) without provider set —
 * those must not count as delivered or WhatsApp fallback is skipped and clients see false positives.
 */
function smsWasSentByCarrier(smsResult) {
  if (!smsResult || !smsResult.success || smsResult.skippedDuplicate) return false;
  const p = smsResult.provider;
  return p === 'twilio' || p === 'africas_talking';
}

/**
 * Try SMS first; if SMS fails, send via WhatsApp. If SMS succeeds, WhatsApp is not sent.
 * Default behavior for receipt and other single-message notifications.
 *
 * @param {string} phone - Recipient phone
 * @param {string} message - Message body
 * @param {Object} options - { customerId, orderId, notificationType } (passed to both SMS and WhatsApp)
 * @returns {Promise<{ success, channel?: 'sms'|'whatsapp', error?, ... }>}
 */
async function sendSmsWithWhatsAppFallback(phone, message, options = {}) {
  const smsResult = await sendSMS(phone, message, options);
  if (smsResult && smsResult.skippedDuplicate) {
    return { ...smsResult, channel: null };
  }
  if (smsResult && smsResult.smsSuppressed) {
    // Admin globally disabled SMS. Don't send the fallback WhatsApp message either.
    return { ...smsResult, channel: null };
  }
  if (smsWasSentByCarrier(smsResult)) {
    return { ...smsResult, channel: 'sms' };
  }
  const waResult = await sendWhatsApp(phone, message, options);
  return {
    ...waResult,
    channel: (waResult && waResult.success) ? 'whatsapp' : null
  };
}

module.exports = {
  sendNotification,
  sendCollectionReminder,
  sendBalanceReminder,
  generateBalanceReminder,
  sendInvoiceReminder,
  sendSmsWithWhatsAppFallback
};
