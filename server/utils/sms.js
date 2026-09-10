const axios = require('axios');
const db = require('../database/db');
const { computeDedupeKey, hasRecentDuplicate } = require('./smsDedupe');

// SMS notification service
// This is a template - you'll need to integrate with a Tanzanian SMS provider
// Common providers: Africa's Talking, Twilio (Tanzania), SMS Gateway API

let smsSendingEnabledCache = { value: true, fetchedAtMs: 0 };

async function dbGetAsync(sql, params = []) {
  // PostgreSQL adapter: returns a Promise.
  const ret = db.get(sql, params);
  if (ret && typeof ret.then === 'function') return ret;

  // SQLite adapter: callback style.
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function isGlobalSmsSendingEnabled() {
  const now = Date.now();
  // Reduce DB reads during loops (e.g. sending reminders).
  if (now - smsSendingEnabledCache.fetchedAtMs < 5000) return smsSendingEnabledCache.value;

  try {
    const row = await dbGetAsync('SELECT setting_value FROM settings WHERE setting_key = ?', ['sms_sending_enabled']);
    const raw = row?.setting_value;
    const enabled =
      raw == null
        ? true
        : !['false', '0', 'disabled', 'disable', 'off'].includes(String(raw).toLowerCase().trim());
    smsSendingEnabledCache = { value: enabled, fetchedAtMs: now };
    return enabled;
  } catch (err) {
    // Fail open: if the settings table lookup fails, don't accidentally stop SMS.
    console.error('SMS global switch lookup failed:', err?.message || err);
    return true;
  }
}

async function sendSMS(phone, message, options = {}) {
  const { customerId, orderId, notificationType = 'ready' } = options;

  const dedupeKey = computeDedupeKey({
    ...options,
    customerId,
    notificationType
  });
  if (dedupeKey && customerId) {
    const dup = await hasRecentDuplicate(db, {
      customerId,
      notificationType,
      dedupeKey
    });
    if (dup) {
      console.log(
        `SMS:  SMS skipped (duplicate within window): customer ${customerId} type ${notificationType} key ${dedupeKey}`
      );
      return {
        success: true,
        skippedDuplicate: true,
        message: 'SMS skipped — already sent recently for this receipt/customer and type'
      };
    }
  }

  // Remove any non-numeric characters and ensure it starts with country code
  const cleanPhone = phone.replace(/\D/g, '');
  const formattedPhone = cleanPhone.startsWith('255') 
    ? `+${cleanPhone}` 
    : `+255${cleanPhone.slice(-9)}`;

  const globallyEnabled = await isGlobalSmsSendingEnabled();
  if (!globallyEnabled) {
    // Track the deliberate suppression (helps admin debugging).
    let suppressedNotificationId = null;
    if (customerId) {
      try {
        const insertResult = await db.run(
          `INSERT INTO notifications (customer_id, order_id, notification_type, channel, recipient, message, status, dedupe_key)
           VALUES (?, ?, ?, 'sms', ?, ?, 'disabled', ?)`,
          [customerId, orderId || null, notificationType, formattedPhone, message, dedupeKey || null]
        );
        suppressedNotificationId = insertResult?.row?.id ?? insertResult?.lastID ?? null;
      } catch (insertErr) {
        console.error('SMS (suppressed): failed to create notification record:', insertErr.message);
      }
    }

    return {
      success: true,
      smsSuppressed: true,
      skippedDisabled: true,
      message: 'SMS suppressed (globally disabled)',
      notificationId: suppressedNotificationId,
    };
  }

  // Create notification record (await so we have notificationId for status updates, especially on PostgreSQL)
  let notificationId = null;
  if (customerId) {
    try {
      const insertResult = await db.run(
        `INSERT INTO notifications (customer_id, order_id, notification_type, channel, recipient, message, status, dedupe_key)
         VALUES (?, ?, ?, 'sms', ?, ?, 'pending', ?)`,
        [customerId, orderId || null, notificationType, formattedPhone, message, dedupeKey || null]
      );
      notificationId = insertResult?.row?.id ?? insertResult?.lastID ?? null;
    } catch (insertErr) {
      console.error('SMS: failed to create notification record:', insertErr.message);
    }
  }

  try {
    const provider = (process.env.SMS_PROVIDER || 'africastalking').toLowerCase();
    const apiKey = process.env.SMS_API_KEY || process.env.TWILIO_AUTH_TOKEN;

    // If no SMS provider configured, just log (for development)
    if (!apiKey) {
      console.log(`SMS:  SMS (not sent - no API key): ${formattedPhone}`);
      console.log(`Message: ${message}`);
      if (notificationId) {
        db.run(
          `UPDATE notifications SET status = 'logged', sent_at = CURRENT_TIMESTAMP, error_message = 'No API key configured' WHERE id = ?`,
          [notificationId]
        );
      }
      return { success: true, message: 'SMS logged (no API key configured)', notificationId };
    }

    // ----- Twilio -----
    if (provider === 'twilio') {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;
      if (!accountSid || !authToken || !fromNumber) {
        throw new Error('Twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in .env');
      }
      try {
        const response = await axios.post(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          new URLSearchParams({
            To: formattedPhone,
            From: fromNumber,
            Body: message
          }),
          {
            auth: { username: accountSid, password: authToken },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
          }
        );
        if (response.data && response.data.sid) {
          if (notificationId) {
            db.run(
              `UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [notificationId]
            );
          }
          return { success: true, message: 'SMS sent successfully', notificationId, provider: 'twilio' };
        }
        throw new Error('Twilio returned no message SID');
      } catch (apiError) {
        const errMsg = apiError.response?.data?.message || apiError.message;
        console.error('Twilio SMS error:', errMsg);
        if (notificationId) {
          db.run(
            `UPDATE notifications SET status = 'failed', error_message = ? WHERE id = ?`,
            [errMsg, notificationId]
          );
        }
        return { success: false, error: errMsg, notificationId };
      }
    }

    // ----- Africa's Talking (default) -----
    const smsConfig = {
      apiKey: process.env.SMS_API_KEY,
      apiUrl: process.env.SMS_API_URL || 'https://api.africastalking.com/version1/messaging',
      username: process.env.SMS_USERNAME,
    };
    if (!smsConfig.username) {
      console.warn('SMS:  SMS: SMS_USERNAME is not set. Set it in .env (e.g. "sandbox" for testing or your Africa\'s Talking app username for production).');
    }
    if (smsConfig.apiKey && smsConfig.username) {
      try {
        const response = await axios.post(
          smsConfig.apiUrl,
          new URLSearchParams({
            username: smsConfig.username,
            message: message,
            to: formattedPhone,
            from: process.env.SMS_SENDER_ID || 'SUPACLEAN'
          }),
          {
            headers: {
              'apiKey': smsConfig.apiKey,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
            }
          }
        );
        if (response.data && response.data.SMSMessageData) {
          const recipients = response.data.SMSMessageData.Recipients || [];
          const first = recipients[0];
          const success = recipients.length > 0 && (first.status === 'Success' || first.statusCode === 101 || first.statusCode === 102);
          if (success) {
            if (notificationId) {
              db.run(
                `UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [notificationId]
              );
            }
            return { success: true, message: 'SMS sent successfully', notificationId, provider: 'africas_talking' };
          }
          const apiErrMsg = first?.status || first?.message || response.data.SMSMessageData.Message || 'SMS API returned error status';
          console.error('SMS:  Africa\'s Talking SMS error:', apiErrMsg, 'Response:', JSON.stringify(response.data));
          throw new Error(apiErrMsg);
        }
        console.error('SMS:  Africa\'s Talking unexpected response:', JSON.stringify(response.data));
        throw new Error('Unexpected response from SMS API');
      } catch (apiError) {
        const errData = apiError.response?.data;
        const errMsg = errData?.message || errData?.SMSMessageData?.Message || apiError.message;
        console.error('SMS:  Africa\'s Talking SMS failed:', errMsg, errData ? 'Data: ' + JSON.stringify(errData) : '');
        if (notificationId) {
          db.run(
            `UPDATE notifications SET status = 'failed', error_message = ? WHERE id = ?`,
            [String(errMsg).slice(0, 255), notificationId]
          );
        }
        throw apiError;
      }
    }

    if (notificationId) {
      db.run(
        `UPDATE notifications SET status = 'logged', sent_at = CURRENT_TIMESTAMP, error_message = 'No API key configured' WHERE id = ?`,
        [notificationId]
      );
    }
    return { success: true, message: 'SMS logged (no API key configured)', notificationId, logged: true };
  } catch (error) {
    console.error('Error sending SMS:', error);
    
    // Update notification status with error
    if (notificationId) {
      db.run(
        `UPDATE notifications SET status = 'failed', error_message = ? WHERE id = ?`,
        [error.message, notificationId]
      );
    }
    
    return { success: false, error: error.message, notificationId };
  }
}

