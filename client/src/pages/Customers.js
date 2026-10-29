import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  getCustomers,
  createCustomer,
  updateCustomer,
  uploadCustomersExcel,
  checkServerConnection,
  sendBalanceReminder,
  getCustomerLoyalty,
  getLoyaltyTransactions,
  redeemLoyaltyPoints,
} from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import { useListViewPreference } from '../hooks/useListViewPreference';
import ListViewToggle from '../components/ListViewToggle';
import SkeletonList from '../components/SkeletonList';
import Loader from '../components/Loader';
import { exportToPDF, exportToExcel } from '../utils/exportUtils';
import './Customers.css';

const CUSTOMERS_EXPORT_COLUMNS = [
  { key: 'branch_id', label: 'Branch ID' },
  { key: 'branch_name', label: 'Branch' },
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'address', label: 'Address' },
  { key: 'tier', label: 'Tier' },
  { key: 'current_points', label: 'Current Points' },
  { key: 'lifetime_points', label: 'Lifetime Points' },
  { key: 'outstanding_balance', label: 'Outstanding Balance' },
  { key: 'tags', label: 'Tags' },
];

const Customers = () => {
  const { showToast, ToastContainer } = useToast();
  const { branch, hasPermission, selectedBranchId } = useAuth();
  const [listView, setListView] = useListViewPreference();
  const [customers, setCustomers] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newCustomer, setNewCustomer] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
    tags: ''
  });
  const [editingTags, setEditingTags] = useState(null);
  const [tagInput, setTagInput] = useState('');
  const [availableTags, setAvailableTags] = useState([]);
  const [sendingReminder, setSendingReminder] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showExportPopup, setShowExportPopup] = useState(false);
  const searchInputRef = useRef(null);
  // Loyalty (Task 3.2/3.3)
  const [loyaltyData, setLoyaltyData] = useState({}); // customerId -> {current_points, lifetime_points, tier, ...}
  const [loyaltyTransactions, setLoyaltyTransactions] = useState([]); // for the open customer
  const [loyaltyCustomerId, setLoyaltyCustomerId] = useState(null); // customer whose detail is open
  const [showRedeemModal, setShowRedeemModal] = useState(false);
  const [redeemPoints, setRedeemPoints] = useState('');
  const [redeeming, setRedeeming] = useState(null);

  const CUSTOMERS_PAGE_SIZE = 50;

  const loadCustomers = useCallback(async (append = false, offsetOverride = undefined) => {
    const offset = append ? (offsetOverride ?? 0) : 0;
    try {
      if (append) setLoadingMore(true);
      else setLoading(true);
      const res = await getCustomers(debouncedSearchTerm, { limit: CUSTOMERS_PAGE_SIZE, offset, light: true });
      const data = res.data || [];
      if (append) setCustomers(prev => [...prev, ...data]);
      else setCustomers(data);
      setHasMore(Boolean(res.hasMore));
      if (res.fromCache && res.syncedAt) setLastSyncedAt(res.syncedAt);
      else setLastSyncedAt(null);
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message || 'Network Error';
      const userFriendlyMsg = errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Network Error') || errorMsg.includes('No response')
        ? 'Cannot connect to server. Please ensure the server is running on port 5000.'
        : errorMsg;
      console.error('Error loading customers:', error);
      showToast(`Error loading customers: ${userFriendlyMsg}`, 'error');
      if (!append) setCustomers([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [debouncedSearchTerm, showToast]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), 400);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    if (debouncedSearchTerm === '' && typeof navigator !== 'undefined' && navigator.onLine) {
      checkServerConnection().then(result => {
        if (!result.connected) showToast('Server connection issue: ' + result.details, 'error');
      });
    }
    loadCustomers(false);
  }, [debouncedSearchTerm, loadCustomers, showToast, selectedBranchId]);

  const handleCreateCustomer = async (e) => {
    e.preventDefault();
    try {
      const res = await createCustomer(newCustomer);
      setNewCustomer({ name: '', phone: '', email: '', address: '' });
      setShowNewCustomer(false);
      showToast(
        res.data.existing
          ? (res.data.message || 'Customer with this phone already exists. They are in the list below.')
          : 'Customer created successfully',
        'success'
      );
      loadCustomers(false);
    } catch (error) {
      showToast('Error creating customer: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  const handleEdit = (customer) => {
    setEditingId(customer.id);
    setEditingCustomer({ ...customer, tags: customer.tags || '' });
  };

  const handleEditTags = (customer) => {
    setEditingTags(customer.id);
    setTagInput(customer.tags || '');
  };

  const handleSaveTags = async (customerId) => {
    try {
      await updateCustomer(customerId, { tags: tagInput });
      showToast('Tags updated successfully', 'success');
      setEditingTags(null);
      setTagInput('');
      loadCustomers(false);
    } catch (error) {
      showToast('Error updating tags: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  const parseTags = (tagsString) => {
    if (!tagsString) return [];
    return tagsString.split(',').map(t => t.trim()).filter(t => t);
  };

  const formatTags = (tagsArray) => {
    return Array.isArray(tagsArray) ? tagsArray.join(', ') : (tagsArray || '');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingCustomer(null);
  };

  const handleSave = async (id) => {
    try {
      await updateCustomer(id, editingCustomer);
      showToast('Customer updated successfully', 'success');
      setEditingId(null);
      setEditingCustomer(null);
      loadCustomers(false);
    } catch (error) {
      showToast('Error updating customer: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  // Task 3.2 — Fetch loyalty summary + recent transactions for a customer
  const fetchCustomerLoyalty = async (customerId) => {
    try {
      const [infoRes, txRes] = await Promise.all([
        getCustomerLoyalty(customerId),
        getLoyaltyTransactions(customerId, 20),
      ]);
      setLoyaltyData((prev) => ({ ...prev, [customerId]: infoRes.data }));
      setLoyaltyTransactions(txRes.data || []);
      setLoyaltyCustomerId(customerId);
    } catch (error) {
      console.error('Error fetching loyalty:', error);
    }
  };

  // Task 3.3 — Redeem points
  const openRedeem = (customerId, availablePoints) => {
    setLoyaltyCustomerId(customerId);
    setRedeemPoints('');
    setShowRedeemModal(true);
  };

  const handleRedeemSubmit = async (e) => {
    e.preventDefault();
    if (!loyaltyCustomerId) return;
    const points = parseInt(redeemPoints, 10);
    if (!points || points <= 0) {
      showToast('Enter a valid points amount', 'error');
      return;
    }
    const available = loyaltyData[loyaltyCustomerId]?.current_points ?? 0;
    if (points > available) {
      showToast(`Not enough points (available: ${available})`, 'error');
      return;
    }
    setRedeeming(loyaltyCustomerId);
    try {
      await redeemLoyaltyPoints(loyaltyCustomerId, points);
      showToast(`${points} points redeemed successfully`, 'success');
      setShowRedeemModal(false);
      setRedeemPoints('');
      await fetchCustomerLoyalty(loyaltyCustomerId);
      loadCustomers(false);
    } catch (error) {
      showToast('Error redeeming points: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setRedeeming(null);
    }
  };

  const handleExcelUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Check file type
    const validTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
      'text/csv' // .csv
    ];
    
    if (!validTypes.includes(file.type) && !file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
      showToast('Please upload a valid Excel file (.xlsx, .xls) or CSV file', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      showToast('Uploading and processing file...', 'info');
      const res = await uploadCustomersExcel(formData);
      showToast(`Successfully imported ${res.data.imported} customers! ${res.data.skipped > 0 ? `${res.data.skipped} duplicates skipped.` : ''}`, 'success');
      loadCustomers(false);
    } catch (error) {
      showToast('Error uploading file: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      // Reset file input
      e.target.value = '';
    }
  };

  const handleSendBalanceReminder = async (customerId, channels = ['sms']) => {
    try {
      setSendingReminder(customerId);
      const res = await sendBalanceReminder(customerId, channels);
      if (res.data.result.success) {
        showToast('Balance reminder sent successfully!', 'success');
      } else {
        showToast(res.data.result.error || 'Failed to send reminder', 'warning');
      }
    } catch (error) {
      showToast('Error sending reminder: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setSendingReminder(null);
    }
  };

  const handleExportCustomers = async (format) => {
    setExporting(true);
    try {
      const res = await getCustomers(debouncedSearchTerm, { limit: 500, offset: 0, light: false });
      const data = res.data || [];
      if (data.length === 0) {
        showToast('No customers to export', 'info');
        return;
      }
      const rows = data.map(c => ({
        branch_id: c.branch_id ?? '',
        branch_name: c.branch_name ?? '',
        name: c.name ?? '',
        phone: c.phone ?? '',
        email: c.email ?? '',
        address: c.address ?? '',
        outstanding_balance: c.outstanding_balance != null ? c.outstanding_balance : 0,
        tags: c.tags ?? '',
      }));
      const title = 'Customers_' + new Date().toISOString().slice(0, 10);
      const exportBranch = { branchName: branch?.name || rows[0]?.branch_name, branchId: branch?.id ?? rows[0]?.branch_id };
      if (format === 'pdf') await exportToPDF(title, CUSTOMERS_EXPORT_COLUMNS, rows, exportBranch);
      else await exportToExcel(title, CUSTOMERS_EXPORT_COLUMNS, rows, exportBranch);
      showToast(`Exported ${data.length} customers as ${format.toUpperCase()}`, 'success');
      setShowExportPopup(false);
    } catch (error) {
      showToast('Export failed: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="customers-page">
        <SkeletonList rows={12} />
      </div>
    );
  }

  return (
    <div className="customers-page">
      <ToastContainer />
      {showExportPopup && (
        <div className="export-popup-overlay" onClick={() => setShowExportPopup(false)} role="dialog" aria-label="Export options">
          <div className="export-popup" onClick={e => e.stopPropagation()}>
            <div className="export-popup-header">
              <h3>Export customers</h3>
              <button type="button" className="export-popup-close" onClick={() => setShowExportPopup(false)} aria-label="Close">×</button>
            </div>
            <p className="export-popup-hint">Choose format (Branch ID and phone included)</p>
            <div className="export-popup-actions">
              <button
                className="btn-primary"
                onClick={() => handleExportCustomers('pdf')}
                disabled={exporting}
              >
                {exporting ? '…' : 'PDF'}
              </button>
              <button
                className="btn-primary"
                onClick={() => handleExportCustomers('excel')}
                disabled={exporting}
              >
                {exporting ? '…' : 'Excel'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="page-header-modern">
        <div>
          <h1>Customers</h1>
          <p className="subtitle">Manage customer database</p>
        </div>
        <div className="header-actions">
          {hasPermission('canManageCustomers') && (
            <>
              <div style={{ position: 'relative' }}>
                <label className="dk-btn dk-btn--secondary dk-btn--md" style={{ cursor: 'pointer', marginRight: '12px' }} title="Upload Excel file with columns: Name, Phone, Email (optional), Address (optional)">
                  📤 Upload Excel
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    style={{ display: 'none' }}
                    onChange={handleExcelUpload}
                  />
                </label>
                <button
                  type="button"
                  className="dk-btn dk-btn--secondary dk-btn--md"
                  style={{ marginRight: '12px' }}
                  onClick={() => setShowExportPopup(true)}
                  disabled={exporting}
                  title="Export customers"
                >
                  {exporting ? '…' : 'Export'}
                </button>
              </div>
              <button
                type="button"
                className={`dk-btn dk-btn--md ${showNewCustomer ? 'dk-btn--secondary' : 'dk-btn--primary'}`}
                onClick={() => setShowNewCustomer(!showNewCustomer)}
              >
                {showNewCustomer ? 'Cancel' : '+ Add New Customer'}
              </button>
            </>
          )}
        </div>
      </div>

      {lastSyncedAt && (
        <div className="sync-cache-banner" role="status">
          Showing data from last sync — {new Date(lastSyncedAt).toLocaleString()}
        </div>
      )}
      <div className="filter-section">
        <div className="search-box">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search customers by name or phone..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
            }}
            autoComplete="off"
          />
        </div>
        <ListViewToggle view={listView} setView={setListView} />
      </div>

      {showNewCustomer && (
        <div className="new-customer-card">
          <h2>Add New Customer</h2>
          <form onSubmit={handleCreateCustomer}>
            <div className="form-row">
              <div className="form-group">
                <label>Name *</label>
                <input
                  type="text"
                  value={newCustomer.name}
                  onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>Phone Number *</label>
                <input
                  type="tel"
                  value={newCustomer.phone}
                  onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                  required
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Email</label>
                <input
                  type="email"
                  value={newCustomer.email}
                  onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>Address</label>
                <input
                  type="text"
                  value={newCustomer.address}
                  onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })}
                />
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn-primary">Create Customer</button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowNewCustomer(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {listView === 'card' ? (
        <div className="customers-cards-container">
          {editingId && editingCustomer && (
            <div className="customers-edit-card-inline">
              <h3>Edit customer</h3>
              <div className="form-row">
                <input className="edit-input" value={editingCustomer.name} onChange={(e) => setEditingCustomer({ ...editingCustomer, name: e.target.value })} placeholder="Name" />
                <input className="edit-input" value={editingCustomer.phone} onChange={(e) => setEditingCustomer({ ...editingCustomer, phone: e.target.value })} placeholder="Phone" />
                <input className="edit-input" value={editingCustomer.email || ''} onChange={(e) => setEditingCustomer({ ...editingCustomer, email: e.target.value })} placeholder="Email" />
                <input className="edit-input" value={editingCustomer.address || ''} onChange={(e) => setEditingCustomer({ ...editingCustomer, address: e.target.value })} placeholder="Address" />
              </div>
              <div className="form-row">
                <input className="edit-input" value={editingCustomer.tags || ''} onChange={(e) => setEditingCustomer({ ...editingCustomer, tags: e.target.value })} placeholder="Tags (comma-separated)" style={{ flex: 1 }} />
                <button type="button" className="btn-small btn-success" onClick={() => handleSave(editingId)}>✓ Save</button>
                <button type="button" className="btn-small btn-secondary" onClick={handleCancelEdit}>✕ Cancel</button>
              </div>
            </div>
          )}
          {customers.length === 0 ? (
            <div className="empty-state-modern">
              <p className="empty-state-title">No customers found</p>
              <p className="empty-state-hint">Try a different search or add a new customer above.</p>
            </div>
          ) : (
            <div className="customers-cards-grid">
              {customers.map(customer => {
                const balance = customer.outstanding_balance || 0;
                return (
                  <div key={customer.id} className="customers-list-card dk-queue-card">
                    <div className="customers-list-card-header">
                      <div className="customer-avatar-table">{(customer.name || '?').charAt(0).toUpperCase()}</div>
                      <strong>{customer.name}</strong>
                    </div>
                    <div className="customers-list-card-body">
                      <p>{customer.phone}</p>
                      <p className="text-muted">{customer.email || '—'}</p>
                      <p className="text-muted">{customer.address || '—'}</p>
                      <p>{balance > 0 ? <span style={{ color: 'var(--warning-color)', fontWeight: 'bold' }}>TSh {balance.toLocaleString()}</span> : <span style={{ color: 'var(--success-color)' }}>TSh 0</span>}</p>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                        {parseTags(customer.tags).length > 0 ? parseTags(customer.tags).map((tag, idx) => <span key={idx} className="tag-badge">{tag}</span>) : <span className="text-muted">No tags</span>}
                      </div>
                    </div>
                    <div className="customers-list-card-actions">
                      {hasPermission('canManageCustomers') && editingId !== customer.id && (
                        <button type="button" className="btn-small btn-primary" onClick={() => handleEdit(customer)}>✏️ Edit</button>
                      )}
                      {balance > 0 && (
                        <button type="button" className="btn-small btn-warning" onClick={() => handleSendBalanceReminder(customer.id)} disabled={sendingReminder === customer.id}>📱 Remind</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {hasMore && !loading && listView === 'card' && (
            <div className="load-more-row" style={{ padding: '12px', textAlign: 'center' }}>
              <button type="button" className="btn-secondary" onClick={() => loadCustomers(true, customers.length)} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more customers'}
              </button>
            </div>
          )}
        </div>
      ) : (
      <>
      <div className="customers-table-container">
        <table className="customers-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Address</th>
              <th>Home Branch</th>
              <th>Loyalty</th>
              <th>Outstanding Balance</th>
              <th>Tags</th>
              <th>Joined</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td colSpan="8" className="empty-state-modern-cell">
                  <p className="empty-state-title">No customers found</p>
                  <p className="empty-state-hint">Try a different search or add a new customer above.</p>
                </td>
              </tr>
            ) : (
              customers.map(customer => (
                <tr key={customer.id}>
                  {editingId === customer.id ? (
                    <>
                      <td>
                        <input
                          type="text"
                          value={editingCustomer.name}
                          onChange={(e) => setEditingCustomer({ ...editingCustomer, name: e.target.value })}
                          className="edit-input"
                        />
                      </td>
                      <td>
                        <input
                          type="tel"
                          value={editingCustomer.phone}
                          onChange={(e) => setEditingCustomer({ ...editingCustomer, phone: e.target.value })}
                          className="edit-input"
                        />
                      </td>
                      <td>
                        <input
                          type="email"
                          value={editingCustomer.email || ''}
                          onChange={(e) => setEditingCustomer({ ...editingCustomer, email: e.target.value })}
                          className="edit-input"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={editingCustomer.address || ''}
                          onChange={(e) => setEditingCustomer({ ...editingCustomer, address: e.target.value })}
                          className="edit-input"
                        />
                      </td>
                      <td>
                        <span style={{ color: 'var(--text-secondary)' }}>N/A (Edit mode)</span>
                      </td>
                      <td>
                        <input
                          type="text"
                          placeholder="VIP, Regular, New (comma-separated)"
                          value={editingCustomer.tags || ''}
                          onChange={(e) => setEditingCustomer({ ...editingCustomer, tags: e.target.value })}
                          className="edit-input"
                        />
                      </td>
                      <td>
                        {new Date(customer.created_at).toLocaleDateString()}
                      </td>
                      <td>
                        <div className="action-buttons">
                          <button
                            className="btn-small btn-success"
                            onClick={() => handleSave(customer.id)}
                          >
                            ✓ Save
                          </button>
                          <button
                            className="btn-small btn-secondary"
                            onClick={handleCancelEdit}
                          >
                            ✕ Cancel
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <div className="customer-cell">
                          <div className="customer-avatar-table">
                            {(customer.name || '?').charAt(0).toUpperCase()}
                          </div>
                          <strong>{customer.name}</strong>
                        </div>
                      </td>
                      <td>{customer.phone}</td>
                      <td>{customer.email || '-'}</td>
                      <td>{customer.address || '-'}</td>
                      <td>
                        {customer.branch_name ? (
                          <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>{customer.branch_name}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>-</span>
                        )}
                      </td>
                      <td style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' }}>
                        <span className={`badge-tier-${(customer.tier || 'bronze').toLowerCase()}`} style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '10px', textTransform: 'capitalize' }}>
                          {customer.tier || 'Bronze'}
                        </span>
                        <span style={{ color: 'var(--text-muted)' }}>{customer.current_points || 0} pts</span>
                      </td>
                      <td>
                        {(() => {
                          const balance = customer.outstanding_balance || 0;
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              {balance > 0 ? (
                                <>
                                  <span style={{ color: 'var(--warning-color)', fontWeight: 'bold' }}>
                                    TSh {balance.toLocaleString()}
                                  </span>
                                  <button
                                    className="btn-small btn-warning"
                                    onClick={() => handleSendBalanceReminder(customer.id)}
                                    disabled={sendingReminder === customer.id}
                                    title="Send balance reminder via SMS/WhatsApp"
                                    style={{ fontSize: '12px', padding: '4px 8px' }}
                                  >
                                    {sendingReminder === customer.id ? '⏳' : '📱 Remind'}
                                  </button>
                                </>
                              ) : (
                                <span style={{ color: 'var(--success-color)' }}>TSh 0</span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td>
                        {editingTags === customer.id ? (
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                            <input
                              type="text"
                              value={tagInput}
                              onChange={(e) => setTagInput(e.target.value)}
                              className="edit-input"
                              style={{ flex: 1, minWidth: '150px' }}
                              placeholder="Tags (comma-separated)"
                              onKeyPress={(e) => {
                                if (e.key === 'Enter') {
                                  handleSaveTags(customer.id);
                                }
                              }}
                            />
                            <button
                              className="btn-small btn-success"
                              onClick={() => handleSaveTags(customer.id)}
                            >
                              ✓
                            </button>
                            <button
                              className="btn-small btn-secondary"
                              onClick={() => {
                                setEditingTags(null);
                                setTagInput('');
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                            {parseTags(customer.tags).length > 0 ? (
                              parseTags(customer.tags).map((tag, idx) => (
                                <span key={idx} className="tag-badge">
                                  {tag}
                                </span>
                              ))
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No tags</span>
                            )}
                            {hasPermission('canManageCustomers') && (
                              <button
                                className="btn-small btn-secondary"
                                onClick={() => handleEditTags(customer)}
                                style={{ marginLeft: '4px' }}
                              >
                                ✏️
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td>{new Date(customer.created_at).toLocaleDateString()}</td>
                      <td>
                        <div className="action-buttons">
                          {hasPermission('canManageCustomers') && (
                            <button
                              className="btn-small btn-primary"
                              onClick={() => handleEdit(customer)}
                            >
                              ✏️ Edit
                            </button>
                          )}
                          {hasPermission('canManageCustomers') && (
                            <button
                              className="btn-small btn-info"
                              onClick={() => fetchCustomerLoyalty(customer.id)}
                              disabled={redeeming === customer.id}
                              title="View loyalty points, tier & transactions"
                            >
                              🏅 Loyalty
                            </button>
                          )}
                          {(customer.current_points || 0) >= 10 && hasPermission('canManageCustomers') && (
                            <button
                              className="btn-small btn-success"
                              onClick={() => openRedeem(customer.id, customer.current_points)}
                              disabled={redeeming === customer.id}
                              title="Redeem points for discount"
                            >
                              🎟️ Redeem
                            </button>
                          )}
                          {(customer.outstanding_balance || 0) > 0 && hasPermission('canManageCustomers') && (
                            <button
                              className="btn-small btn-warning"
                              onClick={() => handleSendBalanceReminder(customer.id)}
                              disabled={sendingReminder === customer.id}
                              title="Send balance reminder"
                              style={{ marginTop: '4px' }}
                            >
                              {sendingReminder === customer.id ? '⏳' : '📱 Remind'}
                            </button>
                          )}
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {hasMore && !loading && (
        <div className="load-more-row" style={{ padding: '12px', textAlign: 'center' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => loadCustomers(true, customers.length)}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load more customers'}
          </button>
        </div>
      )}
      {/* Task 3.2 — Loyalty detail panel */}
      {loyaltyCustomerId && loyaltyData[loyaltyCustomerId] && (
        <div className="loyalty-detail-panel" style={{ marginTop: '16px', padding: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '18px' }}>🏅 Loyalty Details</h3>
            <button
              className="btn-small btn-secondary"
              onClick={() => setLoyaltyCustomerId(null)}
              style={{ marginLeft: 'auto' }}
            >
              ✕ Close
            </button>
          </div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div style={{ flex: 1, minWidth: '150px', padding: '12px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Current Points</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{loyaltyData[loyaltyCustomerId].current_points}</div>
            </div>
            <div style={{ flex: 1, minWidth: '150px', padding: '12px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Lifetime Points</div>
              <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{loyaltyData[loyaltyCustomerId].lifetime_points}</div>
            </div>
            <div style={{ flex: 1, minWidth: '150px', padding: '12px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Tier</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className={`badge-tier-${(loyaltyData[loyaltyCustomerId].tier || 'bronze').toLowerCase()}`} style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', textTransform: 'capitalize' }}>
                  {loyaltyData[loyaltyCustomerId].tier || 'bronze'}
                </span>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{loyaltyData[loyaltyCustomerId].points_to_next_tier != null && loyaltyData[loyaltyCustomerId].points_to_next_tier > 0 ? `${loyaltyData[loyaltyCustomerId].points_to_next_tier} pts to next tier` : 'Top tier'}</span>
              </div>
            </div>
          </div>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Recent Transactions</div>
            {(loyaltyTransactions.length > 0 ? (
              <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                    <th style={{ padding: '6px 8px' }}>Date</th>
                    <th style={{ padding: '6px 8px' }}>Type</th>
                    <th style={{ padding: '6px 8px' }}>Points</th>
                    <th style={{ padding: '6px 8px' }}>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {loyaltyTransactions.map((tx) => (
                    <tr key={tx.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '6px 8px' }}>{tx.created_at ? new Date(tx.created_at).toLocaleDateString() : '-'}</td>
                      <td style={{ padding: '6px 8px' }}>{tx.transaction_type}</td>
                      <td style={{ padding: '6px 8px', color: tx.points > 0 ? 'var(--success-color)' : 'var(--danger-color)' }}>{tx.points > 0 ? '+' : ''}{tx.points}</td>
                      <td style={{ padding: '6px 8px' }}>{tx.description || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 0' }}>No loyalty transactions yet.</div>
            ))}
          </div>
          <button
            className="btn-small btn-success"
            onClick={() => openRedeem(loyaltyCustomerId, loyaltyData[loyaltyCustomerId].current_points)}
            disabled={(loyaltyData[loyaltyCustomerId].current_points || 0) < 10 || redeeming === loyaltyCustomerId}
          >
            {redeeming === loyaltyCustomerId ? '⏳ Redeeming…' : '🎟️ Redeem Points'}
          </button>
        </div>
      )}
      {/* Task 3.3 — Redeem points modal */}
      {showRedeemModal && loyaltyCustomerId && (
        <div className="modal-overlay" onClick={() => setShowRedeemModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>🎟️ Redeem Points</h2>
              <button className="modal-close" onClick={() => setShowRedeemModal(false)}>×</button>
            </div>
            <form onSubmit={handleRedeemSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label>Available Points</label>
                  <input
                    type="number"
                    readOnly
                    value={loyaltyData[loyaltyCustomerId]?.current_points ?? 0}
                    className="edit-input"
                  />
                </div>
                <div className="form-group">
                  <label>Points to Redeem *</label>
                  <input
                    type="number"
                    value={redeemPoints}
                    onChange={(e) => setRedeemPoints(e.target.value)}
                    min="10"
                    step="10"
                    required
                    autoFocus
                    className="edit-input"
                  />
                </div>
                <div className="form-group">
                  <label>Discount Value</label>
                  <input
                    type="number"
                    readOnly
                    value={Math.floor(parseInt(redeemPoints || '0', 10) / 10) * 10000}
                    className="edit-input"
                  />
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    10 points = TSh 10,000 discount (multiples of 10)
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowRedeemModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={redeeming === loyaltyCustomerId}>
                  {redeeming === loyaltyCustomerId ? '⏳ Redeeming…' : 'Redeem'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
};

export default Customers;
