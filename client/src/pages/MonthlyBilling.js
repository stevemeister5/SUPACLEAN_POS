import React, { useState, useEffect, useCallback } from 'react';
import {
  getCustomers,
  quickAddCustomer,
  getBills,
  createBill,
  getInvoices,
  getInvoicesOverdue,
  getInvoice,
  createInvoice,
  recordInvoicePayment
} from '../api/api';
import { useToast } from '../hooks/useToast';
import Loader from '../components/Loader';
import './MonthlyBilling.css';

const defaultBillItem = () => ({ id: Math.random().toString(36).slice(2), description: '', quantity: 1, unit_price: '', total_amount: '' });

const MonthlyBilling = () => {
  const { showToast, ToastContainer } = useToast();
  const [mode, setMode] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [bills, setBills] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [unpaid, setUnpaid] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [billForm, setBillForm] = useState({
    useNewCustomer: false,
    customer_id: '',
    name: '',
    phone: '',
    tin: '',
    vrn: '',
    billing_date: new Date().toISOString().slice(0, 10),
    items: [defaultBillItem()]
  });

  const [invForm, setInvForm] = useState({
    customer_id: '',
    period_start: '',
    period_end: '',
    discount: '',
    credit_amount: '',
    notes: ''
  });

  const [viewInvoice, setViewInvoice] = useState(null);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payForm, setPayForm] = useState({
    amount: '',
    payment_date: new Date().toISOString().slice(0, 10),
    payment_method: 'cash',
    reference_number: '',
    notes: ''
  });

  const [showInvForm, setShowInvForm] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  const loadCustomers = useCallback(async () => {
    try {
      const res = await getCustomers('');
      setCustomers(res.data || []);
      if (res.fromCache && res.syncedAt) setLastSyncedAt(res.syncedAt); else setLastSyncedAt(null);
    } catch (e) {
      setCustomers([]);
    }
  }, []);

  const loadBills = useCallback(async () => {
    try {
      const res = await getBills({});
      setBills(res.data || []);
      if (res.fromCache && res.syncedAt) setLastSyncedAt(res.syncedAt); else setLastSyncedAt(null);
    } catch (e) {
      showToast('Error loading bills: ' + (e.response?.data?.error || e.message), 'error');
      setBills([]);
    }
  }, [showToast]);

  const loadInvoices = useCallback(async () => {
    try {
      const [allRes, overdueRes] = await Promise.all([getInvoices({}), getInvoicesOverdue()]);
      setInvoices(allRes.data || []);
      setUnpaid(overdueRes.data || []);
      if (allRes.fromCache && allRes.syncedAt) setLastSyncedAt(allRes.syncedAt);
      else if (overdueRes.fromCache && overdueRes.syncedAt) setLastSyncedAt(overdueRes.syncedAt);
      else setLastSyncedAt(null);
    } catch (e) {
      showToast('Error loading invoices: ' + (e.response?.data?.error || e.message), 'error');
      setInvoices([]);
      setUnpaid([]);
    }
  }, [showToast]);

  useEffect(() => {
    setLoading(true);
    loadCustomers().finally(() => setLoading(false));
  }, [loadCustomers]);

  useEffect(() => {
    if (mode === 'create-bill') loadBills();
    if (mode === 'invoices') loadInvoices();
  }, [mode, loadBills, loadInvoices]);

  const formatDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');
  const formatMoney = (n) => (n != null ? 'TSh ' + Number(n).toLocaleString() : '—');

  const getDaysOverdue = (inv) => {
    if (!inv?.due_date || !inv.balance_due || inv.balance_due <= 0) return 0;
    const due = new Date(inv.due_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    due.setHours(0, 0, 0, 0);
    if (due >= today) return 0;
    return Math.floor((today - due) / (24 * 60 * 60 * 1000));
  };

  const sortedUnpaid = [...(unpaid || [])].sort((a, b) => {
    const daysA = getDaysOverdue(a);
    const daysB = getDaysOverdue(b);
    if (daysB !== daysA) return daysB - daysA;
    return new Date(a.due_date) - new Date(b.due_date);
  });

  const sortedInvoices = [...(invoices || [])].sort((a, b) => {
    const daysA = getDaysOverdue(a);
    const daysB = getDaysOverdue(b);
    if (daysB !== daysA) return daysB - daysA;
    return new Date(b.due_date || 0) - new Date(a.due_date || 0);
  });

  const addBillItem = () => {
    setBillForm((f) => ({ ...f, items: [...f.items, defaultBillItem()] }));
  };

  const removeBillItem = (id) => {
    setBillForm((f) => {
      const next = f.items.filter((it) => it.id !== id);
      return { ...f, items: next.length ? next : [defaultBillItem()] };
    });
  };

  const updateBillItem = (id, field, value) => {
    setBillForm((f) => ({
      ...f,
      items: f.items.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, [field]: value };
        if (field === 'quantity' || field === 'unit_price') {
          const q = parseInt(field === 'quantity' ? value : it.quantity, 10) || 0;
          const u = parseFloat(field === 'unit_price' ? value : it.unit_price) || 0;
          next.total_amount = q * u;
        }
        return next;
      })
    }));
  };

  const handleCreateBill = async (e) => {
    e.preventDefault();
    let customerId = billForm.customer_id;
    if (billForm.useNewCustomer) {
      if (!billForm.name?.trim() || !billForm.phone?.trim()) {
        showToast('Name and phone are required for new customer', 'error');
        return;
      }
      setSubmitting(true);
      try {
        const r = await quickAddCustomer({
          name: billForm.name.trim(),
          phone: billForm.phone.trim(),
          tin: billForm.tin?.trim() || undefined,
          vrn: billForm.vrn?.trim() || undefined
        });
        customerId = r.data?.id;
        if (!customerId) throw new Error('Could not create customer');
      } catch (err) {
        showToast(err.response?.data?.error || err.message || 'Failed to add customer', 'error');
        setSubmitting(false);
        return;
      }
    } else if (!customerId) {
      showToast('Please select a customer', 'error');
      return;
    }

    const validItems = billForm.items
      .map((it) => {
        const q = parseInt(it.quantity, 10) || 1;
        const u = parseFloat(it.unit_price) || 0;
        const desc = String(it.description || '').trim();
        return desc ? { description: desc, quantity: q, unit_price: u } : null;
      })
      .filter(Boolean);

    if (!validItems.length) {
      showToast('Add at least one item (description required)', 'error');
      return;
    }

    setSubmitting(true);
    try {
      await createBill({
        customer_id: customerId,
        billing_date: billForm.billing_date,
        items: validItems
      });
      showToast('Bill created', 'success');
      setBillForm({
        useNewCustomer: false,
        customer_id: '',
        name: '',
        phone: '',
        tin: '',
        vrn: '',
        billing_date: new Date().toISOString().slice(0, 10),
        items: [defaultBillItem()]
      });
      loadBills();
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Failed to create bill', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateInv = async (e) => {
    e.preventDefault();
    if (!invForm.customer_id || !invForm.period_start || !invForm.period_end) {
      showToast('Customer and period (start/end) are required', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await createInvoice({
        customer_id: invForm.customer_id,
        period_start: invForm.period_start,
        period_end: invForm.period_end,
        discount: invForm.discount || undefined,
        credit_amount: invForm.credit_amount || undefined,
        notes: invForm.notes || undefined
      });
      showToast('Invoice created', 'success');
      setShowInvForm(false);
      setInvForm({ customer_id: '', period_start: '', period_end: '', discount: '', credit_amount: '', notes: '' });
      loadInvoices();
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Failed to create invoice', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRecordPayment = async (e) => {
    e.preventDefault();
    if (!viewInvoice) return;
    const amt = parseFloat(payForm.amount);
    const bal = parseFloat(viewInvoice.balance_due);
    if (Number.isNaN(amt) || amt <= 0) {
      showToast('Enter a valid amount', 'error');
      return;
    }
    if (Math.abs(amt - bal) > 0.02) {
      showToast('Only full payment accepted. Amount must equal balance due (TSh ' + bal.toLocaleString() + ').', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await recordInvoicePayment(viewInvoice.id, {
        amount: amt,
        payment_date: payForm.payment_date,
        payment_method: payForm.payment_method,
        reference_number: payForm.reference_number || undefined,
        notes: payForm.notes || undefined
      });
      showToast('Payment recorded', 'success');
      setShowPayModal(false);
      setViewInvoice(null);
      setPayForm((p) => ({ ...p, amount: '', payment_date: new Date().toISOString().slice(0, 10), payment_method: 'cash', reference_number: '', notes: '' }));
      loadInvoices();
    } catch (err) {
      showToast(err.response?.data?.error || err.message || 'Failed to record payment', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const openViewInvoice = async (id) => {
    try {
      const res = await getInvoice(id);
      setViewInvoice(res.data);
      setPayForm((p) => ({ ...p, amount: String(res.data.balance_due || 0) }));
    } catch (e) {
      showToast('Could not load invoice', 'error');
    }
  };

  const selectedCustomer = customers.find((c) => String(c.id) === String(billForm.customer_id));

  if (loading) {
    return (
      <div className="monthly-billing">
        <Loader message="Loading…" fullPage />
      </div>
    );
  }

  return (
    <div className="monthly-billing">
      <ToastContainer />
      {lastSyncedAt && (
        <div className="sync-cache-banner" role="status">
          Showing data from last sync — {new Date(lastSyncedAt).toLocaleString()}
        </div>
      )}

      {mode === null && (
        <>
          <div className="mb-header">
            <h1>Monthly Billing</h1>
            <p>Create bills for customers, then generate invoices from those bills at month end.</p>
          </div>
          <div className="mb-actions">
            <button type="button" className="mb-action-card" onClick={() => setMode('create-bill')}>
              <span className="mb-action-icon">📄</span>
              <span className="mb-action-label">Create Bill</span>
              <span className="mb-action-desc">Record client details and items (Name, Phone, TIN, VRN, multiple items per bill).</span>
            </button>
            <button type="button" className="mb-action-card" onClick={() => setMode('invoices')}>
              <span className="mb-action-icon">📋</span>
              <span className="mb-action-label">Invoices</span>
              <span className="mb-action-desc">View and create invoices from bills. Bill ID, billing date, and amount per bill.</span>
            </button>
          </div>
        </>
      )}

      {mode === 'create-bill' && (
        <div className="mb-panel">
          <div className="mb-panel-header">
            <button type="button" className="mb-back" onClick={() => setMode(null)}>← Back</button>
            <h2>Create Bill</h2>
          </div>

          <form onSubmit={handleCreateBill} className="mb-form">
            <div className="mb-form-section">
              <h3>Client details</h3>
              <label className="mb-check">
                <input
                  type="checkbox"
                  checked={billForm.useNewCustomer}
                  onChange={(e) => setBillForm((f) => ({ ...f, useNewCustomer: e.target.checked, customer_id: '', name: '', phone: '', tin: '', vrn: '' }))}
                />
                New customer (add Name, Phone, TIN, VRN)
              </label>

              {billForm.useNewCustomer ? (
                <div className="mb-form-row">
                  <div className="mb-field">
                    <label>Name *</label>
                    <input value={billForm.name} onChange={(e) => setBillForm((f) => ({ ...f, name: e.target.value }))} required placeholder="Client name" />
                  </div>
                  <div className="mb-field">
                    <label>Phone *</label>
                    <input value={billForm.phone} onChange={(e) => setBillForm((f) => ({ ...f, phone: e.target.value }))} required placeholder="Phone" />
                  </div>
                  <div className="mb-field">
                    <label>TIN</label>
                    <input value={billForm.tin} onChange={(e) => setBillForm((f) => ({ ...f, tin: e.target.value }))} placeholder="TIN" />
                  </div>
                  <div className="mb-field">
                    <label>VRN</label>
                    <input value={billForm.vrn} onChange={(e) => setBillForm((f) => ({ ...f, vrn: e.target.value }))} placeholder="VRN" />
                  </div>
                </div>
              ) : (
                <div className="mb-field">
                  <label>Customer *</label>
                  <select
                    value={billForm.customer_id}
                    onChange={(e) => setBillForm((f) => ({ ...f, customer_id: e.target.value }))}
                    required
                  >
                    <option value="">Select customer</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} – {c.phone}{c.tin || c.vrn ? ` (TIN: ${c.tin || '—'}, VRN: ${c.vrn || '—'})` : ''}</option>
                    ))}
                  </select>
                  {selectedCustomer && (
                    <p className="mb-customer-meta">
                      TIN: {selectedCustomer.tin || '—'} · VRN: {selectedCustomer.vrn || '—'}
                    </p>
                  )}
                </div>
              )}

              <div className="mb-field">
                <label>Billing date *</label>
                <input
                  type="date"
                  value={billForm.billing_date}
                  onChange={(e) => setBillForm((f) => ({ ...f, billing_date: e.target.value }))}
                  required
                />
              </div>
            </div>

            <div className="mb-form-section">
              <h3>Items</h3>
              <p className="mb-hint">Add each type (e.g. sheets, bed covers, body towels, hand towels) as a separate row.</p>
              <div className="mb-table-wrap">
                <table className="mb-table">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Unit price (TSh)</th>
                      <th>Amount (TSh)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {billForm.items.map((it) => (
                      <tr key={it.id}>
                        <td>
                          <input
                            value={it.description}
                            onChange={(e) => updateBillItem(it.id, 'description', e.target.value)}
                            placeholder="e.g. Sheets, Bed covers"
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={it.quantity}
                            onChange={(e) => updateBillItem(it.id, 'quantity', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min={0}
                            value={it.unit_price}
                            onChange={(e) => updateBillItem(it.id, 'unit_price', e.target.value)}
                            placeholder="0"
                          />
                        </td>
                        <td>{formatMoney((parseInt(it.quantity, 10) || 0) * (parseFloat(it.unit_price) || 0))}</td>
                        <td>
                          <button type="button" className="mb-btn-remove" onClick={() => removeBillItem(it.id)} title="Remove">✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="mb-btn-add" onClick={addBillItem}>+ Add item</button>
            </div>

            <div className="mb-form-actions">
              <button type="button" className="mb-btn secondary" onClick={() => setMode(null)}>Cancel</button>
              <button type="submit" className="mb-btn primary" disabled={submitting}>{submitting ? 'Creating…' : 'Create Bill'}</button>
            </div>
          </form>

          {bills.length > 0 && (
            <div className="mb-form-section">
              <h3>Recent bills</h3>
              <div className="mb-table-wrap">
                <table className="mb-table">
                  <thead>
                    <tr>
                      <th>Bill</th>
                      <th>Date</th>
                      <th>Customer</th>
                      <th>Amount</th>
                      <th>Invoice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bills.slice(0, 20).map((b) => (
                      <tr key={b.id}>
                        <td><strong>{b.bill_number}</strong></td>
                        <td>{formatDate(b.billing_date)}</td>
                        <td>{b.customer_name || b.customer_phone}</td>
                        <td>{formatMoney(b.total_amount)}</td>
                        <td>{b.invoice_number || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {mode === 'invoices' && (
        <div className="mb-panel">
          <div className="mb-panel-header">
            <button type="button" className="mb-back" onClick={() => setMode(null)}>← Back</button>
            <h2>Invoices</h2>
            <button type="button" className="mb-btn primary" onClick={() => setShowInvForm(true)}>Create invoice</button>
          </div>

          {unpaid.length > 0 && (
            <>
              <h3 className="mb-subtitle">Unpaid (overdue first)</h3>
              <div className="mb-table-wrap">
                <table className="mb-table">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Customer</th>
                      <th>Period</th>
                      <th>Total</th>
                      <th>Balance</th>
                      <th>Due</th>
                      <th>Overdue</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedUnpaid.map((inv) => {
                      const daysOverdue = getDaysOverdue(inv);
                      return (
                        <tr key={inv.id} className={daysOverdue > 0 ? 'mb-row-overdue' : ''}>
                          <td><strong>{inv.invoice_number}</strong></td>
                          <td>{inv.customer_name || inv.company_name}</td>
                          <td>{formatDate(inv.period_start)} – {formatDate(inv.period_end)}</td>
                          <td>{formatMoney(inv.total_amount)}</td>
                          <td>{formatMoney(inv.balance_due)}</td>
                          <td>{formatDate(inv.due_date)}</td>
                          <td>
                            {daysOverdue > 0 ? (
                              <span className="mb-badge-overdue" title={`Due date was ${formatDate(inv.due_date)}`}>
                                Overdue by {daysOverdue} {daysOverdue === 1 ? 'day' : 'days'}
                              </span>
                            ) : '—'}
                          </td>
                          <td>
                            <button type="button" className="mb-btn small" onClick={() => openViewInvoice(inv.id)}>View</button>
                            <button type="button" className="mb-btn small primary" onClick={async () => { await openViewInvoice(inv.id); setPayForm((p) => ({ ...p, amount: String(inv.balance_due || 0) })); setShowPayModal(true); }}>Pay</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h3 className="mb-subtitle">All invoices (overdue first)</h3>
          <div className="mb-table-wrap">
            <table className="mb-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Period</th>
                  <th>Total</th>
                  <th>Balance</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th>Overdue</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 ? (
                  <tr><td colSpan={9}>No invoices. Create bills first, then create an invoice for a customer and period.</td></tr>
                ) : (
                  sortedInvoices.map((inv) => {
                    const daysOverdue = getDaysOverdue(inv);
                    return (
                      <tr key={inv.id} className={daysOverdue > 0 ? 'mb-row-overdue' : ''}>
                        <td><strong>{inv.invoice_number}</strong></td>
                        <td>{inv.customer_name || inv.company_name}</td>
                        <td>{formatDate(inv.period_start)} – {formatDate(inv.period_end)}</td>
                        <td>{formatMoney(inv.total_amount)}</td>
                        <td>{formatMoney(inv.balance_due)}</td>
                        <td><span className={`mb-status ${inv.status}`}>{inv.status}</span></td>
                        <td>{formatDate(inv.due_date)}</td>
                        <td>
                          {daysOverdue > 0 ? (
                            <span className="mb-badge-overdue" title={`Due date was ${formatDate(inv.due_date)}`}>
                              Overdue by {daysOverdue} {daysOverdue === 1 ? 'day' : 'days'}
                            </span>
                          ) : '—'}
                        </td>
                        <td>
                          <button type="button" className="mb-btn small" onClick={() => openViewInvoice(inv.id)}>View</button>
                          {inv.balance_due > 0 && (
                            <button type="button" className="mb-btn small primary" onClick={async () => { await openViewInvoice(inv.id); setPayForm((p) => ({ ...p, amount: String(inv.balance_due || 0) })); setShowPayModal(true); }}>Pay</button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showInvForm && (
        <div className="mb-modal-overlay" onClick={() => setShowInvForm(false)}>
          <div className="mb-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create invoice</h3>
            <p className="mb-hint">Generates an invoice from all uninvoiced bills for the customer in the chosen period. 18% tax applied.</p>
            <form onSubmit={handleCreateInv}>
              <div className="mb-field">
                <label>Customer *</label>
                <select value={invForm.customer_id} onChange={(e) => setInvForm((f) => ({ ...f, customer_id: e.target.value }))} required>
                  <option value="">Select customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} – {c.phone}</option>
                  ))}
                </select>
              </div>
              <div className="mb-form-row">
                <div className="mb-field">
                  <label>Period start *</label>
                  <input type="date" value={invForm.period_start} onChange={(e) => setInvForm((f) => ({ ...f, period_start: e.target.value }))} required />
                </div>
                <div className="mb-field">
                  <label>Period end *</label>
                  <input type="date" value={invForm.period_end} onChange={(e) => setInvForm((f) => ({ ...f, period_end: e.target.value }))} required />
                </div>
              </div>
              <div className="mb-form-row">
                <div className="mb-field">
                  <label>Discount (TSh)</label>
                  <input type="number" step="0.01" min={0} value={invForm.discount} onChange={(e) => setInvForm((f) => ({ ...f, discount: e.target.value }))} placeholder="0" inputMode="decimal" />
                </div>
                <div className="mb-field">
                  <label>Credit (TSh)</label>
                  <input type="number" step="0.01" min={0} value={invForm.credit_amount} onChange={(e) => setInvForm((f) => ({ ...f, credit_amount: e.target.value }))} placeholder="0" inputMode="decimal" />
                </div>
              </div>
              <div className="mb-field">
                <label>Notes</label>
                <input type="text" value={invForm.notes} onChange={(e) => setInvForm((f) => ({ ...f, notes: e.target.value }))} />
              </div>
              <div className="mb-form-actions">
                <button type="button" className="mb-btn secondary" onClick={() => setShowInvForm(false)}>Cancel</button>
                <button type="submit" className="mb-btn primary" disabled={submitting}>{submitting ? 'Creating…' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showPayModal && viewInvoice && (
        <div className="mb-modal-overlay" onClick={() => { setShowPayModal(false); setViewInvoice(null); }}>
          <div className="mb-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Record payment</h3>
            <p className="mb-hint">Invoice {viewInvoice.invoice_number} · Balance due: {formatMoney(viewInvoice.balance_due)}. Full payment only.</p>
            <form onSubmit={handleRecordPayment}>
              <div className="mb-field">
                <label>Amount (TSh) *</label>
                <input type="number" step="0.01" min={0} value={payForm.amount} onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))} required inputMode="decimal" />
              </div>
              <div className="mb-field">
                <label>Payment date *</label>
                <input type="date" value={payForm.payment_date} onChange={(e) => setPayForm((f) => ({ ...f, payment_date: e.target.value }))} required />
              </div>
              <div className="mb-field">
                <label>Method</label>
                <select value={payForm.payment_method} onChange={(e) => setPayForm((f) => ({ ...f, payment_method: e.target.value }))}>
                  <option value="cash">Cash</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="cheque">Cheque</option>
                  <option value="mobile_money">Mobile money</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="mb-field">
                <label>Reference</label>
                <input type="text" value={payForm.reference_number} onChange={(e) => setPayForm((f) => ({ ...f, reference_number: e.target.value }))} />
              </div>
              <div className="mb-field">
                <label>Notes</label>
                <input type="text" value={payForm.notes} onChange={(e) => setPayForm((f) => ({ ...f, notes: e.target.value }))} />
              </div>
              <div className="mb-form-actions">
                <button type="button" className="mb-btn secondary" onClick={() => { setShowPayModal(false); setViewInvoice(null); }}>Cancel</button>
                <button type="submit" className="mb-btn primary" disabled={submitting}>{submitting ? 'Recording…' : 'Record payment'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {viewInvoice && !showPayModal && (
        <div className="mb-modal-overlay" onClick={() => setViewInvoice(null)}>
          <div className="mb-modal mb-invoice-detail" onClick={(e) => e.stopPropagation()}>
            <h3>Invoice {viewInvoice.invoice_number}</h3>
            <p>{viewInvoice.customer_name || viewInvoice.company_name} · {formatDate(viewInvoice.period_start)} – {formatDate(viewInvoice.period_end)}</p>
            <div className="mb-inv-totals">
              <div>Subtotal: {formatMoney(viewInvoice.subtotal)}</div>
              <div>Tax (18%): {formatMoney(viewInvoice.tax_amount)}</div>
              {viewInvoice.discount > 0 && <div>Discount: {formatMoney(viewInvoice.discount)}</div>}
              {viewInvoice.credit_amount > 0 && <div>Credit: {formatMoney(viewInvoice.credit_amount)}</div>}
              <div><strong>Total: {formatMoney(viewInvoice.total_amount)}</strong></div>
              <div>Paid: {formatMoney(viewInvoice.paid_amount)}</div>
              <div>Balance due: {formatMoney(viewInvoice.balance_due)}</div>
            </div>
            {viewInvoice.items && viewInvoice.items.length > 0 && (
              <table className="mb-table">
                <thead>
                  <tr>
                    <th>Bill ID</th>
                    <th>Billing date</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {viewInvoice.items.map((it) => (
                    <tr key={it.id}>
                      <td>{it.description?.split(' • ')[0] || '—'}</td>
                      <td>{formatDate(it.billing_date)}</td>
                      <td>{formatMoney(it.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mb-form-actions">
              <button type="button" className="mb-btn secondary" onClick={() => setViewInvoice(null)}>Close</button>
              {viewInvoice.balance_due > 0 && (
                <button type="button" className="mb-btn primary" onClick={() => { setPayForm((p) => ({ ...p, amount: String(viewInvoice.balance_due) })); setShowPayModal(true); }}>Record payment</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MonthlyBilling;
