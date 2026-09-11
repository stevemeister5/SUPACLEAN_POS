import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { getExpenses, createExpense, updateExpense, deleteExpense, getExpenseSummary, getActiveBankAccounts, getPayrollEmployeesForAdvances, recalculateDailyCashForDate, getExpenseCategories, createExpenseCategory } from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import useHorizontalScrollRegion from '../hooks/useHorizontalScrollRegion';
import Loader from '../components/Loader';
import { getBusinessTodayYmd } from '../utils/businessDate';
import './Expenses.css';

const DEFAULT_EXPENSE_CATEGORIES = [
  'Lunch',
  'Breakfast',
  'Car Fuel',
  'Rent',
  'Salaries',
  'Salary Advance',
  'Maintenance & Repairs',
  'Water Bill',
  'Electricity',
  'Office Supplies',
  'Transport',
  'Other'
];

const PAYMENT_SOURCES = [
  { value: 'cash', label: '💵 Cash in Hand' },
  { value: 'bank', label: '🏦 Cash at Bank' },
  { value: 'mpesa', label: '📱 M-Pesa' }
];

const Expenses = () => {
  const { showToast, ToastContainer } = useToast();
  const { hasPermission, selectedBranchId } = useAuth();
  const canManageCash = hasPermission?.('canManageCash') ?? false;
  const [expenses, setExpenses] = useState([]);
  const [summary, setSummary] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({
    date: getBusinessTodayYmd(),
    category: '',
    amount: '',
    payment_source: 'cash',
    description: '',
    receipt_number: '',
    bank_account_id: '',
    deposit_reference_number: '',
    bank_name: '',
    employee_id: ''
  });
  const [filterDate, setFilterDate] = useState(() => getBusinessTodayYmd());
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [payrollEmployees, setPayrollEmployees] = useState([]);
  const [savingClosing, setSavingClosing] = useState(false);
  const [customCategoryRows, setCustomCategoryRows] = useState([]);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);
  const [acknowledgeReconciledDay, setAcknowledgeReconciledDay] = useState(false);
  const tableScrollHandlers = useHorizontalScrollRegion();

  const loadCategories = useCallback(async () => {
    try {
      const res = await getExpenseCategories();
      setCustomCategoryRows(Array.isArray(res.data?.custom) ? res.data.custom : []);
    } catch {
      setCustomCategoryRows([]);
    }
  }, []);

  const expenseCategoriesForSelect = useMemo(() => {
    const customNames = (customCategoryRows || []).map((r) => r.name).filter(Boolean);
    const builtSet = new Set(DEFAULT_EXPENSE_CATEGORIES.map((c) => c.toLowerCase()));
    const extra = customNames.filter((n) => !builtSet.has(String(n).toLowerCase()));
    extra.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    let list = [...DEFAULT_EXPENSE_CATEGORIES, ...extra];
    const cur = formData.category && String(formData.category).trim();
    if (cur && !list.some((c) => String(c).toLowerCase() === cur.toLowerCase())) {
      list = [formData.category, ...list];
    }
    return list;
  }, [customCategoryRows, formData.category]);

  useEffect(() => {
    loadExpenses();
  }, [filterDate]);

  useEffect(() => {
    getActiveBankAccounts().then((res) => setBankAccounts(res.data || [])).catch(() => setBankAccounts([]));
    getPayrollEmployeesForAdvances().then((res) => setPayrollEmployees(res.data || [])).catch(() => setPayrollEmployees([]));
  }, []);

  useEffect(() => {
    loadCategories();
  }, [selectedBranchId, loadCategories]);

  const handleAddCategory = async () => {
    const raw = newCategoryName.trim();
    if (!raw) {
      showToast('Enter a category name', 'warning');
      return;
    }
    setSavingCategory(true);
    try {
      const res = await createExpenseCategory({ name: raw });
      const name = res.data?.name || raw;
      await loadCategories();
      setFormData((f) => ({ ...f, category: name }));
      setNewCategoryName('');
      setShowAddCategory(false);
      showToast('Category added', 'success');
    } catch (error) {
      showToast(error.response?.data?.error || error.message || 'Could not add category', 'error');
    } finally {
      setSavingCategory(false);
    }
  };

  const loadExpenses = async () => {
    try {
      const [expensesRes, summaryRes] = await Promise.all([
        getExpenses({ start_date: filterDate, end_date: filterDate }),
        getExpenseSummary({ start_date: filterDate, end_date: filterDate })
      ]);
      setExpenses(expensesRes.data || []);
      setSummary(summaryRes.data || []);
      if (expensesRes.fromCache && expensesRes.syncedAt) setLastSyncedAt(expensesRes.syncedAt);
      else if (summaryRes.fromCache && summaryRes.syncedAt) setLastSyncedAt(summaryRes.syncedAt);
      else setLastSyncedAt(null);
    } catch (error) {
      console.error('Error loading expenses:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Network Error';
      if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Network Error')) {
        showToast('Cannot connect to server. Please ensure the server is running.', 'error');
      } else {
        showToast('Error loading expenses: ' + errorMsg, 'error');
      }
      setExpenses([]);
      setSummary([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveDailyClosing = async () => {
    if (!canManageCash) return;
    setSavingClosing(true);
    try {
      await recalculateDailyCashForDate(filterDate);
      showToast(`Daily closing updated for ${filterDate} (cash management report).`, 'success');
    } catch (error) {
      const msg = error.response?.data?.error || error.message || 'Failed to update daily closing';
      if (error.response?.status === 409) {
        const offerForce = window.confirm(
          `${msg}\n\nReload this day’s figures from live data (orders, expenses, bank deposits)? The day stays reconciled; only stored totals are updated.`
        );
        if (offerForce) {
          try {
            await recalculateDailyCashForDate(filterDate, { force: true });
            showToast(`Daily closing refreshed for ${filterDate} (includes bank deposits and expenses).`, 'success');
          } catch (err2) {
            showToast('Error: ' + (err2.response?.data?.error || err2.message), 'error');
          }
        }
      } else {
        showToast('Error updating daily closing: ' + msg, 'error');
      }
    } finally {
      setSavingClosing(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingId) {
        const res = await updateExpense(editingId, {
          ...formData,
          acknowledge_reconciled_day: acknowledgeReconciledDay
        });
        const days = res?.data?.reconciled_days_refreshed;
        if (Array.isArray(days) && days.length) {
          showToast('Expense updated; reconciled daily summary was recalculated for the affected date(s).', 'success');
        } else {
          showToast('Expense updated successfully', 'success');
        }
      } else {
        const res = await createExpense({
          ...formData,
          acknowledge_reconciled_day: acknowledgeReconciledDay,
          created_by: 'Cashier',
          ...(formData.category === 'Bank Deposit' && {
            bank_account_id: formData.bank_account_id === 'other' ? '' : formData.bank_account_id,
            deposit_reference_number: formData.deposit_reference_number || undefined,
            bank_name: formData.bank_account_id === 'other' ? formData.bank_name : undefined
          }),
          ...(formData.category === 'Salary Advance' && {
            employee_id: Number(formData.employee_id || 0)
          })
        });
        const data = res?.data;
        if (data?.reconciled_day_refreshed) {
          showToast('Expense recorded and reconciled daily summary was recalculated for that date.', 'success');
        } else if (data?.daily_closing_locked) {
          showToast('Expense recorded. That day is already reconciled — daily closing was not changed automatically.', 'warning');
        } else {
          showToast('Expense added and daily closing updated for that date.', 'success');
        }
      }
      resetForm();
      loadExpenses();
    } catch (error) {
      showToast('Error saving expense: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  const handleEdit = (expense) => {
    const hasOtherBank = expense.category === 'Bank Deposit' && !expense.bank_account_id && (expense.deposit_bank_name || expense.bank_name);
    const expenseDateStr = expense.date != null ? String(expense.date).slice(0, 10) : filterDate;
    setAcknowledgeReconciledDay(false);
    setEditingId(expense.id);
    setFormData({
      date: expenseDateStr,
      category: expense.category,
      amount: expense.amount,
      payment_source: expense.payment_source,
      description: expense.description || '',
      receipt_number: expense.receipt_number || '',
      bank_account_id: hasOtherBank ? 'other' : (expense.bank_account_id != null ? String(expense.bank_account_id) : ''),
      deposit_reference_number: expense.deposit_reference_number || '',
      bank_name: expense.deposit_bank_name || expense.bank_name || '',
      employee_id: expense.salary_advance_employee_id != null ? String(expense.salary_advance_employee_id) : ''
    });
    setShowForm(true);
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to void this expense?')) {
      return;
    }
    try {
      const res = await deleteExpense(id);
      const days = res?.data?.reconciled_days_refreshed;
      if (Array.isArray(days) && days.length) {
        showToast('Expense voided; reconciled daily summary was recalculated for the affected date(s).', 'success');
      } else {
        showToast('Expense voided successfully', 'success');
      }
      loadExpenses();
    } catch (error) {
      const status = error.response?.status;
      const msg = error.response?.data?.error || error.message;
      const code = error.response?.data?.code;
      if (status === 409 && code === 'reconciled_day') {
        if (
          !window.confirm(
            'This day is reconciled. Voiding will recalculate the locked daily summary and refresh later pending days. Continue?'
          )
        ) {
          return;
        }
        try {
          const res2 = await deleteExpense(id, {
            void_reason: 'Voided by user',
            acknowledge_reconciled_day: true
          });
          const days = res2?.data?.reconciled_days_refreshed;
          if (Array.isArray(days) && days.length) {
            showToast('Expense voided; reconciled daily summary was recalculated for the affected date(s).', 'success');
          } else {
            showToast('Expense voided successfully', 'success');
          }
          loadExpenses();
        } catch (err2) {
          showToast('Error voiding expense: ' + (err2.response?.data?.error || err2.message), 'error');
        }
        return;
      }
      showToast('Error deleting expense: ' + msg, 'error');
    }
  };

  const resetForm = () => {
    setFormData({
      date: filterDate,
      category: '',
      amount: '',
      payment_source: 'cash',
      description: '',
      receipt_number: '',
      bank_account_id: '',
      deposit_reference_number: '',
      bank_name: '',
      employee_id: ''
    });
    setAcknowledgeReconciledDay(false);
    setEditingId(null);
    setShowForm(false);
  };

  const handleToggleAddForm = () => {
    if (showForm) {
      resetForm();
      return;
    }
    setEditingId(null);
    setFormData({
      date: filterDate,
      category: '',
      amount: '',
      payment_source: 'cash',
      description: '',
      receipt_number: '',
      bank_account_id: '',
      deposit_reference_number: '',
      bank_name: '',
      employee_id: ''
    });
    setAcknowledgeReconciledDay(false);
    setShowForm(true);
  };

  const totalBySource = {
    cash: expenses.filter(e => e.payment_source === 'cash').reduce((sum, e) => sum + parseFloat(e.amount), 0),
    bank: expenses.filter(e => e.payment_source === 'bank').reduce((sum, e) => sum + parseFloat(e.amount), 0),
    mpesa: expenses.filter(e => e.payment_source === 'mpesa').reduce((sum, e) => sum + parseFloat(e.amount), 0)
  };

  const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);

  if (loading) {
    return <Loader message="Loading expenses…" fullPage />;
  }

  return (
    <div className="expenses-page">
      <ToastContainer />
      <div className="page-header">
        <div>
          <h1>📝 Expenses</h1>
          <p className="subtitle">Track daily business expenses. Branch managers can add custom categories for their branch below the category field.</p>
        </div>
        <button
          onClick={handleToggleAddForm}
          className={`dk-btn dk-btn--md ${showForm ? 'dk-btn--secondary' : 'dk-btn--primary'}`}
          type="button"
        >
          {showForm ? 'Cancel' : '+ Add Expense'}
        </button>
      </div>

      {lastSyncedAt && (
        <div className="sync-cache-banner" role="status">
          Showing data from last sync — {new Date(lastSyncedAt).toLocaleString()}
        </div>
      )}

      {/* Date Filter */}
      <div className="filter-section" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }}>
        <div className="filter-date-block">
          <label htmlFor="expenses-filter-date">View / post expenses for:</label>
          <input
            id="expenses-filter-date"
            type="date"
            max={getBusinessTodayYmd()}
            value={filterDate}
            onChange={(e) => setFilterDate(e.target.value)}
            className="date-filter"
          />
          <p className="filter-date-hint">Choosing a date here loads that day’s list and sets the default <strong>Expense date</strong> when you add a new row. Daily closing uses the date in the form.</p>
        </div>
        {canManageCash && (
          <button
            type="button"
            className="dk-btn dk-btn--secondary dk-btn--md"
            disabled={savingClosing}
            onClick={handleSaveDailyClosing}
            title="Recalculates daily closing and cashflow figures for this date from expenses and sales (skipped if the day is already reconciled)."
          >
            {savingClosing ? 'Saving…' : 'Save to daily closing'}
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="summary-cards">
        <div className="summary-card total">
          <h3>Total Expenses</h3>
          <div className="amount">TSh {totalExpenses.toLocaleString()}</div>
          <small>{expenses.length} expense{expenses.length !== 1 ? 's' : ''} recorded</small>
        </div>
        <div className="summary-card cash">
          <h3>From Cash</h3>
          <div className="amount">TSh {totalBySource.cash.toLocaleString()}</div>
        </div>
        <div className="summary-card bank">
          <h3>From Bank</h3>
          <div className="amount">TSh {totalBySource.bank.toLocaleString()}</div>
        </div>
        <div className="summary-card mpesa">
          <h3>From M-Pesa</h3>
          <div className="amount">TSh {totalBySource.mpesa.toLocaleString()}</div>
        </div>
      </div>

      {/* Expense Form */}
      {showForm && (
        <div className="expense-form-card">
          <h2>{editingId ? 'Edit Expense' : 'Add New Expense'}</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-grid">
              <div className="form-group">
                <label>Expense date * (cash & reports)</label>
                <input
                  type="date"
                  max={getBusinessTodayYmd()}
                  value={formData.date}
                  onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                  required
                />
                <small className="form-hint-muted">This calendar day receives the amount in Cash Management and pending reconciliations.</small>
              </div>
              <div className="form-group">
                <label>Category *</label>
                <p className="form-hint-muted" style={{ marginBottom: '8px' }}>
                  Bank deposits are recorded under <strong>Cash Management → Bank deposits</strong>, not here.
                </p>
                <select
                  value={formData.category}
                  onChange={(e) => {
                  const cat = e.target.value;
                  setFormData({
                    ...formData,
                    category: cat,
                    ...(cat === 'Bank Deposit' && { payment_source: 'cash' })
                  });
                }}
                  required
                >
                  <option value="">Select category...</option>
                  {expenseCategoriesForSelect.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
                <div className="expense-add-category">
                  <p className="expense-add-category-hint">Saves under your branch (no admin required).</p>
                  {!showAddCategory ? (
                    <button
                      type="button"
                      className="expense-add-category-toggle"
                      onClick={() => setShowAddCategory(true)}
                    >
                      + Add category
                    </button>
                  ) : (
                    <div className="expense-add-category-row">
                      <input
                        type="text"
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        placeholder="New category name"
                        maxLength={120}
                        className="expense-add-category-input"
                        aria-label="New expense category name"
                      />
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        disabled={savingCategory}
                        onClick={handleAddCategory}
                      >
                        {savingCategory ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        disabled={savingCategory}
                        onClick={() => {
                          setShowAddCategory(false);
                          setNewCategoryName('');
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="form-group">
                <label>Amount *</label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={formData.amount}
                  onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>Payment Source *</label>
                <select
                  value={formData.payment_source}
                  onChange={(e) => setFormData({ ...formData, payment_source: e.target.value })}
                  required
                >
                  {PAYMENT_SOURCES.map(source => (
                    <option key={source.value} value={source.value}>{source.label}</option>
                  ))}
                </select>
              </div>
              {formData.category === 'Bank Deposit' && (
                <>
                  <div className="form-group">
                    <label>Bank / Account *</label>
                    <select
                      value={formData.bank_account_id}
                      onChange={(e) => setFormData({ ...formData, bank_account_id: e.target.value, bank_name: e.target.value === 'other' ? formData.bank_name : '' })}
                      required
                    >
                      <option value="">Select bank...</option>
                      {bankAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>{acc.name}{acc.account_number ? ` (${acc.account_number})` : ''}</option>
                      ))}
                      <option value="other">Other (enter name below)</option>
                    </select>
                  </div>
                  {formData.bank_account_id === 'other' && (
                    <div className="form-group">
                      <label>Bank name</label>
                      <input
                        type="text"
                        value={formData.bank_name}
                        onChange={(e) => setFormData({ ...formData, bank_name: e.target.value })}
                        placeholder="e.g. CRDB Branch X"
                      />
                    </div>
                  )}
                  <div className="form-group">
                    <label>Reference (optional)</label>
                    <input
                      type="text"
                      value={formData.deposit_reference_number}
                      onChange={(e) => setFormData({ ...formData, deposit_reference_number: e.target.value })}
                      placeholder="Deposit slip / transaction ref"
                    />
                  </div>
                </>
              )}
              {formData.category === 'Salary Advance' && (
                <div className="form-group">
                  <label>Employee *</label>
                  <select
                    value={formData.employee_id}
                    onChange={(e) => setFormData({ ...formData, employee_id: e.target.value })}
                    required
                  >
                    <option value="">Select employee...</option>
                    {payrollEmployees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.full_name}{emp.employee_code ? ` (${emp.employee_code})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="form-group full-width">
                <label>Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows="2"
                  placeholder="Additional details..."
                />
              </div>
              <div className="form-group">
                <label>Receipt Number</label>
                <input
                  type="text"
                  value={formData.receipt_number}
                  onChange={(e) => setFormData({ ...formData, receipt_number: e.target.value })}
                  placeholder="Optional"
                />
              </div>
              <div className="form-group full-width" style={{ marginTop: '4px' }}>
                <label className="expense-reconciled-ack" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontWeight: 'normal', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={acknowledgeReconciledDay}
                    onChange={(e) => setAcknowledgeReconciledDay(e.target.checked)}
                    style={{ marginTop: '3px' }}
                  />
                  <span>
                    <strong>Adjust reconciled day</strong> — allow this entry to update a day that is already reconciled. The locked daily summary for that date is recalculated and later pending days are refreshed.
                  </span>
                </label>
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn-primary">
                {editingId ? 'Update Expense' : 'Add Expense'}
              </button>
              <button type="button" onClick={resetForm} className="btn-secondary">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Expenses List */}
      <div className="expenses-list-card">
        <h2>Expenses List</h2>
        {expenses.length > 0 ? (
          <div
            className="expenses-table-wrapper interactive-scroll-region"
            tabIndex={0}
            role="region"
            aria-label="Expenses table"
            {...tableScrollHandlers}
          >
            <table className="expenses-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Bank</th>
                  <th>Amount</th>
                  <th>Payment Source</th>
                  <th>Description</th>
                  <th>Employee</th>
                  <th>Receipt</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map(expense => (
                  <tr key={expense.id}>
                    <td>{new Date(expense.date).toLocaleDateString()}</td>
                    <td>
                      <span className="category-badge">{expense.category}</span>
                    </td>
                    <td className="bank-cell">
                      {expense.category === 'Bank Deposit'
                        ? (expense.bank_account_name || expense.deposit_bank_name || '-')
                        : '-'}
                    </td>
                    <td className="amount-cell">
                      <strong>TSh {parseFloat(expense.amount).toLocaleString()}</strong>
                    </td>
                    <td>
                      <span className={`source-badge ${expense.payment_source}`}>
                        {PAYMENT_SOURCES.find(s => s.value === expense.payment_source)?.label.split(' ')[1] || expense.payment_source}
                      </span>
                    </td>
                    <td className="description-cell">{expense.description || '-'}</td>
                    <td>{expense.salary_advance_employee_name || '-'}</td>
                    <td className="receipt-cell">{expense.receipt_number || '-'}</td>
                    <td>
                      <div className="action-buttons">
                        <button
                          onClick={() => handleEdit(expense)}
                          className="btn-edit"
                          type="button"
                          title="Edit"
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => handleDelete(expense.id)}
                          className="btn-delete"
                          type="button"
                          title="Delete"
                        >
                          🗑️
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">📝</div>
            <p>No expenses recorded for this date</p>
            <small>Click "Add Expense" to get started</small>
          </div>
        )}
      </div>
    </div>
  );
};

export default Expenses;
