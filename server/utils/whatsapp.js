const axios = require('axios');
const db = require('../database/db');

/**
 * WhatsApp Business API integration
 * Supports multiple providers: Twilio, WhatsApp Cloud API, 360dialog
 */

// Format phone number for WhatsApp (E.164 format)
function formatPhoneNumber(phone) {
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.startsWith('255')) {
    return `+${cleanPhone}`;
  }
  if (cleanPhone.startsWith('0')) {
    return `+255${cleanPhone.slice(1)}`;
  }
  if (cleanPhone.length === 9) {
    return `+255${cleanPhone}`;
  }
  return `+${cleanPhone}`;
}

/**
 * Send WhatsApp message using Twilio WhatsApp API
 */
async function sendWhatsAppTwilio(phone, message, config) {
  const formattedPhone = formatPhoneNumber(phone);
  const twilioPhone = config.from || process.env.WHATSAPP_TWILIO_FROM;

  try {
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
      new URLSearchParams({
        From: `whatsapp:${twilioPhone}`,
        To: `whatsapp:${formattedPhone}`,
        Body: message
      }),
      {
        auth: {
          username: config.accountSid,
          password: config.authToken
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return {
      success: true,
      messageId: response.data.sid,
      provider: 'twilio'
    };
  } catch (error) {
    throw new Error(`Twilio WhatsApp error: ${error.response?.data?.message || error.message}`);
  }
}

/**
 * Send WhatsApp message using WhatsApp Cloud API (Meta)
 */
async function sendWhatsAppMeta(phone, message, config) {
  const formattedPhone = formatPhoneNumber(phone);
  const phoneNumberId = config.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = config.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: formattedPhone.replace('+', ''),
        type: 'text',
        text: {
          body: message
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      success: true,
      messageId: response.data.messages[0].id,
      provider: 'meta'
    };
  } catch (error) {
    throw new Error(`Meta WhatsApp API error: ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * Send WhatsApp message using 360dialog
 */
async function sendWhatsApp360Dialog(phone, message, config) {
  const formattedPhone = formatPhoneNumber(phone);
  const apiKey = config.apiKey || process.env.WHATSAPP_360DIALOG_API_KEY;
  const instanceId = config.instanceId || process.env.WHATSAPP_360DIALOG_INSTANCE_ID;

  try {
    const response = await axios.post(
      `https://waba.360dialog.io/v1/messages`,
      {
        recipient_type: 'individual',
        to: formattedPhone.replace('+', ''),
        type: 'text',
        text: {
          body: message
        }
      },
      {
        headers: {
          'D360-API-KEY': apiKey,
          'Content-Type': 'application/json'
        },
        params: {
          instance_id: instanceId
        }
      }
    );

    return {
      success: true,
      messageId: response.data.messages[0].id,
      provider: '360dialog'
    };
  } catch (error) {
    throw new Error(`360dialog error: ${error.response?.data?.error || error.message}`);
  }
}

/**
 * Main function to send WhatsApp message
 * Automatically detects provider from config
 */
async function sendWhatsApp(phone, message, options = {}) {
  const { customerId, orderId, notificationType = 'ready' } = options;

  // Create notification record
  let notificationId = null;
  if (customerId) {
    db.run(
      `INSERT INTO notifications (customer_id, order_id, notification_type, channel, recipient, message, status)
       VALUES (?, ?, ?, 'whatsapp', ?, ?, 'pending')`,
      [customerId, orderId || null, notificationType, formatPhoneNumber(phone), message],
      function(err) {
        if (!err) {
          notificationId = this.lastID;
        }
      }
    );
  }

  try {
    // Detect provider from environment variables
    const provider = process.env.WHATSAPP_PROVIDER || 'meta';
    let config = {};
    let result;

    switch (provider.toLowerCase()) {
      case 'twilio':
        config = {
          accountSid: process.env.WHATSAPP_TWILIO_ACCOUNT_SID,
          authToken: process.env.WHATSAPP_TWILIO_AUTH_TOKEN,
          from: process.env.WHATSAPP_TWILIO_FROM
        };
        if (!config.accountSid || !config.authToken) {
          throw new Error('Twilio credentials not configured');
        }
        result = await sendWhatsAppTwilio(phone, message, config);
        break;

      case '360dialog':
      case '360':
        config = {
          apiKey: process.env.WHATSAPP_360DIALOG_API_KEY,
          instanceId: process.env.WHATSAPP_360DIALOG_INSTANCE_ID
        };
        if (!config.apiKey || !config.instanceId) {
          throw new Error('360dialog credentials not configured');
        }
        result = await sendWhatsApp360Dialog(phone, message, config);
        break;

      case 'meta':
      case 'facebook':
      default:
        config = {
          phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
          accessToken: process.env.WHATSAPP_ACCESS_TOKEN
        };
        if (!config.phoneNumberId || !config.accessToken) {
          // Log but don't fail (for development). Return success: false so callers know nothing was sent.
          console.log(`SMS:  WhatsApp (not sent - no API credentials): ${formatPhoneNumber(phone)}`);
          console.log(`Message: ${message}`);
          
          if (notificationId) {
            db.run(
              `UPDATE notifications SET status = 'logged', sent_at = CURRENT_TIMESTAMP, error_message = 'No API credentials configured' WHERE id = ?`,
              [notificationId]
            );
          }
          
          return { success: false, error: 'No API credentials configured', notificationId };
        }
        result = await sendWhatsAppMeta(phone, message, config);
        break;
    }

    // Update notification status
    if (notificationId) {
      db.run(
        `UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [notificationId]
      );
    }

    return { ...result, notificationId };

  } catch (error) {
    console.error('Error sending WhatsApp:', error);
    
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

module.exports = {
  sendWhatsApp,
  formatPhoneNumber
};
