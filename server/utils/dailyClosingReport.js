/**
 * SUPACLEAN daily closing report — WhatsApp text for director.
 * Each branch sends its own independent report.
 */
const db = require('../database/query');

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function isReconciledFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 't';
}

function buildDailyClosingReportText(row, branchName, cashierName, ymd, brand = null) {
  const businessName = (brand && brand.business_name) || 'SUPACLEAN';
  const opening = num(row.opening_balance);
  const openingDeclared = row.opening_cash_declared != null ? num(row.opening_cash_declared) : opening;
  const openingVariance = num(row.opening_variance);
  const cashSales = num(row.cash_sales);
  const bookSales = num(row.book_sales);
  const cardSales = num(row.card_sales);
  const mobileSales = num(row.mobile_money_sales);
  // Credit sales = NOT PAID (full amount) + advance remaining AR for this day.
  const creditSales = num(row.credit_sales);
  // Total sales = how today's orders were settled (cash/digital/credit). Collections stay separate.
  const totalSales = cashSales + mobileSales + cardSales + creditSales;
  const expensesCash = num(row.expenses_from_cash);
  const expensesBank = num(row.expenses_from_bank);
  const expensesMpesa = num(row.expenses_from_mpesa);
  const totalExpenses = expensesCash + expensesBank + expensesMpesa;
  const bankDepositsDay = num(row.bank_deposits);
  const cashOutDrawer = expensesCash + bankDepositsDay;
  const expectedCash = opening + cashSales + bookSales - cashOutDrawer;
  const actualCash = openingDeclared + cashSales + bookSales - cashOutDrawer;
  const dateFormatted = new Date(`${ymd}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const revenue = totalSales;
  const discounts = 0;
  const costOfGoods = 0;
  const grossProfit = revenue - discounts - costOfGoods;
  const operatingExpenses = totalExpenses;
  const netProfit = grossProfit - operatingExpenses;
  const fmt = (n) => Number(n).toLocaleString();

  return [
    `*${businessName}*`,
    '*Daily Closing Report*',
    '━━━━━━━━━━━━━━━━',
    `📅 ${dateFormatted}`,
    `👤 Cashier: ${cashierName || 'Cashier'}`,
    '',
    '💰 *OPENING CASH*',
    `Expected (Prev Closing): TZS ${fmt(opening)}`,
    `Declared (Session Start): TZS ${fmt(openingDeclared)}`,
    `Variance: ${openingVariance < 0 ? '-' : '+'}TZS ${fmt(Math.abs(openingVariance))}`,
    '',
    '📈 *SALES BREAKDOWN*',
    `• Cash Sales: TZS ${fmt(cashSales)}`,
    `• M-Pesa: TZS ${fmt(mobileSales)}`,
    `• Bank: TZS ${fmt(cardSales)}`,
    `• Credit Sales: TZS ${fmt(creditSales)}`,
    `*Total Sales: TZS ${fmt(totalSales)}*`,
    '',
    '📥 *CREDIT COLLECTIONS*',
    `Received Today: TZS ${fmt(bookSales)}`,
    '',
    '📤 *OUTFLOWS*',
    `• Operating expenses: TZS ${fmt(totalExpenses)}`,
    `• Bank deposits (cash to bank, not P&L): TZS ${fmt(bankDepositsDay)}`,
    `• Stock Purchases: TZS 0`,
    '',
    '📊 *PROFIT & LOSS*',
    `• Revenue: TZS ${fmt(revenue)}`,
    `• Less Discounts: (TZS ${fmt(discounts)})`,
    `• Cost of Goods: (TZS ${fmt(costOfGoods)})`,
    `• *Gross Profit: TZS ${fmt(grossProfit)}*`,
    `• Operating Expenses: (TZS ${fmt(operatingExpenses)})`,
    `*💰 NET PROFIT: TZS ${fmt(netProfit)}*`,
    '',
    'ℹ️ Opening cash variance is for reconciliation only (not extra P&L). A short may be an unrecorded expense or deposit—book the expense on this date (Expenses → adjust reconciled day) or record deposits under Cash Management.',
    '',
    '💵 *CASH POSITION*',
    `Opening (Expected): TZS ${fmt(opening)}`,
    `Opening (Declared): TZS ${fmt(openingDeclared)}`,
    `+ Cash Sales: TZS ${fmt(cashSales)}`,
    `+ Collections: TZS ${fmt(bookSales)}`,
    `- Cash expenses: TZS ${fmt(expensesCash)}`,
    `- Bank deposits: TZS ${fmt(bankDepositsDay)}`,
    `*Expected Cash: TZS ${fmt(expectedCash)}*`,
    `*Actual Cash: TZS ${fmt(actualCash)}*`,
    '━━━━━━━━━━━━━━━━',
    branchName ? `📍 ${branchName}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function getDirectorWhatsAppNumber() {
  const row = await db.get(
    'SELECT setting_value FROM settings WHERE setting_key = ?',
    ['manager_whatsapp_number']
  );
  const phone = row?.setting_value ? String(row.setting_value).trim() : '';
  return phone || null;
}

async function deliverDirectorDailyReport(row, branchName, cashierName, ymd, branchId = null) {
  const { getBrandSettings } = require('./brandSettings');
  const brand = await getBrandSettings();
  const directorPhone = await getDirectorWhatsAppNumber();
  if (!directorPhone) {
    return {
      report_sent: false,
      report_text: null,
      director_phone_wa: null,
      error: 'Director WhatsApp number is not configured. Set it in Admin → Branches.',
    };
  }

  const effectiveBranchId = branchId != null ? branchId : row?.branch_id;

  // Always resolve Credit Sales from NOT PAID / advance AR for this day
  // (covers older reconciled rows that still store 0 / missing credit_sales).
  let reportRow = row;
  try {
    const { calculateCreditSales } = require('./cashValidation');
    const creditSales = await calculateCreditSales(ymd, effectiveBranchId);
    reportRow = { ...row, branch_id: effectiveBranchId, credit_sales: creditSales };

    // Persist onto the daily summary even after reconcile so UI + resends stay correct.
    if (effectiveBranchId != null && ymd) {
      try {
        await db.run(
          `UPDATE daily_cash_summaries
           SET credit_sales = ?, updated_at = CURRENT_TIMESTAMP
           WHERE date = ? AND branch_id = ?`,
          [creditSales, ymd, effectiveBranchId]
        );
      } catch (persistErr) {
        console.error('Error persisting credit_sales for daily closing report:', persistErr.message);
      }
    }
  } catch (err) {
    console.error('Error calculating credit sales for daily closing report:', err.message, err.stack);
    reportRow = { ...row, credit_sales: num(row?.credit_sales) };
  }

  const report = buildDailyClosingReportText(reportRow, branchName, cashierName, ymd, brand);
  const creditSalesOut = num(reportRow?.credit_sales);
  const { sendWhatsApp, formatPhoneNumber } = require('./whatsapp');

  try {
    const waResult = await sendWhatsApp(directorPhone, report, {});
    const reportSent = !!(waResult && waResult.success);
    if (reportSent) {
      return {
        report_sent: true,
        report_text: report,
        director_phone_wa: null,
        credit_sales: creditSalesOut,
      };
    }
    return {
      report_sent: false,
      report_text: report,
      director_phone_wa: formatPhoneNumber(directorPhone).replace(/\D/g, ''),
      credit_sales: creditSalesOut,
    };
  } catch (err) {
    return {
      report_sent: false,
      report_text: report,
      director_phone_wa: formatPhoneNumber(directorPhone).replace(/\D/g, ''),
      error: err.message,
      credit_sales: creditSalesOut,
    };
  }
}

module.exports = {
  isReconciledFlag,
  buildDailyClosingReportText,
  deliverDirectorDailyReport,
  getDirectorWhatsAppNumber,
};