/** Delivery numbers shown in ready SMS (English and Swahili) */
const DELIVERY_PHONE_1 = '0713370421';
const DELIVERY_PHONE_2 = '0752757635';

/** Include Swahili translation in same SMS (set SMS_INCLUDE_SWAHILI=false to disable) */
function includeSwahili() {
  return process.env.SMS_INCLUDE_SWAHILI !== 'false';
}

function generateReadyNotification(receiptNumber, customerName, estimatedDate = null, payment = {}) {
  const name = String(customerName || 'Mteja').trim();
  const receipt = String(receiptNumber || '').trim();
  const totalAmount = Number(payment.totalAmount ?? 0);
  const paidAmount = Number(payment.paidAmount ?? 0);
  const balanceDue = Number(payment.balanceDue ?? Math.max(0, totalAmount - paidAmount));
  const amountText = Math.max(0, Math.round((Number.isFinite(totalAmount) ? totalAmount : 0) * 100) / 100).toLocaleString();
  const paidText = Math.max(0, Math.round((Number.isFinite(paidAmount) ? paidAmount : 0) * 100) / 100).toLocaleString();
  const balanceText = Math.max(0, Math.round((Number.isFinite(balanceDue) ? balanceDue : 0) * 100) / 100).toLocaleString();

  if (Math.max(0, balanceDue) <= 0) {
    return `Habari ${name}, oda yako ${receipt} imepokelewa Tsh. ${amountText} PAID. Karibu sana`;
  }
  return `Habari ${name} oda yako ${receipt} imepokelewa, Advance ${paidText} Salio ${balanceText} Tshs. Karibu sana`;
}

