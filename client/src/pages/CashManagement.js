import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getTodayCashSummary,
  createDailyCashSummary,
  reconcileDailyCash,
  sendDailyClosingReport,
  getBankDeposits,
  createBankDeposit,
  getActiveBankAccounts,
  getCashSummaryRange,
  getUnreconciledClosings,
  saveOpeningSession,
  getCashSalesDetailForDate,
  getBookSalesDetailForDate,
  recalculateDailyCashForDate,
  refreshCashChainFromDate,
  getExpenses
} from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import useHorizontalScrollRegion from '../hooks/useHorizontalScrollRegion';
import Loader from '../components/Loader';
import { receiptWidthCss } from '../utils/receiptPrintConfig';
import { formatCustomerReceiptId } from '../utils/receiptId';
import { getBusinessTodayYmd } from '../utils/businessDate';
import './CashManagement.css';

const CLOSE_STEP_LABELS = ['Opening', 'Review', 'Deposits & Expenses', 'Reconcile'];

const CashManagement = () => {
  const navigate = useNavigate();
  const { showToast, ToastContainer } = useToast();
  const { user, selectedBranchId, isAdmin, hasPermission } = useAuth();
  const canManageExpenses = hasPermission?.('canManageExpenses') ?? false;
  const canReconcile = hasPermission?.('canReconcile') ?? false;
  const [cashWorkspace, setCashWorkspace] = useState('close');
  const [closeStep, setCloseStep] = useState(1);
  const [todayExpenses, setTodayExpenses] = useState([]);
  const [expensesLoading, setExpensesLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [bankDeposits, setBankDeposits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showDepositForm, setShowDepositForm] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [depositForm, setDepositForm] = useState({
    amount: '',
    reference_number: '',
    bank_account_id: '',
    bank_name: '',
    notes: ''
  });
  const [activeBankAccounts, setActiveBankAccounts] = useState([]);
  const [manualWhatsAppReport, setManualWhatsAppReport] = useState(null);
  const [reportStartDate, setReportStartDate] = useState('');
  const [reportEndDate, setReportEndDate] = useState('');
  const [rangeData, setRangeData] = useState([]);
  const [rangeLoading, setRangeLoading] = useState(false);
  /** YYYY-MM-DD -> bank deposit rows for cashflow drill-down */
  const [rangeDepositsByDate, setRangeDepositsByDate] = useState({});
  const [cashflowExpanded, setCashflowExpanded] = useState({});
  const [chainRefreshingDate, setChainRefreshingDate] = useState('');
  const [unreconciledClosings, setUnreconciledClosings] = useState([]);
  const [unreconciledLoading, setUnreconciledLoading] = useState(false);
  const [reconcilingDate, setReconcilingDate] = useState('');
  const [sendingReportDate, setSendingReportDate] = useState('');
  const [openingCashInput, setOpeningCashInput] = useState('');
  const [openingNotes, setOpeningNotes] = useState('');
  const [savingOpening, setSavingOpening] = useState(false);
  const [salesDetailModal, setSalesDetailModal] = useState(null);
  const [salesDetailLines, setSalesDetailLines] = useState([]);
  const [salesDetailTotal, setSalesDetailTotal] = useState(0);
  const [salesDetailLoading, setSalesDetailLoading] = useState(false);
  const [salesDetailRecalculating, setSalesDetailRecalculating] = useState(false);
  const tableScrollHandlers = useHorizontalScrollRegion();
  const today = getBusinessTodayYmd();
  const isAllBranches = isAdmin && (selectedBranchId == null || selectedBranchId === '');
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  useEffect(() => {
    loadData();
  }, [selectedBranchId]);

  useEffect(() => {
    getActiveBankAccounts().then((res) => setActiveBankAccounts(res.data || [])).catch(() => setActiveBankAccounts([]));
  }, []);

  useEffect(() => {
    if (!summary) return;
    const declared = summary.opening_cash_declared != null ? Number(summary.opening_cash_declared) : Number(summary.opening_balance || 0);
    setOpeningCashInput(String(declared));
  }, [summary?.opening_cash_declared, summary?.opening_balance]);

  const loadData = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      const [summaryRes, depositsRes] = await Promise.all([
        getTodayCashSummary(),
        getBankDeposits({ start_date: today, end_date: today })
      ]);
      setSummary(summaryRes.data);
      setBankDeposits(depositsRes.data || []);
      setErrorMessage(null);
      if (summaryRes.fromCache && summaryRes.syncedAt) setLastSyncedAt(summaryRes.syncedAt);
      else if (depositsRes.fromCache && depositsRes.syncedAt) setLastSyncedAt(depositsRes.syncedAt);
      else setLastSyncedAt(null);
    } catch (error) {
      console.error('Error loading cash summary:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Network Error';
      if (errorMsg.includes('Select a branch') && !isAllBranches) {
        setErrorMessage('Please select a branch from the dropdown above to view cash management.');
      } else {
        setErrorMessage(errorMsg);
      }
      if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Network Error')) {
        showToast('Cannot connect to server. Please ensure the server is running.', 'error');
      } else if (!errorMsg.includes('Select a branch')) {
        showToast('Error loading cash summary: ' + errorMsg, 'error');
      }
      setSummary(null);
      setBankDeposits([]);
    } finally {
      setLoading(false);
    }
  };

  const loadTodayExpenses = async () => {
    setExpensesLoading(true);
    try {
      const res = await getExpenses({ start_date: today, end_date: today, limit: 100 });
      setTodayExpenses(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Error loading today expenses:', err);
      setTodayExpenses([]);
    } finally {
      setExpensesLoading(false);
    }
  };

  const loadUnreconciledClosings = async () => {
    setUnreconciledLoading(true);
    try {
      const res = await getUnreconciledClosings({ limit: 120 });
      setUnreconciledClosings(Array.isArray(res.data) ? res.data : []);
    } catch (error) {
      console.error('Error loading unreconciled closings:', error);
      setUnreconciledClosings([]);
      const errorMsg = error.response?.data?.error || error.message || 'Failed to load unreconciled closings';
      if (!String(errorMsg).includes('Select a branch')) {
        showToast('Error loading unreconciled closings: ' + errorMsg, 'error');
      }
    } finally {
      setUnreconciledLoading(false);
    }
  };

  useEffect(() => {
    loadUnreconciledClosings();
  }, [selectedBranchId]);

  useEffect(() => {
    if (closeStep === 3 && canManageExpenses && todayExpenses.length === 0) {
      loadTodayExpenses();
    }
  }, [closeStep]);

  const rowDateKey = (row) => (row?.date != null ? String(row.date).slice(0, 10) : '');

  const loadRangeReport = async () => {
    const start = reportStartDate || today;
    const end = reportEndDate || today;
    if (start > end) {
      showToast('Start date must be before or equal to end date.', 'error');
      return;
    }
    setRangeLoading(true);
    setRangeData([]);
    setRangeDepositsByDate({});
    try {
      const [rangeRes, depRes] = await Promise.all([
        getCashSummaryRange(start, end),
        getBankDeposits({ start_date: start, end_date: end }).catch(() => ({ data: [] }))
      ]);
      setRangeData(Array.isArray(rangeRes.data) ? rangeRes.data : []);
      const deps = Array.isArray(depRes.data) ? depRes.data : [];
      const by = {};
      deps.forEach((d) => {
        const k = String(d.date).slice(0, 10);
        if (!by[k]) by[k] = [];
        by[k].push(d);
      });
      setRangeDepositsByDate(by);
    } catch (err) {
      showToast('Error loading report: ' + (err.response?.data?.error || err.message), 'error');
      setRangeData([]);
    } finally {
      setRangeLoading(false);
    }
  };

  const handleRefreshCashChain = async (dateStr) => {
    const d = String(dateStr).slice(0, 10);
    if (!d) return;
    if (summary?.all_branches) {
      showToast('Select a specific branch to refresh the cash chain.', 'error');
      return;
    }
    setChainRefreshingDate(d);
    try {
      await refreshCashChainFromDate(d);
      showToast(`Recalculated from ${d} forward (unreconciled days). Bank deposits and following days’ openings are updated.`, 'success');
      await loadRangeReport();
      loadUnreconciledClosings();
      if (d === today) loadData();
    } catch (error) {
      showToast(error.response?.data?.error || error.message || 'Refresh failed', 'error');
    } finally {
      setChainRefreshingDate('');
    }
  };

  const downloadCsv = (filename, rows) => {
    const csv = rows.map((r) => r.map((v) => {
      const s = v == null ? '' : String(v);
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportReconciliationCsv = () => {
    if (!unreconciledClosings.length) {
      showToast('No reconciliation data to export.', 'info');
      return;
    }
    const rows = [
      ['Date', 'Branch', 'ExpectedOpening', 'OpeningVariance', 'CashSales', 'BookSales', 'ExpensesCash', 'BankDeposits', 'ClosingBalance', 'Status']
    ];
    unreconciledClosings.forEach((row) => {
      rows.push([
        row.date,
        row.branch_name || row.branch_id || '',
        Number(row.opening_balance || 0).toFixed(2),
        Number(row.opening_variance || 0).toFixed(2),
        Number(row.cash_sales || 0).toFixed(2),
        Number(row.book_sales || 0).toFixed(2),
        Number(row.expenses_from_cash || 0).toFixed(2),
        Number(row.bank_deposits || 0).toFixed(2),
        Number(row.closing_balance || 0).toFixed(2),
        'Pending'
      ]);
    });
    downloadCsv(`reconciliation-pending-${today}.csv`, rows);
    showToast('Reconciliation CSV exported.', 'success');
  };

  const exportCashflowCsv = () => {
    if (!rangeData.length) {
      showToast('No cashflow range data to export.', 'info');
      return;
    }
    const rows = [
      ['Date', 'Opening', 'OpeningVariance', 'CashSales', 'BookSales', 'CardSales', 'MobileMoneySales', 'ExpensesCash', 'BankDeposits', 'Closing']
    ];
    rangeData.forEach((row) => {
      rows.push([
        row.date,
        Number(row.opening_balance || 0).toFixed(2),
        Number(row.opening_variance || 0).toFixed(2),
        Number(row.cash_sales || 0).toFixed(2),
        Number(row.book_sales || 0).toFixed(2),
        Number(row.card_sales || 0).toFixed(2),
        Number(row.mobile_money_sales || 0).toFixed(2),
        Number(row.expenses_from_cash || 0).toFixed(2),
        Number(row.bank_deposits || 0).toFixed(2),
        Number(row.closing_balance || 0).toFixed(2)
      ]);
    });
    const start = reportStartDate || today;
    const end = reportEndDate || today;
    downloadCsv(`cashflow-${start}-to-${end}.csv`, rows);
    showToast('Cashflow CSV exported.', 'success');
  };

  const handleTestReceiptPrint = () => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Test receipt</title>
      <style>
        @page { size: ${receiptWidthCss} auto; margin: 0; }
        body { font-family: 'Courier New', monospace; margin: 0; padding: 12px; width: ${receiptWidthCss}; max-width: 100%; color: #000; font-size: 10pt; text-align: center; }
      </style></head><body>
      <p><strong>SUPACLEAN</strong></p>
      <p>Test receipt – PDA / thermal printer</p>
      <p>${new Date().toLocaleString()}</p>
      <p>If this prints, your POS printer is working.</p>
      </body></html>`;
    const isPDA = typeof window !== 'undefined' && window.innerWidth <= 768;
    const w = !isPDA ? window.open('', '_blank', 'width=320,height=400') : null;
    if (w && !w.closed) {
      w.document.open();
      w.document.write(html);
      w.document.close();
      setTimeout(() => {
        try { w.focus(); w.print(); } catch (e) { console.warn('Test print:', e); }
      }, 500);
      showToast('Print dialog opened. Choose your PDA printer.', 'info');
    } else {
      // PDA / popup blocked: use iframe so only test receipt prints, never the main page
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;border:none;visibility:hidden';
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow.document;
      doc.open();
      doc.write(html);
      doc.close();
      iframe.contentWindow.onload = () => {
        setTimeout(() => {
          try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) {}
          setTimeout(() => { try { iframe.parentNode.removeChild(iframe); } catch (e) {} }, 1500);
        }, 400);
      };
      showToast('Print dialog opened. Choose your PDA printer.', 'info');
    }
  };

  const handleSaveSummary = async () => {
    setSaving(true);
    try {
      const res = await createDailyCashSummary({
        date: today,
        bank_deposits: summary.bank_deposits || 0,
        notes: summary.notes || ''
      });
      setSummary(res.data);
      showToast('Cash summary saved successfully', 'success');
      loadData();
    } catch (error) {
      showToast('Error saving cash summary: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveOpeningSession = async () => {
    if (summary?.all_branches) {
      showToast('Select a specific branch to set opening session.', 'error');
      return;
    }
    const val = Number(openingCashInput);
    if (!Number.isFinite(val) || val < 0) {
      showToast('Enter a valid opening cash amount.', 'error');
      return;
    }
    setSavingOpening(true);
    try {
      await saveOpeningSession(today, { opening_cash: val, notes: openingNotes });
      showToast('Opening session saved.', 'success');
      setOpeningNotes('');
      loadData();
    } catch (error) {
      showToast('Error saving opening session: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setSavingOpening(false);
    }
  };

  const isReconciled = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 't';
  const summaryReconciled = summary ? isReconciled(summary.is_reconciled) : false;

  const applyReportDeliveryResult = (data, successLabel) => {
    if (data.report_sent) {
      showToast(successLabel || 'Report sent to director on WhatsApp.', 'success');
      setManualWhatsAppReport(null);
    } else if (data.report_text && data.director_phone_wa) {
      const url = `https://wa.me/${data.director_phone_wa}?text=${encodeURIComponent(data.report_text)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
      showToast('WhatsApp opened — tap Send to deliver the report to the director.', 'success');
      setManualWhatsAppReport({ reportText: data.report_text, directorPhoneWa: data.director_phone_wa });
    } else if (data.report_error) {
      showToast(data.report_error, 'error');
    } else {
      showToast('Set Director WhatsApp in Admin → Branches to send the report.', 'info');
    }
  };

  const handleSendToDirector = async (dateToSend = today) => {
    if (!canReconcile) {
      showToast('Only a branch manager or admin can send the director report.', 'error');
      return;
    }
    if (summary?.all_branches) {
      showToast('Select a specific branch (e.g. UH or MN) to send that branch’s closing report.', 'error');
      return;
    }
    setSendingReportDate(dateToSend);
    setManualWhatsAppReport(null);
    try {
      const cashierName = user?.fullName || user?.username || 'Cashier';
      const result = await sendDailyClosingReport(dateToSend, { sent_by: cashierName });
      const data = result?.data || result;
      applyReportDeliveryResult(data, `Daily closing report for ${dateToSend} sent to director.`);
    } catch (error) {
      showToast('Error: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setSendingReportDate('');
    }
  };

  const handleReconcile = async () => {
    if (!canReconcile) {
      showToast('Only a branch manager or admin can reconcile the day.', 'error');
      return;
    }
    if (summary?.all_branches) {
      showToast('Select a specific branch in the header before reconciling.', 'error');
      return;
    }
    if (!window.confirm(
      'Reconcile this branch for today and send the daily closing report to the director?\n\nReconciliation locks this day for this branch only (other branches are unaffected).'
    )) return;
    setManualWhatsAppReport(null);
    try {
      const cashierName = user?.fullName || user?.username || 'Cashier';
      const result = await reconcileDailyCash(today, { reconciled_by: cashierName });
      const data = result?.data || result;
      applyReportDeliveryResult(data, 'Reconciled. Report sent to director.');
      loadData();
      loadUnreconciledClosings();
    } catch (error) {
      const code = error.response?.data?.code;
      const msg = error.response?.data?.error || error.message;
      if (code === 'already_reconciled') {
        showToast(msg + ' Use “Send to director” instead.', 'warning');
      } else {
        showToast('Error: ' + msg, 'error');
      }
    }
  };

  const openWhatsAppToSendReport = () => {
    if (!manualWhatsAppReport?.directorPhoneWa || !manualWhatsAppReport?.reportText) return;
    window.open(`https://wa.me/${manualWhatsAppReport.directorPhoneWa}?text=${encodeURIComponent(manualWhatsAppReport.reportText)}`, '_blank', 'noopener,noreferrer');
  };

  const handleReconcileUnreconciledDate = async (dateToReconcile) => {
    if (!canReconcile) {
      showToast('Only a branch manager or admin can reconcile.', 'error');
      return;
    }
    if (!dateToReconcile) return;
    if (summary?.all_branches) {
      showToast('Select a specific branch to reconcile past dates.', 'error');
      return;
    }
    if (!window.confirm(
      `Reconcile ${dateToReconcile} for this branch and send the daily closing report to the director?\n\nThis locks that day for this branch only.`
    )) return;
    setReconcilingDate(dateToReconcile);
    setManualWhatsAppReport(null);
    try {
      const cashierName = user?.fullName || user?.username || 'Cashier';
      const result = await reconcileDailyCash(dateToReconcile, { reconciled_by: cashierName });
      const data = result?.data || result;
      applyReportDeliveryResult(data, `Reconciled ${dateToReconcile}. Report sent to director.`);
      loadUnreconciledClosings();
      if (dateToReconcile === today) loadData();
      if (reportStartDate || reportEndDate) loadRangeReport();
    } catch (error) {
      const code = error.response?.data?.code;
      const msg = error.response?.data?.error || error.message;
      if (code === 'already_reconciled') {
        showToast(msg + ' Use “Send to director” instead.', 'warning');
      } else {
        showToast('Error: ' + msg, 'error');
      }
    } finally {
      setReconcilingDate('');
    }
  };

  const handleAddDeposit = async (e) => {
    e.preventDefault();
    try {
      await createBankDeposit({
        date: today,
        amount: depositForm.amount,
        reference_number: depositForm.reference_number || null,
        bank_account_id: (depositForm.bank_account_id && depositForm.bank_account_id !== 'other') ? Number(depositForm.bank_account_id) : null,
        bank_name: (depositForm.bank_account_id === '' || depositForm.bank_account_id === 'other') ? (depositForm.bank_name || null) : null,
        notes: depositForm.notes || null,
        created_by: 'Cashier'
      });
      showToast('Bank deposit added', 'success');
      setShowDepositForm(false);
      setDepositForm({ amount: '', reference_number: '', bank_account_id: '', bank_name: '', notes: '' });
      loadData();
      loadUnreconciledClosings();
    } catch (error) {
      showToast('Error adding deposit: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  const formatDetailWhen = (v) => {
    if (!v) return '—';
    try {
      return new Date(v).toLocaleString();
    } catch (e) {
      return String(v);
    }
  };

  const closeSalesDetailModal = () => {
    setSalesDetailModal(null);
    setSalesDetailLines([]);
    setSalesDetailTotal(0);
    setSalesDetailLoading(false);
  };

  const loadSalesDetailLines = async (kind) => {
    setSalesDetailLoading(true);
    try {
      const res =
        kind === 'cash' ? await getCashSalesDetailForDate(today) : await getBookSalesDetailForDate(today);
      const data = res.data || {};
      setSalesDetailLines(Array.isArray(data.lines) ? data.lines : []);
      setSalesDetailTotal(Number(data.total) || 0);
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Failed to load detail', 'error');
      setSalesDetailLines([]);
      setSalesDetailTotal(0);
    } finally {
      setSalesDetailLoading(false);
    }
  };

  const openSalesDetailModal = async (kind) => {
    if (summary?.all_branches) {
      showToast('Select a specific branch to view line items.', 'error');
      return;
    }
    setSalesDetailModal(kind);
    if (summary?.is_reconciled) {
      try {
        if (isAdmin) {
          await recalculateDailyCashForDate(today, { force: true });
          const summaryRes = await getTodayCashSummary();
          if (summaryRes?.data) setSummary(summaryRes.data);
        }
      } catch (err) {
        showToast(err.response?.data?.error || err.message || 'Could not refresh summary', 'error');
      }
    }
    await loadSalesDetailLines(kind);
  };

  const handleRecalculateFromSalesDetailModal = async () => {
    setSalesDetailRecalculating(true);
    try {
      await recalculateDailyCashForDate(today, { force: !!(summary?.is_reconciled && isAdmin) });
      showToast(
        summary?.is_reconciled && isAdmin
          ? 'Stored summary updated from live data (day stays reconciled).'
          : summary?.is_reconciled
            ? 'Day is reconciled. Ask an admin to force-refresh or unreconcile first.'
            : 'Daily totals refreshed from live data.',
        'success'
      );
      await loadData();
      if (salesDetailModal) await loadSalesDetailLines(salesDetailModal);
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Recalculate failed', 'error');
    } finally {
      setSalesDetailRecalculating(false);
    }
  };

  if (loading) {
    return <Loader message="Loading cash summary…" fullPage />;
  }

  if (!summary) {
    return (
      <div className="cash-management-page">
        <ToastContainer />
        <div className="error-message">
          {errorMessage || 'Unable to load cash summary'}
        </div>
        {errorMessage && (
          <button onClick={loadData} className="btn-secondary" type="button" style={{ marginTop: '1rem' }}>
            🔄 Try again
          </button>
        )}
      </div>
    );
  }

  const cashInHand = toNum(summary.opening_balance) +
                     toNum(summary.cash_sales) +
                     toNum(summary.book_sales) -
                     toNum(summary.expenses_from_cash) -
                     toNum(summary.bank_deposits);
  const declaredOpening = summary.opening_cash_declared != null ? toNum(summary.opening_cash_declared) : toNum(summary.opening_balance);
  const openingVariance = toNum(summary.opening_variance);
  const openingBalanced = Math.abs(openingVariance) < 0.01;

  return (
    <div className="cash-management-page">
      <ToastContainer />
      {salesDetailModal && (
        <div
          className="cash-detail-modal-overlay"
          onClick={closeSalesDetailModal}
          role="dialog"
          aria-modal="true"
          aria-label={salesDetailModal === 'cash' ? 'Cash sales lines' : 'Book sales lines'}
        >
          <div className="cash-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cash-detail-modal-header">
              <h3 id="cash-detail-modal-title">
                {salesDetailModal === 'cash'
                  ? 'Cash sales — today'
                  : 'Book sales — cash collections today'}
              </h3>
              <button
                type="button"
                className="cash-detail-modal-close"
                onClick={closeSalesDetailModal}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p className="cash-detail-modal-sub">
              {new Date(today).toLocaleDateString('en-GB', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                year: 'numeric'
              })}
              {' · '}
              Sum of listed lines should match the summary total. Fix payments in{' '}
              <button type="button" className="btn-link" onClick={() => navigate('/orders')}>
                Orders
              </button>
              {' or '}
              <button type="button" className="btn-link" onClick={() => navigate('/collection')}>
                Collection
              </button>
              , then refresh totals.
              {salesDetailModal === 'book' && (
                <>
                  {' '}
                  Book sales lists cash from advances and later payments only; same-day paid-in-full register
                  sales are in Cash sales, not here.
                </>
              )}
            </p>
            {salesDetailLoading ? (
              <p className="cash-detail-loading">Loading…</p>
            ) : salesDetailModal === 'cash' ? (
              <div className="cash-detail-table-wrap interactive-scroll-region" tabIndex={0} role="region" aria-labelledby="cash-detail-modal-title" {...tableScrollHandlers}>
                <table className="cash-detail-table">
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>Customer</th>
                      <th className="num">Paid (TSh)</th>
                      <th>When</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesDetailLines.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-muted">No cash sales rows for this date.</td>
                      </tr>
                    ) : (
                      salesDetailLines.map((row) => (
                        <tr key={`cs-${row.receipt_number || ''}-${row.order_id}`}>
                          <td>
                            {formatCustomerReceiptId(row.receipt_number, row.item_count) || '—'}
                          </td>
                          <td>
                            <div>{row.customer_name || '—'}</div>
                            <div className="text-muted small">{row.customer_phone || ''}</div>
                          </td>
                          <td className="num">{Number(row.paid_amount || 0).toLocaleString()}</td>
                          <td>{formatDetailWhen(row.order_date)}</td>
                          <td>
                            {row.receipt_number ? (
                              <button
                                type="button"
                                className="btn-link"
                                onClick={() =>
                                  navigate(`/orders?receipt=${encodeURIComponent(row.receipt_number)}`)
                                }
                              >
                                Open
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="cash-detail-table-wrap interactive-scroll-region" tabIndex={0} role="region" aria-labelledby="cash-detail-modal-title" {...tableScrollHandlers}>
                <table className="cash-detail-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Receipt</th>
                      <th>Customer</th>
                      <th className="num">Amount (TSh)</th>
                      <th>Recorded by</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesDetailLines.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-muted">No book sales (cash payment) rows for this date.</td>
                      </tr>
                    ) : (
                      salesDetailLines.map((row) => (
                        <tr key={`bs-${row.transaction_id}`}>
                          <td>{formatDetailWhen(row.transaction_date)}</td>
                          <td>{formatCustomerReceiptId(row.receipt_number) || '—'}</td>
                          <td>
                            <div>{row.customer_name || '—'}</div>
                            <div className="text-muted small">{row.customer_phone || ''}</div>
                          </td>
                          <td className="num">{Number(row.amount || 0).toLocaleString()}</td>
                          <td>{row.created_by || '—'}</td>
                          <td>
                            {row.receipt_number ? (
                              <button
                                type="button"
                                className="btn-link"
                                onClick={() =>
                                  navigate(`/orders?receipt=${encodeURIComponent(row.receipt_number)}`)
                                }
                              >
                                Open
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <div className="cash-detail-modal-footer">
              <div className="cash-detail-total-row">
                <strong>Lines total:</strong>{' '}
                <span className="num">TSh {salesDetailTotal.toLocaleString()}</span>
                {salesDetailModal === 'cash' && (
                  <span className="text-muted cash-detail-compare">
                    {' · '}Summary: TSh {toNum(summary.cash_sales).toLocaleString()}
                  </span>
                )}
                {salesDetailModal === 'book' && (
                  <span className="text-muted cash-detail-compare">
                    {' · '}Summary: TSh {toNum(summary.book_sales).toLocaleString()}
                  </span>
                )}
              </div>
              <div className="cash-detail-actions">
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  onClick={handleRecalculateFromSalesDetailModal}
                  disabled={salesDetailRecalculating}
                  title={
                    summary.is_reconciled
                      ? 'Recompute cash/book sales and closing from live data; reconciliation stays locked.'
                      : undefined
                  }
                >
                  {salesDetailRecalculating
                    ? 'Refreshing…'
                    : summary.is_reconciled
                      ? 'Refresh stored summary'
                      : 'Refresh totals'}
                </button>
                <button type="button" className="btn-primary btn-small" onClick={closeSalesDetailModal}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {lastSyncedAt && (
        <div className="sync-cache-banner" role="status">
          Showing data from last sync — {new Date(lastSyncedAt).toLocaleString()}
        </div>
      )}
      {manualWhatsAppReport && (
        <div className="manual-whatsapp-banner" role="alert">
          <span>Send report to director again?</span>
          <button type="button" className="btn-link" onClick={openWhatsAppToSendReport}>Open WhatsApp</button>
          <button type="button" className="btn-link muted" onClick={() => setManualWhatsAppReport(null)} aria-label="Dismiss">Dismiss</button>
        </div>
      )}
      <div className="page-header page-header-modern">
        <div>
          <h1>Cash Management</h1>
          <p className="subtitle">
            {summary.all_branches ? 'All branches (consolidated) · ' : ''}
            Daily cash summary - {new Date(today).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
        <div className="header-actions">
          <button onClick={handleTestReceiptPrint} className="dk-btn dk-btn--secondary dk-btn--md" type="button" title="Open print dialog to test PDA/thermal printer">
            🖨️ Test receipt print
          </button>
          <button onClick={loadData} className="dk-btn dk-btn--secondary dk-btn--md" type="button">
            🔄 Refresh
          </button>
          {!summary.all_branches && !summaryReconciled && canReconcile && (
            <button onClick={handleReconcile} className="dk-btn dk-btn--success dk-btn--md" type="button">
              ✅ Reconcile & send to director
            </button>
          )}
          {!summary.all_branches && summaryReconciled && canReconcile && (
            <button
              onClick={() => handleSendToDirector(today)}
              className="dk-btn dk-btn--primary dk-btn--md"
              type="button"
              disabled={sendingReportDate === today}
            >
              {sendingReportDate === today ? 'Sending…' : '📤 Send to director'}
            </button>
          )}
        </div>
      </div>

      {/* Workspace tab bar */}
      <nav className="cash-workspace-tabs" aria-label="Cash management workspace">
        <button
          type="button"
          className={`tab-btn ${cashWorkspace === 'close' ? 'active' : ''}`}
          onClick={() => setCashWorkspace('close')}
        >
          Today&apos;s close
        </button>
        <button
          type="button"
          className={`tab-btn ${cashWorkspace === 'history' ? 'active' : ''}`}
          onClick={() => setCashWorkspace('history')}
        >
          History
        </button>
      </nav>

      {/* Step indicator for close wizard */}
      {cashWorkspace === 'close' && (
        <div className="cash-step-indicator" role="group" aria-label="Close-day steps">
          {CLOSE_STEP_LABELS.map((label, i) => {
            const step = i + 1;
            return (
              <button
                key={step}
                type="button"
                className={`v2-step-pill ${closeStep === step ? 'active' : ''} ${closeStep > step ? 'done' : ''}`}
                onClick={() => setCloseStep(step)}
              >
                <span className="v2-step-pill__num">{step}</span>
                <span className="v2-step-pill__label">{label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Close wizard: step 1 – Opening ── */}
      {cashWorkspace === 'close' && closeStep === 1 && !summary.all_branches && (
        <div className="opening-session-card">
          <h2>Opening Session</h2>
          <p className="subtitle">
            {summary.is_reconciled
              ? 'This day is already reconciled. Opening session is locked and shown for reference.'
              : 'Enter physical cash at start of day and compare to previous closing.'}
          </p>
          <div className="opening-session-grid">
            <div className="form-group">
              <label>Expected opening (prior day&apos;s cash)</label>
              <input type="text" value={`TSh ${Number(summary.opening_balance || 0).toLocaleString()}`} disabled />
              <small className="text-muted" style={{ display: 'block', marginTop: 6 }}>
                Uses the previous calendar day&apos;s <strong>reconciled closing</strong> (frozen when that day was reconciled), so it does not drift if totals change later.
              </small>
            </div>
            <div className="form-group">
              <label>Declared opening cash *</label>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={openingCashInput}
                onChange={(e) => setOpeningCashInput(e.target.value)}
                placeholder={String(declaredOpening || 0)}
                disabled={summary.is_reconciled}
              />
            </div>
            <div className="form-group">
              <label>Session note (optional)</label>
              <input
                type="text"
                value={openingNotes}
                onChange={(e) => setOpeningNotes(e.target.value)}
                placeholder="Reason if short/over"
                disabled={summary.is_reconciled}
              />
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSaveOpeningSession}
              disabled={savingOpening || summary.is_reconciled}
            >
              {summary.is_reconciled ? 'Opening Session Locked' : (savingOpening ? 'Saving...' : 'Save Opening Session')}
            </button>
          </div>
          <div className={`opening-variance-banner ${openingBalanced ? 'ok' : (openingVariance < 0 ? 'short' : 'over')}`}>
            {openingBalanced
              ? 'Balanced: Opening cash matches previous closing.'
              : openingVariance < 0
                ? `Short at opening: TSh ${Math.abs(openingVariance).toLocaleString()}`
                : `Over at opening: TSh ${openingVariance.toLocaleString()}`}
          </div>
        </div>
      )}

      {cashWorkspace === 'close' && closeStep === 1 && summary.all_branches && (
        <div className="all-branches-notice" role="status">
          Viewing consolidated totals. Select a branch above to set opening session.
        </div>
      )}

      {/* ── Close wizard: step 2 – Review ── */}
      {cashWorkspace === 'close' && closeStep === 2 && (
      <>
      <div className="cash-summary-table-section">
        <h2>Daily cash summary</h2>
        <div className="cash-summary-table-wrap interactive-scroll-region" tabIndex={0} role="region" aria-label="Daily cash summary table" {...tableScrollHandlers}>
          <table className="cash-summary-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="num">Amount (TSh)</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>🌅 Opening Balance</td>
                <td className="num">{parseFloat(summary.opening_balance || 0).toLocaleString()}</td>
                <td className="text-muted">From previous day&apos;s closing balance</td>
              </tr>
              <tr>
                <td>🧾 Declared Opening Cash</td>
                <td className="num">{declaredOpening.toLocaleString()}</td>
                <td className="text-muted">Cashier opening session declaration</td>
              </tr>
              <tr>
                <td>⚖️ Opening Variance</td>
                <td className={`num ${openingVariance < 0 ? 'value-negative' : 'value-positive'}`}>
                  {openingVariance < 0 ? '-' : '+'} {Math.abs(openingVariance).toLocaleString()}
                </td>
                <td className="text-muted">Difference between expected and declared opening cash</td>
              </tr>
              <tr>
                <td>💰 Cash Sales</td>
                <td className="num">{parseFloat(summary.cash_sales || 0).toLocaleString()}</td>
                <td className="text-muted">
                  <div className="cash-metric-desc">
                    <span>Paid in full with cash today</span>
                    {!summary.all_branches && (
                      <button
                        type="button"
                        className="btn-link cash-metric-view-btn"
                        onClick={() => openSalesDetailModal('cash')}
                      >
                        View lines
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              <tr>
                <td>📖 Book Sales</td>
                <td className="num">{parseFloat(summary.book_sales || 0).toLocaleString()}</td>
                <td className="text-muted">
                  <div className="cash-metric-desc">
                    <span>Cash collected on account (receive payment / collection)</span>
                    {!summary.all_branches && (
                      <button
                        type="button"
                        className="btn-link cash-metric-view-btn"
                        onClick={() => openSalesDetailModal('book')}
                      >
                        View lines
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              <tr>
                <td>💳 Card & M-Pesa</td>
                <td className="num">{(toNum(summary.card_sales) + toNum(summary.mobile_money_sales)).toLocaleString()}</td>
                <td className="text-muted">Card: {parseFloat(summary.card_sales || 0).toLocaleString()} | M-Pesa: {parseFloat(summary.mobile_money_sales || 0).toLocaleString()}</td>
              </tr>
              <tr>
                <td>📝 Expenses (Cash)</td>
                <td className="num">- {parseFloat(summary.expenses_from_cash || 0).toLocaleString()}</td>
                <td className="text-muted">Paid from cash</td>
              </tr>
              <tr>
                <td>🏦 Bank Deposits</td>
                <td className="num">- {parseFloat(summary.bank_deposits || 0).toLocaleString()}</td>
                <td className="text-muted">Deposited to bank</td>
              </tr>
              <tr className="total-row">
                <td><strong>💵 Cash in Hand (Closing Balance)</strong></td>
                <td className="num"><strong>TSh {parseFloat(cashInHand).toLocaleString()}</strong></td>
                <td className="text-muted">Opening + Cash Sales + Book Collections - Cash Expenses - Bank Deposits</td>
              </tr>
              <tr className="total-row">
                <td><strong>🏁 Closing Balance (Same as Cash in Hand)</strong></td>
                <td className="num"><strong>TSh {parseFloat(summary.closing_balance || cashInHand).toLocaleString()}</strong></td>
                <td className="text-muted">{summary.is_reconciled ? '✅ Reconciled' : 'Pending reconciliation'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Calculation Breakdown as table */}
      <div className="breakdown-card">
        <h2>Calculation Breakdown</h2>
        <div className="breakdown-table-wrap interactive-scroll-region" tabIndex={0} role="region" aria-label="Cash breakdown table" {...tableScrollHandlers}>
          <table className="breakdown-table">
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">Value (TSh)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Opening Balance</td>
                <td className="num value-positive">+ {parseFloat(summary.opening_balance || 0).toLocaleString()}</td>
              </tr>
              <tr>
                <td>Cash Sales</td>
                <td className="num value-positive">+ {parseFloat(summary.cash_sales || 0).toLocaleString()}</td>
              </tr>
              <tr>
                <td>Book Sales (Collections)</td>
                <td className="num value-positive">+ {parseFloat(summary.book_sales || 0).toLocaleString()}</td>
              </tr>
              <tr>
                <td>Expenses from Cash</td>
                <td className="num value-negative">- {parseFloat(summary.expenses_from_cash || 0).toLocaleString()}</td>
              </tr>
              <tr>
                <td>Bank Deposits</td>
                <td className="num value-negative">- {parseFloat(summary.bank_deposits || 0).toLocaleString()}</td>
              </tr>
              <tr className="breakdown-total-row">
                <td><strong>Cash in Hand</strong></td>
                <td className="num"><strong>TSh {parseFloat(cashInHand).toLocaleString()}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      </>
      )}

      {/* ── Close wizard: step 3 – Deposits & Expenses ── */}
      {cashWorkspace === 'close' && closeStep === 3 && (
      <>
      {summary.all_branches && (
        <div className="all-branches-notice" role="status">
          Viewing consolidated totals for all branches. Select a branch above to reconcile or add deposits.
        </div>
      )}

      <div className="deposits-section" id="bank-deposits-section">
        <div className="section-header">
          <h2>🏦 Bank Deposits</h2>
          {!summary.all_branches && (
            <button 
              onClick={() => setShowDepositForm(!showDepositForm)} 
              className="btn-primary btn-small"
              type="button"
            >
              {showDepositForm ? 'Cancel' : '+ Add Deposit'}
            </button>
          )}
        </div>

        {showDepositForm && (
          <form onSubmit={handleAddDeposit} className="deposit-form">
            <div className="form-row">
              <div className="form-group">
                <label>Amount *</label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={depositForm.amount}
                  onChange={(e) => setDepositForm({ ...depositForm, amount: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>Reference Number</label>
                <input
                  type="text"
                  value={depositForm.reference_number}
                  onChange={(e) => setDepositForm({ ...depositForm, reference_number: e.target.value })}
                  placeholder="Optional"
                />
              </div>
              <div className="form-group">
                <label>Bank / Account</label>
                <select
                  value={depositForm.bank_account_id}
                  onChange={(e) => setDepositForm({ ...depositForm, bank_account_id: e.target.value, bank_name: e.target.value === 'other' ? depositForm.bank_name : '' })}
                >
                  <option value="">Select bank...</option>
                  {activeBankAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>{acc.name}{acc.account_number ? ` (${acc.account_number})` : ''}</option>
                  ))}
                  <option value="other">Other (type below)</option>
                </select>
                {(depositForm.bank_account_id === 'other' || !depositForm.bank_account_id) && (
                  <input
                    type="text"
                    className="bank-name-other"
                    value={depositForm.bank_name}
                    onChange={(e) => setDepositForm({ ...depositForm, bank_name: e.target.value })}
                    placeholder="Bank name if not in list"
                    style={{ marginTop: 8 }}
                  />
                )}
              </div>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea
                value={depositForm.notes}
                onChange={(e) => setDepositForm({ ...depositForm, notes: e.target.value })}
                rows="2"
                placeholder="Additional notes..."
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn-primary">Save Deposit</button>
              <button type="button" onClick={() => setShowDepositForm(false)} className="btn-secondary">
                Cancel
              </button>
            </div>
          </form>
        )}

        {bankDeposits.length > 0 ? (
          <div className="deposits-table-wrap interactive-scroll-region" tabIndex={0} role="region" aria-label="Bank deposits table" {...tableScrollHandlers}>
            <table className="deposits-table">
              <thead>
                <tr>
                  <th className="num">Amount (TSh)</th>
                  <th>Bank / Account</th>
                  <th>Reference</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {bankDeposits.map(deposit => (
                  <tr key={deposit.id}>
                    <td className="num"><strong>{parseFloat(deposit.amount).toLocaleString()}</strong></td>
                    <td>{deposit.bank_account_name || deposit.bank_name || '—'}</td>
                    <td>{deposit.reference_number ? <span className="reference">{deposit.reference_number}</span> : '—'}</td>
                    <td className="deposit-notes-cell">{deposit.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <p>No bank deposits recorded today</p>
          </div>
        )}
      </div>

      {/* Inline today's expenses panel */}
      {canManageExpenses && (
        <div className="cash-today-expenses">
          <div className="section-header">
            <h2>Today&apos;s Expenses</h2>
            <button type="button" className="btn-small btn-secondary" onClick={() => navigate('/expenses')}>
              Full Expenses Page
            </button>
          </div>
          {expensesLoading ? (
            <p className="range-empty">Loading expenses...</p>
          ) : todayExpenses.length > 0 ? (
            <div className="deposits-table-wrap interactive-scroll-region" tabIndex={0} role="region" aria-label="Today expenses table" {...tableScrollHandlers}>
              <table className="deposits-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="num">Amount (TSh)</th>
                    <th>Payment</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {todayExpenses.map((exp) => (
                    <tr key={exp.id}>
                      <td>{exp.category || exp.expense_type || '—'}</td>
                      <td className="num">{parseFloat(exp.amount || 0).toLocaleString()}</td>
                      <td>{exp.payment_source || exp.payment_method || '—'}</td>
                      <td className="deposit-notes-cell">{exp.description || exp.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state"><p>No expenses recorded today</p></div>
          )}
        </div>
      )}
      </>
      )}

      {/* ── Close wizard: step 4 – Reconcile ── */}
      {cashWorkspace === 'close' && closeStep === 4 && (
      <>
      {/* Action Buttons - only for single branch */}
      {!summary.all_branches && !summary.is_reconciled && (
        <div className="action-buttons">
          <button onClick={handleSaveSummary} className="btn-primary btn-large" disabled={saving}>
            {saving ? 'Saving...' : '💾 Save Summary'}
          </button>
        </div>
      )}

      {summary.is_reconciled && (summary.all_branches ? (
        <div className="reconciled-badge">
          <span>✅ One or more branches reconciled for this day</span>
        </div>
      ) : (
        <div className="reconciled-badge">
          <span>✅ This day has been reconciled</span>
          <small>Reconciled by: {summary.reconciled_by || 'Cashier'}</small>
          {canReconcile && (
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => handleSendToDirector(today)}
            disabled={sendingReportDate === today}
          >
            {sendingReportDate === today ? 'Sending…' : '📤 Send report to director'}
          </button>
          )}
        </div>
      ))}

      {/* Checklist summary */}
      <div className="cash-summary-table-section" style={{ marginTop: 16 }}>
        <h2>Day-close checklist</h2>
        <table className="cash-summary-table" style={{ fontSize: 14 }}>
          <tbody>
            <tr>
              <td>Opening Balance</td>
              <td className="num">TSh {parseFloat(summary.opening_balance || 0).toLocaleString()}</td>
            </tr>
            <tr>
              <td>Cash Sales</td>
              <td className="num">TSh {parseFloat(summary.cash_sales || 0).toLocaleString()}</td>
            </tr>
            <tr>
              <td>Book Sales</td>
              <td className="num">TSh {parseFloat(summary.book_sales || 0).toLocaleString()}</td>
            </tr>
            <tr>
              <td>Expenses (Cash)</td>
              <td className="num">- TSh {parseFloat(summary.expenses_from_cash || 0).toLocaleString()}</td>
            </tr>
            <tr>
              <td>Bank Deposits</td>
              <td className="num">- TSh {parseFloat(summary.bank_deposits || 0).toLocaleString()}</td>
            </tr>
            <tr className="total-row">
              <td><strong>Closing Balance</strong></td>
              <td className="num"><strong>TSh {parseFloat(summary.closing_balance || cashInHand).toLocaleString()}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      </>
      )}

      {/* Step nav */}
      {cashWorkspace === 'close' && (
        <div className="cash-step-nav">
          <button
            type="button"
            className="dk-btn dk-btn--secondary dk-btn--md"
            onClick={() => setCloseStep((s) => Math.max(1, s - 1))}
            disabled={closeStep === 1}
          >
            Back
          </button>
          <span className="cash-step-nav__label">Step {closeStep} of {CLOSE_STEP_LABELS.length}</span>
          <button
            type="button"
            className="dk-btn dk-btn--primary dk-btn--md"
            onClick={() => setCloseStep((s) => Math.min(CLOSE_STEP_LABELS.length, s + 1))}
            disabled={closeStep === CLOSE_STEP_LABELS.length}
          >
            Next
          </button>
        </div>
      )}

      {/* ── History workspace ── */}
      {cashWorkspace === 'history' && (
      <>
      <div className="cash-range-section">
        <h2>Pending reconciliations</h2>
        <p className="subtitle">Daily closing entries that were saved but are not yet reconciled</p>
        <div className="section-header">
          <div />
          <button type="button" className="btn-secondary btn-small" onClick={exportReconciliationCsv}>
            Export Reconciliation CSV
          </button>
        </div>
        {unreconciledLoading ? (
          <p className="range-empty">Loading unreconciled entries...</p>
        ) : unreconciledClosings.length > 0 ? (
          <div className="range-table-wrap interactive-scroll-region" tabIndex={0} role="region" aria-label="Unreconciled closings table" {...tableScrollHandlers}>
            <table className="range-table">
              <thead>
                <tr>
                  <th>Date</th>
                  {summary.all_branches && <th>Branch</th>}
                  <th className="num">Opening</th>
                  <th className="num">Open Var.</th>
                  <th className="num">Cash sales</th>
                  <th className="num">Book sales</th>
                  <th className="num">Expenses (cash)</th>
                  <th className="num">Bank deposits</th>
                  <th className="num">Closing</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {unreconciledClosings.map((row) => (
                  <tr key={`${row.branch_id || 'none'}-${row.date}`}>
                    <td>{new Date(row.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                    {summary.all_branches && <td>{row.branch_name || `Branch ${row.branch_id || 'N/A'}`}</td>}
                    <td className="num">{(parseFloat(row.opening_balance) || 0).toLocaleString()}</td>
                    <td className={`num ${(parseFloat(row.opening_variance) || 0) < 0 ? 'value-negative' : 'value-positive'}`}>
                      {(parseFloat(row.opening_variance) || 0).toLocaleString()}
                    </td>
                    <td className="num">{(parseFloat(row.cash_sales) || 0).toLocaleString()}</td>
                    <td className="num">{(parseFloat(row.book_sales) || 0).toLocaleString()}</td>
                    <td className="num">{(parseFloat(row.expenses_from_cash) || 0).toLocaleString()}</td>
                    <td className="num">{(parseFloat(row.bank_deposits) || 0).toLocaleString()}</td>
                    <td className="num">{(parseFloat(row.closing_balance) || 0).toLocaleString()}</td>
                    <td>Pending</td>
                    <td>
                      <div className="range-actions-cell">
                        <button
                          type="button"
                          className="btn-small btn-secondary"
                          onClick={() => handleRefreshCashChain(rowDateKey(row))}
                          disabled={summary.all_branches || chainRefreshingDate === rowDateKey(row)}
                          title="Recalculate this day and all later unreconciled days (bank deposits, opening chain)"
                        >
                          {chainRefreshingDate === rowDateKey(row) ? 'Recalc…' : 'Recalculate chain'}
                        </button>
                        {canReconcile && (
                        <button
                          type="button"
                          className="btn-small btn-success"
                          onClick={() => handleReconcileUnreconciledDate(rowDateKey(row))}
                          disabled={summary.all_branches || reconcilingDate === rowDateKey(row)}
                          title={summary.all_branches ? 'Select a single branch to reconcile this day' : 'Reconcile this unreconciled day'}
                        >
                          {reconcilingDate === rowDateKey(row) ? 'Reconciling…' : 'Reconcile'}
                        </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="range-empty">No unreconciled daily closings found.</p>
        )}
      </div>

      {/* Cashflow report by date range */}
      <div className="cash-range-section">
        <h2>📅 Cashflow report by date</h2>
        <p className="subtitle">
          View consolidated {summary.all_branches ? 'all-branches ' : ''}totals for a date range.
          Closing uses: declared opening + cash sales + book sales − cash expenses − bank deposits (deposits are not expenses).
        </p>
        <p className="subtitle text-muted" style={{ marginTop: '-6px' }}>
          If bank deposits show 0 but you recorded them, or the next day&apos;s opening looks wrong, select the branch and click <strong>Recalculate chain</strong> for that date.
          Edit deposit amounts in <button type="button" className="btn-link" onClick={() => document.getElementById('bank-deposits-section')?.scrollIntoView({ behavior: 'smooth' })}>Bank deposits</button> below (today), or open the deposit in your API/admin tool for other dates.
        </p>
        <div className="range-controls">
          <div className="form-group">
            <label>Start date</label>
            <input
              type="date"
              value={reportStartDate}
              onChange={(e) => setReportStartDate(e.target.value)}
              max={today}
            />
          </div>
          <div className="form-group">
            <label>End date</label>
            <input
              type="date"
              value={reportEndDate}
              onChange={(e) => setReportEndDate(e.target.value)}
              max={today}
            />
          </div>
          <button type="button" className="btn-primary" onClick={loadRangeReport} disabled={rangeLoading}>
            {rangeLoading ? 'Loading...' : 'View report'}
          </button>
          <button type="button" className="btn-secondary" onClick={exportCashflowCsv} disabled={rangeLoading || !rangeData.length}>
            Export Cashflow CSV
          </button>
        </div>
        {rangeData.length > 0 && (
          <div className="range-table-wrap interactive-scroll-region" tabIndex={0} role="region" aria-label="Cashflow report table" {...tableScrollHandlers}>
            <table className="range-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Opening</th>
                  <th className="num">Open Var.</th>
                  <th className="num">Cash sales</th>
                  <th className="num">Book sales</th>
                  <th className="num">Card & M-Pesa</th>
                  <th className="num">Expenses (cash)</th>
                  <th className="num">Bank deposits</th>
                  <th className="num">Closing</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rangeData.map((row) => {
                  const dk = rowDateKey(row);
                  const depLines = rangeDepositsByDate[dk] || [];
                  const expanded = !!cashflowExpanded[dk];
                  const reconciled = !!(row.is_reconciled === true || row.is_reconciled === 1 || row.is_reconciled === '1');
                  return (
                    <React.Fragment key={dk || row.date}>
                      <tr>
                        <td>{new Date(row.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                        <td className="num">{(parseFloat(row.opening_balance) || 0).toLocaleString()}</td>
                        <td className={`num ${(parseFloat(row.opening_variance) || 0) < 0 ? 'value-negative' : 'value-positive'}`}>
                          {(parseFloat(row.opening_variance) || 0).toLocaleString()}
                        </td>
                        <td className="num">{(parseFloat(row.cash_sales) || 0).toLocaleString()}</td>
                        <td className="num">{(parseFloat(row.book_sales) || 0).toLocaleString()}</td>
                        <td className="num">{(parseFloat(row.card_sales || 0) + parseFloat(row.mobile_money_sales || 0)).toLocaleString()}</td>
                        <td className="num">{(parseFloat(row.expenses_from_cash) || 0).toLocaleString()}</td>
                        <td className="num">{(parseFloat(row.bank_deposits) || 0).toLocaleString()}</td>
                        <td className="num">{(parseFloat(row.closing_balance) || 0).toLocaleString()}</td>
                        <td>{reconciled ? <span className="text-muted">Reconciled</span> : <span>Pending</span>}</td>
                        <td>
                          <div className="range-actions-cell">
                            {!summary.all_branches && (
                              <button
                                type="button"
                                className="btn-small btn-secondary"
                                onClick={() => handleRefreshCashChain(row.date)}
                                disabled={!!chainRefreshingDate}
                                title="Recalculate this day and all later unreconciled days"
                              >
                                {chainRefreshingDate === dk ? '…' : 'Recalc chain'}
                              </button>
                            )}
                            {!summary.all_branches && !reconciled && canReconcile && (
                              <button
                                type="button"
                                className="btn-small btn-success"
                                onClick={() => handleReconcileUnreconciledDate(dk)}
                                disabled={reconcilingDate === dk}
                              >
                                {reconcilingDate === dk ? '…' : 'Reconcile'}
                              </button>
                            )}
                            {!summary.all_branches && reconciled && canReconcile && (
                              <button
                                type="button"
                                className="btn-small btn-primary"
                                onClick={() => handleSendToDirector(dk)}
                                disabled={sendingReportDate === dk}
                                title="Resend daily closing report to director on WhatsApp"
                              >
                                {sendingReportDate === dk ? '…' : 'Send to director'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn-small btn-link"
                              onClick={() => setCashflowExpanded((prev) => ({ ...prev, [dk]: !prev[dk] }))}
                            >
                              {expanded ? 'Hide' : 'Details'}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="cashflow-detail-row">
                          <td colSpan={11}>
                            <div className="cashflow-detail-inner">
                              <p className="text-muted small" style={{ margin: '0 0 8px' }}>
                                Bank deposit lines for this date (branch). Sum should match the &quot;Bank deposits&quot; column after recalculate.
                              </p>
                              {depLines.length === 0 ? (
                                <p className="text-muted">No rows in <code>bank_deposits</code> for this date — add one below or fix the date/branch on an existing deposit.</p>
                              ) : (
                                <ul className="cashflow-deposit-lines">
                                  {depLines.map((dep) => (
                                    <li key={dep.id}>
                                      <strong>TSh {parseFloat(dep.amount || 0).toLocaleString()}</strong>
                                      {' · '}
                                      {dep.bank_account_name || dep.bank_name || 'Bank'}
                                      {dep.reference_number ? ` · Ref ${dep.reference_number}` : ''}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <button
                                type="button"
                                className="btn-link"
                                onClick={() => document.getElementById('bank-deposits-section')?.scrollIntoView({ behavior: 'smooth' })}
                              >
                                Jump to Bank deposits (today)
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rangeData.length === 0 && !rangeLoading && reportStartDate && reportEndDate && (
          <p className="range-empty">No summary data for this range. Ensure dates have been reconciled or saved per branch.</p>
        )}
      </div>
      </>
      )}
    </div>
  );
};

export default CashManagement;
