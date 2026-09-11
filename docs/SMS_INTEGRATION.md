# SMS Integration – Send SMS to Customers via a Phone Carrier

The POS can send SMS to customers (order ready, collection reminder, receipt, balance reminder) using a real SMS provider. Two options are supported: **Africa's Talking** (recommended for Tanzania) and **Twilio**.

---

## How it works in the app

- **After printing receipt (new order)** → **One** receipt SMS only, sent automatically (detailed but brief: receipt, items, total, payment status, est. ready date, and Terms & Conditions link if `TERMS_AND_CONDITIONS_URL` is set).
- **Order marked “Ready”** → One SMS advising customer to collect, including the delivery-requests number (0752757635).
- **Collection reminder** → From Orders or Collection page; message includes how many days items have been in storage since the due date.
- **Balance reminder** → From Customers page.

If no SMS provider is configured, messages are **logged only** (no real SMS sent).

---

## Option 1: Africa's Talking (recommended for Tanzania)

1. **Sign up**
   - Go to [https://africastalking.com](https://africastalking.com) and create an account.
   - For testing, use the **sandbox**; for production, go live and add credit.

2. **Get credentials**
   - **Dashboard** → **Settings** (or **API**):
     - **Username** (e.g. `sandbox` for sandbox).
     - **API Key** (generate if needed).
   - **Sender ID** (optional): request an alphanumeric sender (e.g. `SUPACLEAN`) for production; sandbox may use a shortcode.

3. **Environment variables**
   - **Local:** add to `.env` in the project root (Africa's Talking API key and username are already in `.env`).
   - **Render:** Service → **Environment** → Add each variable.

   | Variable        | Value                                                                 | Required |
   |-----------------|-----------------------------------------------------------------------|----------|
   | `SMS_PROVIDER`  | `africastalking` (or leave unset; this is the default)                | No       |
   | `SMS_API_KEY`   | Your Africa's Talking API key                                         | Yes      |
   | `SMS_USERNAME`  | `sandbox` for testing; your Africa's Talking app username for production | Yes    |
   | `SMS_API_URL`   | Leave empty for live; for sandbox use: `https://api.sandbox.africastalking.com/version1/messaging` | No (optional) |
   | `SMS_SENDER_ID` | Sender name (e.g. `SUPACLEAN`); may be ignored in sandbox              | No       |
   | `TERMS_AND_CONDITIONS_URL` | Full URL for T&C (e.g. `https://yoursite.com/terms`); included in receipt SMS | No       |
   | `SMS_INCLUDE_SWAHILI`      | Set to `false` to send English only; default is to include Swahili translation in the same SMS | No       |

4. **Restart / redeploy**
   - Local: restart the server.
   - Render: save env vars and **Manual Deploy** so the new build uses them.

---

## Option 2: Twilio

1. **Sign up**
   - Go to [https://www.twilio.com](https://www.twilio.com) and create an account.
   - Add a **phone number** (or use trial number) and ensure you have credit.

2. **Get credentials**
   - **Console** → **Account** → **API keys & tokens**:
     - **Account SID**
     - **Auth Token**
   - **Phone Numbers** → **Manage** → **Active numbers**: note your **Twilio number** (e.g. `+1...` or a local number if available for Tanzania).

3. **Environment variables**
   - **Local:** add to `.env`.
   - **Render:** Service → **Environment** → Add each variable.

   | Variable              | Value                          | Required |
   |-----------------------|--------------------------------|----------|
   | `SMS_PROVIDER`        | `twilio`                       | Yes      |
   | `TWILIO_ACCOUNT_SID`  | Your Twilio Account SID        | Yes      |
   | `TWILIO_AUTH_TOKEN`   | Your Twilio Auth Token         | Yes      |
   | `TWILIO_PHONE_NUMBER` | Your Twilio number (e.g. +1234567890) | Yes  |

4. **Restart / redeploy**
   - Same as for Africa's Talking.

---

## Phone number format

- Numbers are normalized to **international format** (e.g. `+255...` for Tanzania).
- If the customer’s number is stored as `0712 345 678`, the system sends to `+255712345678`.

---

## Deployed app (Render)

1. Open your **Web Service** on Render → **Environment**.
2. Add the variables for your chosen provider (see tables above).
3. **Save**.
4. Trigger a **Manual Deploy** (or push a commit) so the server restarts with the new env.

SMS will then be sent when the app triggers notifications (order ready, reminders, etc.), as long as the customer has a phone number and SMS is enabled for them.

---

## Testing

- **Africa's Talking sandbox:** use their test numbers and sandbox URL; no real SMS is sent to arbitrary numbers until you go live and add credit.
- **Twilio trial:** you can only send to verified numbers until you upgrade.
- With **no API key** set, the app logs the message and does not call any provider (useful for local testing without sending real SMS).

### Test customer and “SMS notification failed”

If you create an order with a **test customer** and see **“SMS notification could not be sent”** (or the receipt SMS never arrives):

1. **Africa's Talking sandbox**  
   The sandbox **only delivers SMS to numbers you have verified** in the Africa's Talking dashboard. Your test customer’s phone number must be one of:
   - The sandbox’s own test numbers (see [Africa's Talking Sandbox](https://account.africastalking.com/sandbox)), or  
   - A number you have added and verified in **Sandbox → SMS → Test numbers**.  
   Any other number (e.g. a random 07xxxxxxxx) will **not** receive SMS in sandbox; the API may accept the request but not deliver, or return an error.

2. **Production (live)**  
   For real SMS, use your **production** Africa's Talking app (not sandbox): set `SMS_USERNAME` to your app username, leave `SMS_API_URL` unset, ensure you have **credit**, and use a valid Tanzanian number (e.g. 0752757635 → +255752757635).

3. **In the app**  
   When SMS fails, the app now shows a **warning toast** with the reason (e.g. “Customer has no phone number”, “SMS notifications are disabled for this customer”, or the provider error). Check that the customer has a **phone number** and **SMS notifications** enabled in their profile.

---

## What can stop SMS (checklist)

If SMS is not sending, work through this list:

1. **Environment variables**
   - **SMS_API_KEY** and **SMS_USERNAME** must be set (for Africa's Talking). Call **GET /api/sms-status** (e.g. `http://localhost:5000/api/sms-status`) to see if the server sees them (`configured: true`).
   - Restart the server after changing `.env`.

2. **Africa's Talking account**
   - **Credit:** Production SMS only works if your Africa's Talking account has **airtime/SMS balance**. Top up in the dashboard.
   - **Sandbox vs production:** Use **SMS_USERNAME=sandbox** and **SMS_API_URL=https://api.sandbox.africastalking.com/version1/messaging** for testing (sandbox only sends to their test numbers). For real SMS use your **app username** and leave **SMS_API_URL** unset (live API).
   - **API key and username must match:** Use a production key with production username; use sandbox key with `sandbox` username.

3. **Sender ID (production)**
   - Alphanumeric sender (e.g. **SUPACLEAN**) often must be **registered/approved** for your country (e.g. Tanzania). If it isn’t, the API may reject the send. In the Africa's Talking dashboard, check **SMS** → **Sender IDs** and request/activate one if needed.

4. **Customer**
   - Customer must have a **phone number** and **SMS notifications** enabled (customer profile). Missing or disabled = no send.

5. **Server logs**
   - When you trigger an SMS (e.g. mark order **Ready**), watch the **terminal where the Node server runs**. You’ll see either success (`Ready notification sent via sms to +255...`) or the real error (`Africa's Talking SMS failed: ...`). That message is the main clue.

---

## Swahili (Kiswahili) in the same SMS

Receipt, ready, and collection-reminder SMS include a **Swahili translation** in the same message (English first, then “— Kiswahili:” and the Swahili text). To send **English only**, set `SMS_INCLUDE_SWAHILI=false` in the server `.env`.

## Terms & Conditions link and PDF

- Set **TERMS_AND_CONDITIONS_URL** in server `.env` to the full URL customers see in the receipt SMS (e.g. `https://yoursite.com/terms`).
- The **Terms** page (`/terms`) shows the conditions in the app; optionally set **REACT_APP_TERMS_PDF_URL** in the client (e.g. in Render Environment) to a PDF URL to show an embedded PDF view on that page.
- Receipt SMS includes the T&C link only when `TERMS_AND_CONDITIONS_URL` is set.

## Where SMS is sent from in code

- **Server:** `server/utils/sms.js` – `sendSMS()`; message generators for receipt (with T&C link), ready (with delivery number), reminder (days in storage).
- **Notifications:** `server/utils/notifications.js` – uses `sendSMS()` for “ready”, “reminder”, etc.
- **Routes:** Order create no longer sends a second SMS; one receipt SMS is sent by the client after printing (`POST /orders/receipt/:receiptNumber/send-receipt-sms`). Order ready and send-reminder use the same SMS layer.

To add another carrier, add a new branch in `server/utils/sms.js` (e.g. `if (provider === 'yourcarrier')`) and call the carrier’s HTTP API, then set the env vars and document them in this file.