function generateOrderConfirmation(receiptNumber, customerName, totalAmount, estimatedDate = null) {
  let message = `Habari ${customerName}, thank you for your order! Receipt: ${receiptNumber}. Amount: TSh ${totalAmount.toLocaleString()}`;
  if (estimatedDate) {
    const date = new Date(estimatedDate);
    const dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    message += `. Est. ready: ${dateStr}`;
  }
  return message;
}

/**
 * Format payment_status for display in SMS (English)
 */
function formatPaymentStatusForSms(status) {
  const map = {
    paid_full: 'Paid',
    not_paid: 'Not Paid',
    advance: 'Advance',
    credit: 'Credit'
  };
  return map[status] || (status || 'Not Paid');
}

/**
 * Format payment_status for Swahili SMS
 */
function formatPaymentStatusForSmsSwahili(status) {
  const map = {
    paid_full: 'Imelipwa',
    not_paid: 'Haijalipwa',
    advance: 'Mapema',
    credit: 'Mkopo'
  };
  return map[status] || (status || 'Haijalipwa');
}

/**
 * Terms & Conditions URL for SMS (set TERMS_AND_CONDITIONS_URL in .env for full URL, e.g. https://yoursite.com/terms)
 */
function getTermsAndConditionsUrl() {
  return process.env.TERMS_AND_CONDITIONS_URL || '';
}

/**
 * Order receipt SMS – sent once after printing receipt. Detailed but brief; includes T&C link.
 *
 * @param {string} receiptNumber
 * @param {string} customerName
 * @param {string|number} customerId
 * @param {string} itemsDescription - e.g. "2x Wash & Fold (Blue); 1x Iron (Shirts)"
 * @param {number} totalAmount - Total in TSh
 * @param {string} paymentStatus - paid_full, not_paid, advance, credit
 * @param {string} [estimatedDate] - Optional estimated collection date for SMS
 */
