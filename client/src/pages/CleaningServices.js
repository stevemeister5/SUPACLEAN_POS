import React, { useState, useEffect, useCallback } from 'react';
import {
  getCleaningCustomers,
  createCleaningCustomer,
  getCleaningDocuments,
  getCleaningDocument,
  createCleaningDocument,
  recordCleaningPayment,
  getCleaningFinancialSummary,
  getCleaningExpenses,
  getCleaningExpenseCategories,
  createCleaningExpense,
  getActiveBankAccounts
} from '../api/api';
import { useToast } from '../hooks/useToast';
import Loader from '../components/Loader';
import './CleaningServices.css';

const BUSINESS_INFO = {
  legalName: 'FREMBO ENTERPRISES COMPANY LIMITED',
  brandName: 'SUPACLEAN',
  brandTagline: 'Professional Cleaning Services',
  tin: '191-360-370',
  registeredAddress: 'Arusha City, Tanzania',
  operatingLocation: 'Levolosi, Arusha',
};

function escapeHtml(str) {
  if (str == null || str === '') return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const defaultLineItem = () => ({
  id: Math.random().toString(36).slice(2),
  service_type: '',
  description: '',
  quantity: 1,
  unit_price: '',
});

const CleaningServices = () => {
  const { showToast, ToastContainer } = useToast();
  const [mode, setMode] = useState(null); // null | 'customers' | 'create' | 'list' | 'expenses' | 'summary'
  const [docType, setDocType] = useState('quotation');
  const [documents, setDocuments] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [summary, setSummary] = useState(null);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [filterType, setFilterType] = useState('');
  const [viewDoc, setViewDoc] = useState(null);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payForm, setPayForm] = useState({
    amount: '',
    payment_date: new Date().toISOString().slice(0, 10),
    payment_method: 'cash',
    reference_number: '',
    notes: ''
  });
  const [form, setForm] = useState({
    document_type: 'quotation',
    cleaning_customer_id: '',
    document_date: new Date().toISOString().slice(0, 10),
    due_date: '',
    notes: '',
    items: [defaultLineItem()],
  });
  const [customerForm, setCustomerForm] = useState({ name: '', phone: '', email: '', address: '', tin: '' });
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [addCustomerForm, setAddCustomerForm] = useState({ name: '', phone: '', email: '', address: '', tin: '' });
  const [expenseForm, setExpenseForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    category: 'other',
    description: '',
    amount: '',
  });
  const [summaryRange, setSummaryRange] = useState({
    date_from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
    date_to: new Date().toISOString().slice(0, 10),
  });

  const loadCustomers = useCallback(async () => {
    try {
      const res = await getCleaningCustomers();
      setCustomers(res.data || []);
    } catch (e) {
      setCustomers([]);
    }
  }, []);

  const loadDocuments = useCallback(async () => {
    try {
      const params = filterType ? { document_type: filterType } : {};
      const res = await getCleaningDocuments(params);
      setDocuments(res.data || []);
    } catch (e) {
      showToast('Error loading documents: ' + (e.response?.data?.error || e.message), 'error');
      setDocuments([]);
    }
  }, [filterType, showToast]);

  const loadExpenses = useCallback(async () => {
    try {
      const res = await getCleaningExpenses({});
      setExpenses(res.data || []);
    } catch (e) {
      showToast('Error loading expenses: ' + (e.response?.data?.error || e.message), 'error');
      setExpenses([]);
    }
  }, [showToast]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await getCleaningFinancialSummary(summaryRange);
      setSummary(res.data || null);
    } catch (e) {
      showToast('Error loading summary: ' + (e.response?.data?.error || e.message), 'error');
      setSummary(null);
    }
  }, [summaryRange.date_from, summaryRange.date_to, showToast]);

  useEffect(() => {
    setLoading(true);
    getCleaningExpenseCategories()
      .then((r) => setCategories(r.data || []))
      .catch(() => setCategories([]));
    loadCustomers().finally(() => setLoading(false));
  }, [loadCustomers]);

  useEffect(() => {
    if (mode === 'list') loadDocuments();
    if (mode === 'expenses') loadExpenses();
    if (mode === 'summary') loadSummary();
    if (mode === 'create') loadCustomers();
  }, [mode, loadDocuments, loadExpenses, loadSummary, loadCustomers]);

  const formatDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');
  const formatMoney = (n) => (n != null ? 'TSh ' + Number(n).toLocaleString() : '—');

  const addLineItem = () => setForm((f) => ({ ...f, items: [...f.items, defaultLineItem()] }));
  const removeLineItem = (id) => setForm((f) => ({
    ...f,
    items: f.items.filter((it) => it.id !== id).length ? f.items.filter((it) => it.id !== id) : [defaultLineItem()],
  }));
  const updateLineItem = (id, field, value) => setForm((f) => ({
    ...f,
    items: f.items.map((it) => (it.id !== id ? it : { ...it, [field]: value })),
  }));

  const subtotal = form.items.reduce((sum, it) => {
    const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
    const up = parseFloat(it.unit_price) || 0;
    return sum + qty * up;
  }, 0);

  const handleCreateCustomer = async (e) => {
    e.preventDefault();
    if (!customerForm.name.trim() || !customerForm.phone.trim()) {
      showToast('Name and phone are required', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await createCleaningCustomer(customerForm);
      showToast('Customer added', 'success');
      setCustomerForm({ name: '', phone: '', email: '', address: '', tin: '' });
      loadCustomers();
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Failed to add customer', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.cleaning_customer_id) {
      showToast('Select a cleaning customer', 'error');
      return;
    }
    const items = form.items
      .map((it) => ({
        service_type: it.service_type.trim() || undefined,
        description: (it.description || 'Service').trim() || 'Service',
        quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
        unit_price: parseFloat(it.unit_price) || 0,
      }))
      .filter((it) => it.description && (it.unit_price > 0 || it.quantity > 0));
    if (!items.length) {
      showToast('Add at least one line item with description and amount', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createCleaningDocument({
        document_type: form.document_type,
        cleaning_customer_id: Number(form.cleaning_customer_id),
        document_date: form.document_date || new Date().toISOString().slice(0, 10),
        due_date: form.due_date || null,
        notes: form.notes.trim() || null,
        items,
      });
      showToast((form.document_type === 'quotation' ? 'Quotation' : 'Invoice') + ' created: ' + res.data.document_number, 'success');
      setForm({
        document_type: form.document_type,
        cleaning_customer_id: '',
        document_date: new Date().toISOString().slice(0, 10),
        due_date: '',
        notes: '',
        items: [defaultLineItem()],
      });
      setMode('list');
      loadDocuments();
      if (res.data.id) handlePrint(res.data.id, res.data);
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Failed to create document', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRecordPayment = async (e) => {
    e.preventDefault();
    if (!viewDoc || viewDoc.document_type !== 'invoice') return;
    const amt = parseFloat(payForm.amount);
    if (!payForm.payment_date || !amt || amt <= 0) {
      showToast('Enter amount and payment date', 'error');
      return;
    }
    const balance = parseFloat(viewDoc.balance_due ?? viewDoc.total_amount ?? 0);
    if (amt > balance) {
      showToast('Amount cannot exceed balance due ' + formatMoney(balance), 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await recordCleaningPayment(viewDoc.id, {
        amount: amt,
        payment_date: payForm.payment_date,
        payment_method: payForm.payment_method || 'cash',
        reference_number: payForm.reference_number || null,
        notes: payForm.notes || null,
      });
      setViewDoc(res.data);
      setShowPayModal(false);
      setPayForm({ amount: '', payment_date: new Date().toISOString().slice(0, 10), payment_method: 'cash', reference_number: '', notes: '' });
      showToast('Payment recorded', 'success');
      loadDocuments();
      if (mode === 'summary') loadSummary();
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Failed to record payment', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddCustomerFromDoc = async (e) => {
    e.preventDefault();
    if (!addCustomerForm.name.trim() || !addCustomerForm.phone.trim()) {
      showToast('Name and phone are required', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createCleaningCustomer(addCustomerForm);
      showToast('Customer added', 'success');
      await loadCustomers();
      setForm((f) => ({ ...f, cleaning_customer_id: String(res.data.id) }));
      setAddCustomerForm({ name: '', phone: '', email: '', address: '', tin: '' });
      setShowAddCustomerModal(false);
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Failed to add customer', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateExpense = async (e) => {
    e.preventDefault();
    const amt = parseFloat(expenseForm.amount);
    if (!expenseForm.date || !expenseForm.category || (amt !== 0 && !amt)) {
      showToast('Date, category and amount are required', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await createCleaningExpense({
        date: expenseForm.date,
        category: expenseForm.category,
        description: expenseForm.description.trim() || null,
        amount: amt,
      });
      showToast('Expense recorded', 'success');
      setExpenseForm({ date: new Date().toISOString().slice(0, 10), category: 'other', description: '', amount: '' });
      loadExpenses();
      if (mode === 'summary') loadSummary();
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Failed to record expense', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrint = async (id, docFromCreate) => {
    try {
      const doc = docFromCreate || (await getCleaningDocument(id)).data;
      let bankAccounts = [];
      try {
        const accRes = await getActiveBankAccounts();
        bankAccounts = Array.isArray(accRes.data) ? accRes.data : [];
      } catch {
        bankAccounts = [];
      }

      const customerName = doc.customer_name || 'Customer';
      const customerPhone = doc.customer_phone || '';
      const customerEmail = doc.email || '';
      const customerAddress = doc.address || '';
      const isQuotation = doc.document_type === 'quotation';
      const title = isQuotation ? 'QUOTATION' : 'TAX INVOICE';
      const docNo = escapeHtml(doc.document_number || '');
      const lines = (doc.items || []).map(
        (it) =>
          `<tr>
            <td>${escapeHtml((it.service_type || '').trim() || '—')}</td>
            <td>${escapeHtml(it.description || '')}</td>
            <td class="num">${escapeHtml(String(it.quantity))}</td>
            <td class="num">${Number(it.unit_price).toLocaleString()}</td>
            <td class="num">${Number(it.total_amount).toLocaleString()}</td>
          </tr>`
      );
      const totalNum = doc.total_amount != null ? Number(doc.total_amount) : 0;
      const total = totalNum.toLocaleString();
      const docDate = doc.document_date ? new Date(doc.document_date).toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' }) : '';
      const dueDate = doc.due_date ? new Date(doc.due_date).toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' }) : '';
      const isInvoiceDoc = doc.document_type === 'invoice';
      const paidNum = isInvoiceDoc ? Number(doc.paid_amount || 0) : 0;
      const balanceNum = isInvoiceDoc && doc.balance_due != null ? Number(doc.balance_due) : null;
      let summaryRowsHtml = '';
      if (isInvoiceDoc && paidNum > 0) {
        summaryRowsHtml = `
              <tr><td>Invoice total (TSh)</td><td>${total}</td></tr>
              <tr><td>Amount received (TSh)</td><td>${paidNum.toLocaleString()}</td></tr>
              <tr class="total"><td>Balance due (TSh)</td><td>${balanceNum != null ? balanceNum.toLocaleString() : total}</td></tr>`;
      } else if (isInvoiceDoc) {
        summaryRowsHtml = `<tr class="total"><td>Total due (TSh)</td><td>${total}</td></tr>`;
      } else {
        summaryRowsHtml = `<tr class="total"><td>Quoted total (TSh)</td><td>${total}</td></tr>`;
      }

      const bankRows =
        bankAccounts.length > 0
          ? bankAccounts
              .map(
                (a) =>
                  `<tr>
                  <td>${escapeHtml(a.name || 'Account')}</td>
                  <td class="mono">${escapeHtml(a.account_number || '—')}</td>
                </tr>`
              )
              .join('')
          : '';

      const paymentSection =
        bankAccounts.length > 0
          ? `
          <section class="payment-section">
            <h2 class="section-title">Payment details</h2>
            <p class="payment-intro">
              Payments are payable to <strong>${escapeHtml(BUSINESS_INFO.legalName)}</strong> in <strong>Tanzanian Shillings (TSh)</strong>.
              Please use <strong>${docNo}</strong> as the payment reference so we can allocate your payment correctly.
            </p>
            <table class="bank-table">
              <thead>
                <tr>
                  <th>Bank / account name</th>
                  <th>Account number</th>
                </tr>
              </thead>
              <tbody>${bankRows}</tbody>
            </table>
            <p class="payment-note">Kindly send proof of payment to our office or your usual contact once the transfer is completed.</p>
          </section>`
          : `
          <section class="payment-section payment-section--empty">
            <h2 class="section-title">Payment details</h2>
            <p class="payment-intro muted">Bank accounts are managed in Admin settings. Ask your administrator or contact accounts for the current payment instructions.</p>
          </section>`;

      const printHTML = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>${escapeHtml(title)} ${docNo}</title>
          <style>
            @page { size: A4; margin: 14mm; }
            * { box-sizing: border-box; }
            body {
              font-family: 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
              font-size: 11px;
              line-height: 1.45;
              color: #1a1a1a;
              margin: 0;
              padding: 24px;
              max-width: 210mm;
              margin-left: auto;
              margin-right: auto;
            }
            .sheet-accent {
              height: 5px;
              background: #1e3a5f;
              margin: -24px -24px 20px -24px;
            }
            .letterhead {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              gap: 24px;
              padding-bottom: 18px;
              border-bottom: 1px solid #c5cdd6;
              margin-bottom: 20px;
            }
            .legal-name {
              font-size: 9px;
              letter-spacing: 0.12em;
              text-transform: uppercase;
              color: #4a5568;
              font-weight: 600;
              margin-bottom: 6px;
            }
            .brand-name {
              font-size: 22px;
              font-weight: 700;
              color: #1e3a5f;
              letter-spacing: -0.02em;
              margin: 0 0 2px 0;
            }
            .brand-tagline {
              font-size: 11px;
              color: #5c6c7c;
              margin-bottom: 12px;
            }
            .company-lines {
              font-size: 10px;
              color: #374151;
            }
            .company-lines p { margin: 3px 0; }
            .doc-badge {
              text-align: right;
              min-width: 140px;
            }
            .doc-badge-inner {
              display: inline-block;
              border: 2px solid #1e3a5f;
              color: #1e3a5f;
              font-size: 11px;
              font-weight: 700;
              letter-spacing: 0.08em;
              padding: 8px 14px;
              text-transform: uppercase;
            }
            .meta-grid {
              display: grid;
              grid-template-columns: repeat(4, 1fr);
              gap: 12px;
              margin-bottom: 20px;
            }
            @media (max-width: 640px) {
              .meta-grid { grid-template-columns: repeat(2, 1fr); }
            }
            .meta-cell {
              border: 1px solid #e2e8f0;
              padding: 10px 12px;
              background: #f8fafc;
            }
            .meta-label {
              font-size: 9px;
              text-transform: uppercase;
              letter-spacing: 0.06em;
              color: #64748b;
              margin-bottom: 4px;
            }
            .meta-value { font-size: 12px; font-weight: 600; color: #0f172a; }
            .bill-to {
              border: 1px solid #c5cdd6;
              padding: 14px 16px;
              margin-bottom: 20px;
              background: #fff;
            }
            .bill-to h3 {
              margin: 0 0 10px 0;
              font-size: 9px;
              text-transform: uppercase;
              letter-spacing: 0.08em;
              color: #64748b;
            }
            .bill-to p { margin: 4px 0; font-size: 12px; }
            .items-table {
              width: 100%;
              border-collapse: collapse;
              margin: 0 0 8px 0;
              font-size: 10px;
            }
            .items-table th {
              background: #1e3a5f;
              color: #fff;
              font-weight: 600;
              text-align: left;
              padding: 10px 8px;
              border: 1px solid #1e3a5f;
            }
            .items-table th.num, .items-table td.num { text-align: right; }
            .items-table td {
              padding: 9px 8px;
              border: 1px solid #d1d9e0;
              vertical-align: top;
            }
            .items-table tbody tr:nth-child(even) { background: #f8fafc; }
            .summary-wrap {
              display: flex;
              justify-content: flex-end;
              margin-bottom: 22px;
            }
            .summary-table {
              width: 280px;
              border-collapse: collapse;
              font-size: 11px;
            }
            .summary-table td {
              padding: 6px 10px;
              border: 1px solid #e2e8f0;
            }
            .summary-table td:first-child { background: #f1f5f9; font-weight: 500; }
            .summary-table td:last-child { text-align: right; font-weight: 600; }
            .summary-table tr.total td {
              background: #1e3a5f;
              color: #fff;
              border-color: #1e3a5f;
              font-size: 12px;
            }
            .notes-block {
              margin-bottom: 20px;
              padding: 12px 14px;
              background: #f8fafc;
              border-left: 3px solid #1e3a5f;
              font-size: 10px;
            }
            .payment-section {
              margin-top: 8px;
              padding-top: 18px;
              border-top: 2px solid #1e3a5f;
              page-break-inside: avoid;
            }
            .payment-section--empty { border-top-color: #cbd5e1; }
            .section-title {
              font-size: 12px;
              text-transform: uppercase;
              letter-spacing: 0.06em;
              color: #1e3a5f;
              margin: 0 0 10px 0;
            }
            .payment-intro { font-size: 10px; margin: 0 0 12px 0; color: #334155; max-width: 100%; }
            .payment-intro.muted { color: #64748b; font-style: italic; }
            .payment-note { font-size: 9px; color: #64748b; margin: 12px 0 0 0; }
            .bank-table {
              width: 100%;
              border-collapse: collapse;
              font-size: 10px;
            }
            .bank-table th {
              text-align: left;
              padding: 8px 10px;
              background: #eef2f7;
              border: 1px solid #cbd5e1;
              font-weight: 600;
            }
            .bank-table td {
              padding: 8px 10px;
              border: 1px solid #e2e8f0;
            }
            .bank-table .mono { font-family: Consolas, 'Courier New', monospace; letter-spacing: 0.03em; }
            .doc-footer {
              margin-top: 28px;
              padding-top: 14px;
              border-top: 1px solid #e2e8f0;
              font-size: 9px;
              color: #64748b;
              text-align: center;
            }
            .no-print { margin-top: 20px; }
            .no-print button {
              font-size: 13px;
              padding: 8px 16px;
              margin-right: 10px;
              cursor: pointer;
            }
            @media print {
              body { padding: 0; }
              .sheet-accent { margin: 0 0 16px 0; }
              .no-print { display: none !important; }
            }
          </style>
        </head>
        <body>
          <div class="sheet-accent"></div>
          <header class="letterhead">
            <div>
              <div class="legal-name">${escapeHtml(BUSINESS_INFO.legalName)}</div>
              <h1 class="brand-name">${escapeHtml(BUSINESS_INFO.brandName)}</h1>
              <div class="brand-tagline">${escapeHtml(BUSINESS_INFO.brandTagline)}</div>
              <div class="company-lines">
                <p><strong>Registered address:</strong> ${escapeHtml(BUSINESS_INFO.registeredAddress)}</p>
                <p><strong>Operating location:</strong> ${escapeHtml(BUSINESS_INFO.operatingLocation)}</p>
                <p><strong>TIN:</strong> ${escapeHtml(BUSINESS_INFO.tin)}</p>
              </div>
            </div>
            <div class="doc-badge">
              <div class="doc-badge-inner">${escapeHtml(title)}</div>
            </div>
          </header>

          <div class="meta-grid">
            <div class="meta-cell">
              <div class="meta-label">${isQuotation ? 'Quotation no.' : 'Invoice no.'}</div>
              <div class="meta-value">${docNo}</div>
            </div>
            <div class="meta-cell">
              <div class="meta-label">Document date</div>
              <div class="meta-value">${escapeHtml(docDate)}</div>
            </div>
            <div class="meta-cell">
              <div class="meta-label">${isQuotation ? 'Valid until' : 'Due date'}</div>
              <div class="meta-value">${dueDate ? escapeHtml(dueDate) : '—'}</div>
            </div>
            <div class="meta-cell">
              <div class="meta-label">Currency</div>
              <div class="meta-value">TSh</div>
            </div>
          </div>

          <div class="bill-to">
            <h3>Bill to</h3>
            <p><strong>${escapeHtml(customerName)}</strong></p>
            ${customerPhone ? `<p>${escapeHtml(customerPhone)}</p>` : ''}
            ${customerEmail ? `<p>${escapeHtml(customerEmail)}</p>` : ''}
            ${customerAddress ? `<p>${escapeHtml(customerAddress)}</p>` : ''}
          </div>

          <table class="items-table">
            <thead>
              <tr>
                <th style="width:18%">Service type</th>
                <th>Description</th>
                <th class="num" style="width:8%">Qty</th>
                <th class="num" style="width:14%">Unit price (TSh)</th>
                <th class="num" style="width:14%">Amount (TSh)</th>
              </tr>
            </thead>
            <tbody>${lines.join('')}</tbody>
          </table>

          <div class="summary-wrap">
            <table class="summary-table">
              ${summaryRowsHtml}
            </table>
          </div>

          ${doc.notes ? `<div class="notes-block"><strong>Notes</strong><br>${escapeHtml(doc.notes)}</div>` : ''}

          ${paymentSection}

          <footer class="doc-footer">
            <p>${escapeHtml(BUSINESS_INFO.legalName)} · Trading as <strong>${escapeHtml(BUSINESS_INFO.brandName)}</strong> · TIN ${escapeHtml(BUSINESS_INFO.tin)} · ${escapeHtml(BUSINESS_INFO.registeredAddress)}</p>
            <p>This document was generated electronically and is valid without signature unless otherwise agreed in writing.</p>
          </footer>

          <p class="no-print">
            <button type="button" onclick="window.print();">Print</button>
            <button type="button" onclick="window.close();">Close</button>
          </p>
        </body>
        </html>
      `;

      const printWindow = window.open('', '_blank', 'width=800,height=700,scrollbars=yes');
      if (printWindow) {
        printWindow.document.open();
        printWindow.document.write(printHTML);
        printWindow.document.close();
        showToast('Print window opened. Use Print button or Ctrl+P.', 'success');
      } else {
        showToast('Popup blocked. Allow popups and try again.', 'warning');
      }
    } catch (err) {
      showToast('Error loading document: ' + (err.response?.data?.error || err.message), 'error');
    }
  };

  if (loading) {
    return (
      <div className="cleaning-services">
        <Loader message="Loading…" fullPage />
      </div>
    );
  }

  return (
    <div className="cleaning-services">
      <ToastContainer />
      {mode === null && (
        <>
          <div className="cs-header">
            <h1>Cleaning Services</h1>
            <p>Independent from laundry: own customers, quotations, invoices, payments and expenses. Only visible to admin or branches with this feature enabled.</p>
          </div>
          <div className="cs-actions">
            <button type="button" className="cs-action-card" onClick={() => setMode('customers')}>
              <span className="cs-action-icon">👥</span>
              <span className="cs-action-label">Customers</span>
              <span className="cs-action-desc">Add and manage cleaning-service customers (separate from laundry customers).</span>
            </button>
            <button type="button" className="cs-action-card" onClick={() => { setDocType('quotation'); setForm((f) => ({ ...f, document_type: 'quotation', cleaning_customer_id: '', items: f.items.length ? f.items : [defaultLineItem()] })); setMode('create'); }}>
              <span className="cs-action-icon">📄</span>
              <span className="cs-action-label">New Quotation</span>
              <span className="cs-action-desc">Create a quotation with service type, description and amount. Print and send.</span>
            </button>
            <button type="button" className="cs-action-card" onClick={() => { setDocType('invoice'); setForm((f) => ({ ...f, document_type: 'invoice', cleaning_customer_id: '', items: f.items.length ? f.items : [defaultLineItem()] })); setMode('create'); }}>
              <span className="cs-action-icon">🧾</span>
              <span className="cs-action-label">New Invoice</span>
              <span className="cs-action-desc">Create an invoice. Due date is 30 days from document date. Record payments when received.</span>
            </button>
            <button type="button" className="cs-action-card" onClick={() => setMode('list')}>
              <span className="cs-action-icon">📋</span>
              <span className="cs-action-label">Documents</span>
              <span className="cs-action-desc">List quotations and invoices. Print or receive payment for invoices.</span>
            </button>
            <button type="button" className="cs-action-card" onClick={() => setMode('expenses')}>
              <span className="cs-action-icon">📝</span>
              <span className="cs-action-label">Expenses</span>
              <span className="cs-action-desc">Record cleaning expenses: rugs, soap, equipment, tools.</span>
            </button>
            <button type="button" className="cs-action-card" onClick={() => setMode('summary')}>
              <span className="cs-action-icon">💰</span>
              <span className="cs-action-label">Financial summary</span>
              <span className="cs-action-desc">Total income (payments), expenses and balance for cleaning services.</span>
            </button>
          </div>
        </>
      )}

      {mode === 'customers' && (
        <div className="cs-panel">
          <div className="cs-panel-header">
            <button type="button" className="cs-back" onClick={() => setMode(null)}>← Back</button>
            <h2>Cleaning customers</h2>
          </div>
          <form onSubmit={handleCreateCustomer} className="cs-form">
            <div className="cs-form-section">
              <h3>Add customer</h3>
              <div className="cs-form-row">
                <div className="cs-field">
                  <label>Name *</label>
                  <input value={customerForm.name} onChange={(e) => setCustomerForm((f) => ({ ...f, name: e.target.value }))} placeholder="Full name" required />
                </div>
                <div className="cs-field">
                  <label>Phone *</label>
                  <input value={customerForm.phone} onChange={(e) => setCustomerForm((f) => ({ ...f, phone: e.target.value }))} placeholder="Phone" required />
                </div>
              </div>
              <div className="cs-form-row">
                <div className="cs-field">
                  <label>TIN</label>
                  <input value={customerForm.tin} onChange={(e) => setCustomerForm((f) => ({ ...f, tin: e.target.value }))} placeholder="Tax ID / TIN" />
                </div>
                <div className="cs-field">
                  <label>Email</label>
                  <input type="email" value={customerForm.email} onChange={(e) => setCustomerForm((f) => ({ ...f, email: e.target.value }))} placeholder="Email" />
                </div>
              </div>
              <div className="cs-field">
                <label>Address</label>
                <input value={customerForm.address} onChange={(e) => setCustomerForm((f) => ({ ...f, address: e.target.value }))} placeholder="Address" />
              </div>
              <button type="submit" className="cs-btn primary" disabled={submitting}>{submitting ? 'Adding…' : 'Add customer'}</button>
            </div>
          </form>
          <div className="cs-table-wrap">
            <table className="cs-table">
              <thead>
                <tr><th>Name</th><th>Phone</th><th>TIN</th><th>Email</th><th>Address</th></tr>
              </thead>
              <tbody>
                {customers.length === 0 ? <tr><td colSpan={5}>No customers. Add one above.</td></tr> : customers.map((c) => (
                  <tr key={c.id}><td>{c.name}</td><td>{c.phone}</td><td>{c.tin || '—'}</td><td>{c.email || '—'}</td><td>{c.address || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mode === 'create' && (
        <div className="cs-panel">
          <div className="cs-panel-header">
            <button type="button" className="cs-back" onClick={() => setMode(null)}>← Back</button>
            <h2>{docType === 'quotation' ? 'New Quotation' : 'New Invoice'}</h2>
          </div>
          {docType === 'invoice' && (
            <p className="cs-hint">Due date will be set to 30 days from document date if left empty.</p>
          )}
          <form onSubmit={handleCreate} className="cs-form">
            <div className="cs-form-section">
              <h3>Customer & dates</h3>
              <div className="cs-field cs-field-with-btn">
                <label>Cleaning customer *</label>
                <div className="cs-select-and-add">
                  <select value={form.cleaning_customer_id} onChange={(e) => setForm((f) => ({ ...f, cleaning_customer_id: e.target.value }))} required>
                    <option value="">Select customer</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} – {c.phone}{c.tin ? ' (TIN: ' + c.tin + ')' : ''}</option>
                    ))}
                  </select>
                  <button type="button" className="cs-btn primary cs-add-customer-btn" onClick={() => setShowAddCustomerModal(true)}>
                    + Add customer
                  </button>
                </div>
              </div>
              <div className="cs-form-row">
                <div className="cs-field">
                  <label>Document date *</label>
                  <input type="date" value={form.document_date} onChange={(e) => setForm((f) => ({ ...f, document_date: e.target.value }))} required />
                </div>
                <div className="cs-field">
                  <label>Due date (optional; invoices default to +30 days)</label>
                  <input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
                </div>
              </div>
              <div className="cs-field">
                <label>Notes (optional)</label>
                <input type="text" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Notes" />
              </div>
            </div>
            <div className="cs-form-section">
              <h3>Line items</h3>
              <div className="cs-table-wrap">
                <table className="cs-table">
                  <thead>
                    <tr>
                      <th>Type of service</th>
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Unit price (TSh)</th>
                      <th>Amount</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.items.map((it) => (
                      <tr key={it.id}>
                        <td><input value={it.service_type} onChange={(e) => updateLineItem(it.id, 'service_type', e.target.value)} placeholder="e.g. Deep clean" /></td>
                        <td><input value={it.description} onChange={(e) => updateLineItem(it.id, 'description', e.target.value)} placeholder="Description" /></td>
                        <td><input type="number" min={1} value={it.quantity} onChange={(e) => updateLineItem(it.id, 'quantity', e.target.value)} /></td>
                        <td><input type="number" step="0.01" min={0} value={it.unit_price} onChange={(e) => updateLineItem(it.id, 'unit_price', e.target.value)} placeholder="0" /></td>
                        <td>{formatMoney((parseInt(it.quantity, 10) || 0) * (parseFloat(it.unit_price) || 0))}</td>
                        <td><button type="button" className="cs-btn-remove" onClick={() => removeLineItem(it.id)} title="Remove">✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="cs-btn-add" onClick={addLineItem}>+ Add line</button>
              <p className="cs-total">Subtotal: <strong>{formatMoney(subtotal)}</strong></p>
            </div>
            <div className="cs-form-actions">
              <button type="button" className="cs-btn secondary" onClick={() => setMode(null)}>Cancel</button>
              <button type="submit" className="cs-btn primary" disabled={submitting}>{submitting ? 'Creating…' : (docType === 'quotation' ? 'Create Quotation & Print' : 'Create Invoice & Print')}</button>
            </div>
          </form>
        </div>
      )}

      {mode === 'list' && (
        <div className="cs-panel">
          <div className="cs-panel-header">
            <button type="button" className="cs-back" onClick={() => setMode(null)}>← Back</button>
            <h2>Documents</h2>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="cs-filter">
              <option value="">All</option>
              <option value="quotation">Quotations</option>
              <option value="invoice">Invoices</option>
            </select>
          </div>
          <div className="cs-table-wrap">
            <table className="cs-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Number</th>
                  <th>Date</th>
                  <th>Due</th>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Balance</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {documents.length === 0 ? (
                  <tr><td colSpan={8}>No documents.</td></tr>
                ) : documents.map((d) => (
                  <tr key={d.id}>
                    <td>{d.document_type === 'quotation' ? 'Quotation' : 'Invoice'}</td>
                    <td><strong>{d.document_number}</strong></td>
                    <td>{formatDate(d.document_date)}</td>
                    <td>{formatDate(d.due_date)}</td>
                    <td>{d.customer_name || d.customer_phone}</td>
                    <td>{formatMoney(d.total_amount)}</td>
                    <td>{d.document_type === 'invoice' ? formatMoney(d.balance_due) : '—'}</td>
                    <td>
                      <button type="button" className="cs-btn small" onClick={() => setViewDoc(d)}>View</button>
                      <button type="button" className="cs-btn small" onClick={() => handlePrint(d.id)}>Print</button>
                      {d.document_type === 'invoice' && parseFloat(d.balance_due) > 0 && (
                        <button type="button" className="cs-btn small primary" onClick={() => { setViewDoc(d); setPayForm((p) => ({ ...p, amount: String(d.balance_due) })); setShowPayModal(true); }}>Receive payment</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mode === 'expenses' && (
        <div className="cs-panel">
          <div className="cs-panel-header">
            <button type="button" className="cs-back" onClick={() => setMode(null)}>← Back</button>
            <h2>Cleaning expenses</h2>
          </div>
          <form onSubmit={handleCreateExpense} className="cs-form">
            <div className="cs-form-section">
              <h3>Record expense</h3>
              <div className="cs-form-row">
                <div className="cs-field">
                  <label>Date *</label>
                  <input type="date" value={expenseForm.date} onChange={(e) => setExpenseForm((f) => ({ ...f, date: e.target.value }))} required />
                </div>
                <div className="cs-field">
                  <label>Category *</label>
                  <select value={expenseForm.category} onChange={(e) => setExpenseForm((f) => ({ ...f, category: e.target.value }))}>
                    {(categories.length ? categories : ['rugs', 'soap', 'equipment', 'tools', 'other']).map((cat) => (
                      <option key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div className="cs-field">
                  <label>Amount (TSh) *</label>
                  <input type="number" step="0.01" min={0} value={expenseForm.amount} onChange={(e) => setExpenseForm((f) => ({ ...f, amount: e.target.value }))} placeholder="0" required inputMode="decimal" />
                </div>
              </div>
              <div className="cs-field">
                <label>Description</label>
                <input type="text" value={expenseForm.description} onChange={(e) => setExpenseForm((f) => ({ ...f, description: e.target.value }))} placeholder="e.g. Mops, detergent" />
              </div>
              <button type="submit" className="cs-btn primary" disabled={submitting}>{submitting ? 'Saving…' : 'Record expense'}</button>
            </div>
          </form>
          <div className="cs-table-wrap">
            <table className="cs-table">
              <thead>
                <tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th></tr>
              </thead>
              <tbody>
                {expenses.length === 0 ? <tr><td colSpan={4}>No expenses recorded.</td></tr> : expenses.map((ex) => (
                  <tr key={ex.id}><td>{formatDate(ex.date)}</td><td>{ex.category}</td><td>{ex.description || '—'}</td><td>{formatMoney(ex.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mode === 'summary' && (
        <div className="cs-panel">
          <div className="cs-panel-header">
            <button type="button" className="cs-back" onClick={() => setMode(null)}>← Back</button>
            <h2>Cleaning financial summary</h2>
          </div>
          <div className="cs-form-row">
            <div className="cs-field">
              <label>From</label>
              <input type="date" value={summaryRange.date_from} onChange={(e) => setSummaryRange((s) => ({ ...s, date_from: e.target.value }))} />
            </div>
            <div className="cs-field">
              <label>To</label>
              <input type="date" value={summaryRange.date_to} onChange={(e) => setSummaryRange((s) => ({ ...s, date_to: e.target.value }))} />
            </div>
            <button type="button" className="cs-btn primary" onClick={loadSummary}>Update</button>
          </div>
          {summary && (
            <div className="cs-summary-cards">
              <div className="cs-summary-card">
                <span className="cs-summary-label">Income (payments received)</span>
                <span className="cs-summary-value">{formatMoney(summary.totalIncome)}</span>
              </div>
              <div className="cs-summary-card">
                <span className="cs-summary-label">Expenses</span>
                <span className="cs-summary-value">{formatMoney(summary.totalExpenses)}</span>
              </div>
              <div className="cs-summary-card highlight">
                <span className="cs-summary-label">Balance</span>
                <span className="cs-summary-value">{formatMoney(summary.balance)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {showPayModal && viewDoc && (
        <div className="cs-modal-overlay" onClick={() => { setShowPayModal(false); setViewDoc(null); }}>
          <div className="cs-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Receive payment – {viewDoc.document_number}</h3>
            <p className="cs-hint">Balance due: {formatMoney(viewDoc.balance_due)}</p>
            <form onSubmit={handleRecordPayment}>
              <div className="cs-field">
                <label>Amount (TSh) *</label>
                <input type="number" step="0.01" min={0} value={payForm.amount} onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))} required inputMode="decimal" />
              </div>
              <div className="cs-field">
                <label>Payment date *</label>
                <input type="date" value={payForm.payment_date} onChange={(e) => setPayForm((f) => ({ ...f, payment_date: e.target.value }))} required />
              </div>
              <div className="cs-field">
                <label>Method</label>
                <select value={payForm.payment_method} onChange={(e) => setPayForm((f) => ({ ...f, payment_method: e.target.value }))}>
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="mobile_money">Mobile money</option>
                  <option value="bank">Bank</option>
                </select>
              </div>
              <div className="cs-field">
                <label>Reference / notes</label>
                <input type="text" value={payForm.reference_number} onChange={(e) => setPayForm((f) => ({ ...f, reference_number: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="cs-form-actions">
                <button type="button" className="cs-btn secondary" onClick={() => { setShowPayModal(false); setViewDoc(null); }}>Cancel</button>
                <button type="submit" className="cs-btn primary" disabled={submitting}>{submitting ? 'Recording…' : 'Record payment'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {viewDoc && !showPayModal && (
        <div className="cs-modal-overlay" onClick={() => setViewDoc(null)}>
          <div className="cs-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{viewDoc.document_type === 'invoice' ? 'Invoice' : 'Quotation'} {viewDoc.document_number}</h3>
            <p>{viewDoc.customer_name} · {formatDate(viewDoc.document_date)} {viewDoc.due_date ? ' · Due ' + formatDate(viewDoc.due_date) : ''}</p>
            <p>Total: {formatMoney(viewDoc.total_amount)}{viewDoc.document_type === 'invoice' ? ' · Paid: ' + formatMoney(viewDoc.paid_amount) + ' · Balance: ' + formatMoney(viewDoc.balance_due) : ''}</p>
            <button type="button" className="cs-btn secondary" onClick={() => setViewDoc(null)}>Close</button>
            <button type="button" className="cs-btn" onClick={() => handlePrint(viewDoc.id)}>Print</button>
            {viewDoc.document_type === 'invoice' && parseFloat(viewDoc.balance_due) > 0 && (
              <button type="button" className="cs-btn primary" onClick={() => { setPayForm((p) => ({ ...p, amount: String(viewDoc.balance_due) })); setShowPayModal(true); }}>Receive payment</button>
            )}
          </div>
        </div>
      )}

      {showAddCustomerModal && (
        <div className="cs-modal-overlay" onClick={() => { setShowAddCustomerModal(false); setAddCustomerForm({ name: '', phone: '', email: '', address: '', tin: '' }); }}>
          <div className="cs-modal cs-modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>Add customer</h3>
            <p className="cs-hint">Add a new cleaning customer. They will be selected for this {docType === 'quotation' ? 'quotation' : 'invoice'}.</p>
            <form onSubmit={handleAddCustomerFromDoc}>
              <div className="cs-field">
                <label>Name *</label>
                <input value={addCustomerForm.name} onChange={(e) => setAddCustomerForm((f) => ({ ...f, name: e.target.value }))} placeholder="Full name" required />
              </div>
              <div className="cs-field">
                <label>Phone *</label>
                <input value={addCustomerForm.phone} onChange={(e) => setAddCustomerForm((f) => ({ ...f, phone: e.target.value }))} placeholder="Phone" required />
              </div>
              <div className="cs-field">
                <label>TIN</label>
                <input value={addCustomerForm.tin} onChange={(e) => setAddCustomerForm((f) => ({ ...f, tin: e.target.value }))} placeholder="Tax ID / TIN" />
              </div>
              <div className="cs-field">
                <label>Email</label>
                <input type="email" value={addCustomerForm.email} onChange={(e) => setAddCustomerForm((f) => ({ ...f, email: e.target.value }))} placeholder="Email" />
              </div>
              <div className="cs-field">
                <label>Address</label>
                <input value={addCustomerForm.address} onChange={(e) => setAddCustomerForm((f) => ({ ...f, address: e.target.value }))} placeholder="Address" />
              </div>
              <div className="cs-form-actions">
                <button type="button" className="cs-btn secondary" onClick={() => { setShowAddCustomerModal(false); setAddCustomerForm({ name: '', phone: '', email: '', address: '', tin: '' }); }}>Cancel</button>
                <button type="submit" className="cs-btn primary" disabled={submitting}>{submitting ? 'Adding…' : 'Add customer'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default CleaningServices;
