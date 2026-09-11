import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  getCustomers,
  createCustomer,
  updateCustomer,
  uploadCustomersExcel,
  checkServerConnection,
  sendBalanceReminder,
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
      </>
      )}
    </div>
  );
};

export default Customers;