function generateOrderReceiptSms(receiptNumber, customerName, customerId, itemsDescription, totalAmount, paymentStatus, estimatedDate = null) {
  const MAX_RECEIPT_SMS_LEN = 110;
  const amountStr = typeof totalAmount === 'number' ? totalAmount.toLocaleString() : String(totalAmount);
  const statusStr = formatPaymentStatusForSms(paymentStatus);
  const safeName = (customerName || 'Customer').replace(/[^a-zA-Z0-9 .'-]/g, '').trim() || 'Customer';
  const base = `Habari ${safeName}, receipt ${receiptNumber}, TSh ${amountStr}, ${statusStr}. Thank you.`;
  const normalized = base.replace(/\s+/g, ' ').trim();
  // Enforce single short English SMS to avoid multi-part billing.
  return normalized.length <= MAX_RECEIPT_SMS_LEN
    ? normalized
    : `${normalized.slice(0, MAX_RECEIPT_SMS_LEN - 3).trimEnd()}...`;
}

/** Max storage days policy (SMS + business rule reference). */
const MAX_STORAGE_DAYS = 45;

/** Full calendar days from `from` to `to` (UTC date parts). */
function calendarDaysUtc(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const a0 = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const b0 = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.max(0, Math.floor((b0 - a0) / 86400000));
}

/** Full calendar days past estimated collection (0 if none or not yet due). Same logic as collection reminders. */
function daysOverdueFromEstimated(estimatedDate) {
  if (!estimatedDate) return 0;
  const now = new Date();
  const due = new Date(estimatedDate);
  if (Number.isNaN(due.getTime()) || due >= now) return 0;
  return calendarDaysUtc(due, now);
}

/**
 * Collection reminder SMS (Swahili).
 *
 * @param {string} receiptNumber
 * @param {string} customerName
 * @param {number} daysOverdue - Days after estimated_collection_date (due = received + 3 days)
 * @param {number} balanceDue
 */
function generateCollectionReminder(receiptNumber, customerName, daysOverdue = 0, balanceDue = 0) {
  const MAX_REMINDER_SMS_LEN = 140;
  const overdueDays = Number.isFinite(Number(daysOverdue)) ? Math.max(0, Number(daysOverdue)) : 0;
  const safeBalance = Number.isFinite(Number(balanceDue)) ? Math.max(0, Number(balanceDue)) : 0;
  const balanceText = Number(safeBalance).toLocaleString();
  const safeName = String(customerName || 'Mteja').replace(/\s+/g, ' ').trim() || 'Mteja';
  const safeReceipt = String(receiptNumber || '').replace(/\s+/g, ' ').trim();

  const base = `Habari ${safeName}, oda yako tayari kuchukuliwa. Risiti: ${safeReceipt}. Siku za kuchelewa: ${overdueDays}. Salio: TSh ${balanceText}. Karibu sana.`;
  const normalized = base.replace(/\s+/g, ' ').trim();
  return normalized.length <= MAX_REMINDER_SMS_LEN
    ? normalized
    : `${normalized.slice(0, MAX_REMINDER_SMS_LEN - 3).trimEnd()}...`;
}

/**
 * Invoice / payment notice reminder for monthly billing
 */
function generateInvoiceReminder(invoiceNumber, companyName, amountDue, dueDate, daysOverdue = 0) {
  const amountStr = typeof amountDue === 'number' ? amountDue.toLocaleString() : String(amountDue);
  let message = `SUPACLEAN: Hello ${companyName}, payment reminder for Invoice ${invoiceNumber}. Amount due: TSh ${amountStr}. Due date: ${dueDate}`;
  if (daysOverdue > 0) {
    message += `. This invoice is ${daysOverdue} day${daysOverdue > 1 ? 's' : ''} overdue. Please arrange payment.`;
  } else {
    message += `. Please pay by due date. Thank you.`;
  }
  return message;
}

/**
 * Short payment notice (fits better in SMS character limits)
 */
function generatePaymentNoticeShort(invoiceNumber, companyName, amountDue, daysOverdue = 0) {
  const amountStr = typeof amountDue === 'number' ? amountDue.toLocaleString() : String(amountDue);
  if (daysOverdue > 0) {
    return `SUPACLEAN: Invoice ${invoiceNumber} (${companyName}) is overdue. Balance: TSh ${amountStr}. Please pay.`;
  }
  return `SUPACLEAN: Invoice ${invoiceNumber} (${companyName}) - TSh ${amountStr} due. Please pay on time.`;
}

module.exports = {
  sendSMS,
  generateReadyNotification,
  generateOrderConfirmation,
  generateCollectionReminder,
  MAX_STORAGE_DAYS,
  calendarDaysUtc,
  daysOverdueFromEstimated,
  generateInvoiceReminder,
  generatePaymentNoticeShort,
  generateOrderReceiptSms,
  getTermsAndConditionsUrl,
  formatPaymentStatusForSms,
  formatPaymentStatusForSmsSwahili
};
