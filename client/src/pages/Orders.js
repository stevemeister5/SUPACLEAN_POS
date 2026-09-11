import React, { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getOrders, getOrderByReceipt, updateOrderStatus, updateEstimatedCollectionDate, uploadStockExcel, updateOrderCustomerPhone, receivePayment, sendCollectionReminder, voidOrderReceipt, requestVoidOrderReceipt, getPendingVoidRequests, archiveOldOrders } from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import { useListViewPreference } from '../hooks/useListViewPreference';
import useHorizontalScrollRegion from '../hooks/useHorizontalScrollRegion';
import ListViewToggle from '../components/ListViewToggle';
import Loader from '../components/Loader';
import ReceiptDetailPanel from '../components/ReceiptDetailPanel';
import { exportToPDF, exportToExcel, exportOrdersPackagingExcel } from '../utils/exportUtils';
import { receiptWidthCss, receiptPadding, receiptFontSize, receiptCompactFontSize, termsQrSize, receiptBrandMargin, receiptBrandFontSize } from '../utils/receiptPrintConfig';
import { formatCustomerReceiptId, formatReceiptForDisplay, formatBranchReceiptLine } from '../utils/receiptId';
import { isMissingCustomerPhone, formatCustomerPhoneDisplay } from '../utils/customerPhone';
import './Orders.css';

const roundMoney = (x) => (typeof x !== 'number' || Number.isNaN(x) ? 0 : Math.round(x * 100) / 100);
const todayYmd = () => new Date().toISOString().slice(0, 10);
const ORDERS_PAGE_SIZE = 50;

const ORDERS_EXPORT_COLUMNS = [
  { key: 'branch_id', label: 'Branch ID' },
  { key: 'receipt_number', label: 'Receipt No' },
  { key: 'customer_name', label: 'Customer' },
  { key: 'customer_phone', label: 'Phone' },
  { key: 'total_amount', label: 'Total Amount' },
  { key: 'paid_amount', label: 'Paid' },
  { key: 'outstanding', label: 'Outstanding' },
  { key: 'payment_status_label', label: 'Payment Status' },
  { key: 'order_date', label: 'Order Date' },
  { key: 'estimated_collection_date', label: 'Est. Collection' },
  { key: 'status', label: 'Status' },
];

const Orders = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { showToast, ToastContainer } = useToast();
  const { branch, selectedBranchId, hasPermission, isAdmin } = useAuth();
  const [listView, setListView] = useListViewPreference();
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editingDate, setEditingDate] = useState(null); // { orderId: number, value: string }
  const [editingPhone, setEditingPhone] = useState(null); // { customerId, receiptNumber, value }
  const [savingPhone, setSavingPhone] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [showReceivePaymentModal, setShowReceivePaymentModal] = useState(false);
  const [selectedOrderForPayment, setSelectedOrderForPayment] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentDate, setPaymentDate] = useState(todayYmd());
  const [receivingPayment, setReceivingPayment] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(null);
  const [expandedReceipts, setExpandedReceipts] = useState(new Set()); // Track which receipts are expanded
  const [receiptDetails, setReceiptDetails] = useState({}); // receipt -> { order, loading, error }
  const [openOverflowMenu, setOpenOverflowMenu] = useState(null);
  const deepLinkHandledRef = useRef(null);
  const [searchFilters, setSearchFilters] = useState({
    customer: '',
    dateFrom: '',
    dateTo: '',
    minAmount: '',
    maxAmount: '',
    paymentStatus: '',
    overdueOnly: false
  });
  const [debouncedSearchFilters, setDebouncedSearchFilters] = useState(searchFilters);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportingUncollected, setExportingUncollected] = useState(false);
  const [voidingReceipt, setVoidingReceipt] = useState(null);
  const [pendingVoidReceipts, setPendingVoidReceipts] = useState(() => new Set());
  const [archivingOldOrders, setArchivingOldOrders] = useState(false);
  const [showExportPopup, setShowExportPopup] = useState(false);
  const ordersSearchInputRef = useRef(null);
  const tableScrollHandlers = useHorizontalScrollRegion();

  // F2: focus order search (customer name or phone) for quick access
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'F2' && !e.target.tagName.match(/INPUT|TEXTAREA|SELECT/)) {
        e.preventDefault();
        ordersSearchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!openOverflowMenu) return undefined;
    const onDocClick = () => setOpenOverflowMenu(null);
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [openOverflowMenu]);

  const loadPendingVoids = useCallback(async () => {
    if (!hasPermission('canManageOrders')) {
      setPendingVoidReceipts(new Set());
      return;
    }
    try {
      const res = await getPendingVoidRequests(
        selectedBranchId ? { branch_id: selectedBranchId } : {}
      );
      const next = new Set(
        (res?.data?.items || [])
          .map((item) => String(item?.payload?.receipt_number || '').trim().toUpperCase())
          .filter(Boolean)
      );
      setPendingVoidReceipts(next);
    } catch (err) {
      console.error('Failed to load pending void requests:', err);
    }
  }, [hasPermission, selectedBranchId]);

  const loadOrders = useCallback(async (append = false, offsetOverride = undefined, filtersOverride = null, filterOverride = null) => {
    const f = filtersOverride ?? debouncedSearchFilters;
    const statusFilter = filterOverride ?? filter;
    const offset = append ? (offsetOverride ?? 0) : 0;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const params = { limit: ORDERS_PAGE_SIZE, offset };
      if (selectedBranchId) params.branch_id = selectedBranchId;
      if (statusFilter !== 'all') params.status = statusFilter;
      if (statusFilter === 'archived') params.archived = 'true';
      if (f.customer) params.customer = f.customer;
      if (f.dateFrom) params.date_from = f.dateFrom;
      if (f.dateTo) params.date_to = f.dateTo;
      if (f.minAmount) params.min_amount = f.minAmount;
      if (f.maxAmount) params.max_amount = f.maxAmount;
      if (f.paymentStatus) params.payment_status = f.paymentStatus;
      if (f.overdueOnly) params.overdue_only = 'true';

      const res = await getOrders(params);
      const data = res.data || [];
      if (append) setOrders(prev => [...prev, ...data]);
      else setOrders(data);
      setHasMore(data.length === ORDERS_PAGE_SIZE);
      if (res.fromCache && res.syncedAt) setLastSyncedAt(res.syncedAt); else setLastSyncedAt(null);
      if (!append) loadPendingVoids();
    } catch (error) {
      console.error('Error loading orders:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Network Error';
      const userFriendlyMsg = errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Network Error') || errorMsg.includes('No response')
        ? 'Cannot connect to server. Please ensure the server is running on port 5000.'
        : errorMsg;
      showToast('Error loading orders: ' + userFriendlyMsg, 'error');
      if (!append) setOrders([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [filter, debouncedSearchFilters, selectedBranchId, showToast, loadPendingVoids]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchFilters(searchFilters), 400);
    return () => clearTimeout(timer);
  }, [searchFilters]);

  useEffect(() => {
    loadOrders(false);
  }, [filter, debouncedSearchFilters, loadOrders]);

  const handleFilterChange = (key, value) => {
    setSearchFilters(prev => ({ ...prev, [key]: value }));
  };

  const handleApplyFilters = () => {
    setDebouncedSearchFilters(searchFilters);
    loadOrders(false, undefined, searchFilters);
  };

  const handleClearFilters = () => {
    const cleared = {
      customer: '',
      dateFrom: '',
      dateTo: '',
      minAmount: '',
      maxAmount: '',
      paymentStatus: '',
      overdueOnly: false
    };
    setSearchFilters(cleared);
    setDebouncedSearchFilters(cleared);
    setFilter('all');
    loadOrders(false, undefined, cleared, 'all');
  };

  const applyStatusLocally = (orderIds, newStatus) => {
    const idSet = new Set((orderIds || []).map((id) => String(id)));
    setOrders((prev) =>
      prev.map((order) =>
        idSet.has(String(order.id))
          ? { ...order, status: newStatus }
          : order
      )
    );
  };

  const handleStatusUpdate = async (orderId, newStatus) => {
    try {
      await updateOrderStatus(orderId, newStatus);
      applyStatusLocally([orderId], newStatus);
      showToast(`Order status updated to ${newStatus}`, 'success');
    } catch (error) {
      const msg = error.response?.data?.error || error.message;
      showToast(msg, 'error');
    }
  };

  const handleReceiptStatusUpdate = async (receiptItems, newStatus) => {
    const items = Array.isArray(receiptItems) ? receiptItems : [];
    const ids = items.map((i) => i?.id).filter(Boolean);
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((id) => updateOrderStatus(id, newStatus)));
      applyStatusLocally(ids, newStatus);
      showToast(`Updated ${ids.length} item(s) to ${newStatus}`, 'success');
    } catch (error) {
      const msg = error.response?.data?.error || error.message;
      showToast(msg, 'error');
    }
  };

  const handleEditEstimatedDate = (orderId, currentDate) => {
    const dateValue = currentDate ? new Date(currentDate).toISOString().slice(0, 16) : '';
    setEditingDate({ orderId, value: dateValue });
  };

  const handleSaveEstimatedDate = async (orderId) => {
    if (!editingDate || !editingDate.orderId) return;
    
    try {
      const dateToSave = editingDate.value ? new Date(editingDate.value).toISOString() : null;
      // If we have a receiptNumber, update all orders in that receipt
      if (editingDate.receiptNumber) {
        // Find all orders with the same receipt number
        const receiptOrders = orders.filter(o => o.receipt_number === editingDate.receiptNumber);
        if (receiptOrders.length > 0) {
          // Update all items in the receipt group
          const updatePromises = receiptOrders.map(item => 
            updateEstimatedCollectionDate(item.id, dateToSave)
          );
          await Promise.all(updatePromises);
          showToast('Estimated collection date updated for all items in receipt', 'success');
        }
      } else {
        // Single order update
        await updateEstimatedCollectionDate(orderId, dateToSave);
        showToast('Estimated collection date updated', 'success');
      }
      setEditingDate(null);
      loadOrders(false);
    } catch (error) {
      showToast('Error updating estimated collection date: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  const handleCancelEdit = () => {
    setEditingDate(null);
  };

  const handleStartEditPhone = (customerId, receiptNumber) => {
    setEditingPhone({ customerId, receiptNumber, value: '' });
  };

  const handleCancelEditPhone = () => {
    setEditingPhone(null);
  };

  const handleSaveCustomerPhone = async () => {
    if (!editingPhone?.customerId) return;
    const trimmed = String(editingPhone.value || '').trim();
    if (!trimmed) {
      showToast('Enter a phone number', 'error');
      return;
    }
    setSavingPhone(true);
    try {
      await updateOrderCustomerPhone(editingPhone.customerId, trimmed);
      setOrders((prev) =>
        prev.map((order) =>
          order.customer_id === editingPhone.customerId
            ? { ...order, customer_phone: trimmed }
            : order
        )
      );
      setEditingPhone(null);
      showToast('Customer phone saved', 'success');
    } catch (error) {
      showToast('Error saving phone: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setSavingPhone(false);
    }
  };

  const renderCustomerPhoneCell = (receiptGroup) => {
    const phoneMissing = isMissingCustomerPhone(receiptGroup.customer_phone);
    const isEditing =
      editingPhone &&
      String(editingPhone.customerId) === String(receiptGroup.customer_id);

    if (isEditing) {
      return (
        <div className="date-edit-controls" style={{ marginTop: '4px' }}>
          <input
            type="tel"
            value={editingPhone.value}
            onChange={(e) => setEditingPhone({ ...editingPhone, value: e.target.value })}
            placeholder="Phone number"
            className="date-edit-input"
            autoFocus
            disabled={savingPhone}
          />
          <div className="date-edit-buttons">
            <button
              type="button"
              className="btn-small btn-success"
              onClick={handleSaveCustomerPhone}
              disabled={savingPhone}
              title="Save phone"
            >
              {savingPhone ? '…' : '✓'}
            </button>
            <button
              type="button"
              className="btn-small btn-secondary"
              onClick={handleCancelEditPhone}
              disabled={savingPhone}
              title="Cancel"
            >
              ×
            </button>
          </div>
        </div>
      );
    }

    if (phoneMissing) {
      return hasPermission('canManageOrders') ? (
        <button
          type="button"
          className="btn-small btn-secondary"
          style={{ marginTop: '4px', fontSize: '11px' }}
          onClick={() => handleStartEditPhone(receiptGroup.customer_id, receiptGroup.receipt_number)}
          title="Add customer phone number"
        >
          + Add phone
        </button>
      ) : (
        <span className="text-muted" style={{ fontSize: '12px' }}>No phone</span>
      );
    }

    return <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)' }}>{receiptGroup.customer_phone}</span>;
  };

  const handleReceivePaymentSubmit = async (e) => {
    e.preventDefault();
    if (!selectedOrderForPayment) return;

    const receiptOrders = orders.filter((o) => o.receipt_number === selectedOrderForPayment.receipt_number);
    const receiptTotal = roundMoney(
      (receiptOrders.length > 0 ? receiptOrders : [selectedOrderForPayment]).reduce(
        (sum, item) => sum + (parseFloat(item.total_amount) || 0),
        0
      )
    );
    const receiptPaid = roundMoney(
      (receiptOrders.length > 0 ? receiptOrders : [selectedOrderForPayment]).reduce(
        (sum, item) => sum + (parseFloat(item.paid_amount) || 0),
        0
      )
    );
    const balanceDue = roundMoney(receiptTotal - receiptPaid);
    const payment = roundMoney(parseFloat(paymentAmount) || 0);
    const tol = 0.01;
    
    if (payment <= 0) {
      showToast('Payment amount must be greater than 0', 'error');
      return;
    }
    if (payment > balanceDue + tol) {
      showToast(`Payment cannot exceed the balance due of TSh ${balanceDue.toLocaleString()}.`, 'error');
      return;
    }

    try {
      setReceivingPayment(true);
      // Backend applies payment at receipt level; send a single request.
      await receivePayment(selectedOrderForPayment.id, {
        payment_amount: payment,
        payment_method: paymentMethod,
        payment_date: paymentDate,
        notes: `Payment received for receipt ${selectedOrderForPayment.receipt_number}`
      });
      
      showToast(`Payment of TSh ${payment.toLocaleString()} received successfully!`, 'success');
      setShowReceivePaymentModal(false);
      setSelectedOrderForPayment(null);
      setPaymentAmount('');
      setPaymentDate(todayYmd());
      loadOrders(false); // Reload orders to show updated payment info
    } catch (err) {
      showToast('Error receiving payment: ' + (err.response?.data?.error || err.message), 'error');
    } finally {
      setReceivingPayment(false);
    }
  };

  const handleStockExcelUpload = async (e) => {
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
      showToast('Uploading and processing stock file...', 'info');
      const res = await uploadStockExcel(formData);
      const { imported = 0, skipped = 0, imported_without_phone: withoutPhone = 0, errors = [], message } = res.data || {};
      const phoneNote =
        withoutPhone > 0 ? ` ${withoutPhone} order(s) have no phone — add numbers on this screen.` : '';
      const baseMsg =
        message ||
        `Imported ${imported} order(s).${skipped > 0 ? ` ${skipped} row(s) skipped.` : ''}${phoneNote}`;
      const hasRowErrors = errors.length > 0;
      showToast(baseMsg, imported > 0 ? (hasRowErrors || skipped > 0 ? 'warning' : 'success') : 'warning');
      if (hasRowErrors) {
        console.warn('Import row errors:', errors);
      }
      if (imported > 0) loadOrders(false);
    } catch (error) {
      const data = error.response?.data;
      if (data?.imported > 0) {
        loadOrders(false);
        showToast(
          data.message || `Imported ${data.imported} order(s), but some rows failed.`,
          'warning'
        );
        if (data.errors?.length) console.warn('Import errors:', data.errors);
      } else {
        showToast('Error uploading file: ' + (data?.error || error.message), 'error');
      }
    } finally {
      // Reset file input
      e.target.value = '';
    }
  };

  const handleSendReminder = async (orderId, channels = ['sms']) => {
    try {
      setSendingReminder(orderId);
      const res = await sendCollectionReminder(orderId, channels);
      if (res.data.result && res.data.result.success) {
        showToast('Reminder sent successfully!', 'success');
      } else {
        showToast(res.data.result?.error || res.data.error || 'Failed to send reminder', 'warning');
      }
    } catch (error) {
      showToast('Error sending reminder: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setSendingReminder(null);
    }
  };

  const handleVoidReceipt = async (receiptGroup, options = {}) => {
    const { acknowledgeReconciledDay = false, voidReason: presetReason = null } = options;
    let reason = presetReason;
    if (!reason) {
      reason = window.prompt(
        isAdmin
          ? 'Reason for voiding this receipt (incorrect entry, duplicate, etc.):'
          : 'Reason for void request (admin must approve before the receipt is voided):',
        'Incorrect receipt logged'
      );
      if (reason == null) return;
      if (!reason.trim()) {
        showToast('A void reason is required', 'error');
        return;
      }
    }
    if (!acknowledgeReconciledDay && !window.confirm(
      isAdmin
        ? `Void receipt ${formatReceiptForDisplay(receiptGroup.receipt_number, receiptGroup.items)}?\n\nThis will reverse all payments and remove it from cash totals. This cannot be undone.`
        : `Send void request for receipt ${formatReceiptForDisplay(receiptGroup.receipt_number, receiptGroup.items)} to admin inbox?\n\nAn admin must approve before payments/cash totals change.`
    )) {
      return;
    }

    setVoidingReceipt(receiptGroup.receipt_number);
    try {
      if (!isAdmin) {
        const res = await requestVoidOrderReceipt(receiptGroup.receipt_number, {
          void_reason: reason.trim(),
          acknowledge_reconciled_day: acknowledgeReconciledDay
        });
        showToast(res?.data?.message || 'Void request sent to admin for approval', 'success');
        setPendingVoidReceipts((prev) => {
          const next = new Set(prev);
          next.add(String(receiptGroup.receipt_number).trim().toUpperCase());
          return next;
        });
        loadOrders(false);
        return;
      }

      const res = await voidOrderReceipt(receiptGroup.receipt_number, {
        void_reason: reason.trim(),
        acknowledge_reconciled_day: acknowledgeReconciledDay
      });
      const days = res?.data?.reconciled_days_refreshed;
      if (Array.isArray(days) && days.length) {
        showToast('Receipt voided; reconciled daily summary was recalculated for the affected date(s).', 'success');
      } else {
        showToast(res?.data?.message || 'Receipt voided successfully', 'success');
      }
      loadOrders(false);
    } catch (error) {
      const status = error.response?.status;
      const msg = error.response?.data?.error || error.message;
      const code = error.response?.data?.code;
      if (status === 409 && code === 'reconciled_day') {
        if (
          !window.confirm(
            'This receipt is on a reconciled day. Voiding will recalculate the locked daily summary and refresh later pending days. Continue?'
          )
        ) {
          return;
        }
        await handleVoidReceipt(receiptGroup, { acknowledgeReconciledDay: true, voidReason: reason.trim() });
        return;
      }
      if (status === 409 && code === 'void_pending') {
        showToast(msg || 'A void request is already pending admin approval', 'info');
        return;
      }
      if (status === 403 && code === 'void_requires_approval') {
        showToast('Void requires admin approval — submit a void request instead.', 'warning');
        return;
      }
      showToast('Error voiding receipt: ' + msg, 'error');
    } finally {
      setVoidingReceipt(null);
    }
  };

  const formatDateTime = (dateString) => {
    if (!dateString) return 'Not set';
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending': return '#f59e0b';
      case 'processing': return '#3b82f6';
      case 'ready': return '#10b981';
      case 'collected': return '#6b7280';
      case 'voided': return '#dc2626';
      case 'archived': return '#64748b';
      default: return '#6b7280';
    }
  };

  const RECEIPT_COMPACT_THRESHOLD = 12;

  // Print receipt for a receipt group (single page; compact format when many items).
  // Uses original order date/time (when customer brought in the order) and original estimated collection, not reprint time.
  const handlePrintReceipt = async (receiptGroup) => {
    try {
      const receiptOrders = receiptGroup.items;
      if (receiptOrders.length === 0) {
        showToast('No items found for this receipt', 'error');
        return;
      }

      // Use original order date/time (first order in the receipt) so reprint matches the original receipt
      const orderDate = receiptOrders[0].order_date ? new Date(receiptOrders[0].order_date) : new Date();
      const dateStr = `${String(orderDate.getDate()).padStart(2, '0')}/${String(orderDate.getMonth() + 1).padStart(2, '0')}/${orderDate.getFullYear()} ${String(orderDate.getHours()).padStart(2, '0')}:${String(orderDate.getMinutes()).padStart(2, '0')}`;
      const estimatedCollectionDate = receiptGroup.estimated_collection_date
        ? (() => {
            const estDate = new Date(receiptGroup.estimated_collection_date);
            return `Est. Collection: ${String(estDate.getDate()).padStart(2, '0')}/${String(estDate.getMonth() + 1).padStart(2, '0')}/${estDate.getFullYear()} ${String(estDate.getHours()).padStart(2, '0')}:${String(estDate.getMinutes()).padStart(2, '0')}\n`;
          })()
        : '';

      const useCompact = receiptOrders.length > RECEIPT_COMPACT_THRESHOLD;
      const totalReceiptItems = receiptOrders.reduce((sum, order) => sum + (parseFloat(order?.quantity) || 1), 0);
      const customerReceiptId = formatCustomerReceiptId(
        receiptGroup.receipt_number,
        totalReceiptItems,
        receiptGroup.branch_code
      );
      const firstOrder = receiptOrders[0];
      const branchLabel =
        firstOrder?.branch_name ||
        (branch?.id === firstOrder?.branch_id ? branch?.name : null) ||
        (firstOrder?.branch_id ? `Branch ID ${firstOrder.branch_id}` : null) ||
        'Arusha';
      const branchLine = formatBranchReceiptLine(receiptGroup);

      const displayPhone = formatCustomerPhoneDisplay(receiptGroup.customer_phone);
      const headerText = useCompact
        ? `SUPACLEAN | ${branchLabel}\nReceipt: ${customerReceiptId} | ${dateStr}\n${estimatedCollectionDate}${receiptGroup.customer_name}${displayPhone !== 'No phone' ? ` | ${displayPhone}` : ''}\n`
        : `
═══════════════════════════════════
   Laundry & Dry Cleaning
   ${branchLabel}, Tanzania
═══════════════════════════════════

Receipt No: ${customerReceiptId}
${branchLine}Date: ${dateStr}
${estimatedCollectionDate}
Customer: ${receiptGroup.customer_name}
${displayPhone !== 'No phone' ? `Phone: ${displayPhone}\n` : ''}───────────────────────────────────
`;
      const brandTitle = useCompact ? null : 'SUPACLEAN';

      const items = [];
      receiptOrders.forEach((order) => {
        const itemName = order.garment_type || order.service_name || 'Item';
        const quantity = order.quantity || 1;
        const color = order.color || '';
        const itemAmount = parseFloat(order.total_amount) || 0;
        let itemDescription = itemName;
        if (color) itemDescription += ` (${color})`;
        items.push({
          qty: String(quantity),
          desc: itemDescription,
          amount: `TSh ${itemAmount.toLocaleString()}`
        });
      });

      const sep = useCompact ? '─'.repeat(32) : '───────────────────────────────────────────';
      let footerText = `${sep}\nTOTAL: TSh ${receiptGroup.total_amount.toLocaleString()}\n`;
      if (receiptGroup.payment_status === 'not_paid') {
        footerText += `NOT PAID\n`;
      } else if (receiptGroup.payment_status === 'paid_full') {
        footerText += `PAID (${(receiptGroup.payment_method || 'cash').toUpperCase()})\n`;
      } else {
        footerText += `ADVANCE | Paid TSh ${receiptGroup.paid_amount.toLocaleString()} | Due TSh ${(receiptGroup.total_amount - receiptGroup.paid_amount).toLocaleString()}\n`;
      }
      footerText += useCompact ? `\nKeep for collection. Thank you!\n` : `\nPlease keep this receipt for collection.\nThank you for choosing SUPACLEAN!\n\n═══════════════════════════════════\n`;

      await printReceiptText({ headerText, items, footerText, brandTitle });
    } catch (error) {
      console.error('Error generating receipt:', error);
      showToast('Error generating receipt: ' + (error.message || 'Unknown error'), 'error');
    }
  };

  // Print receipt text (single page; no black page; Terms QR at end).
  // Accepts either receiptText (string) or { headerText, items, footerText, brandTitle } for centered layout with table (desc wraps, amount visible).
  const printReceiptText = async (receiptTextOrData) => {
    const isStructured = receiptTextOrData && typeof receiptTextOrData === 'object' && Array.isArray(receiptTextOrData.items);
    const receiptText = isStructured ? null : (receiptTextOrData && typeof receiptTextOrData === 'string' ? receiptTextOrData : '');
    if (!isStructured && (!receiptText || !receiptText.trim())) {
      showToast('Error: Invalid receipt data', 'error');
      return;
    }
    const compact = isStructured ? receiptTextOrData.items.length > 12 : (receiptText.match(/\n/g) || []).length > 35;
    // Use public origin for Terms QR so it works when scanned from a phone (not localhost)
    const baseUrl = (typeof process !== 'undefined' && process.env && process.env.REACT_APP_PUBLIC_ORIGIN)
      ? process.env.REACT_APP_PUBLIC_ORIGIN.replace(/\/$/, '')
      : (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
    const termsUrl = baseUrl ? `${baseUrl}/terms` : '';
    const skipQr = typeof process !== 'undefined' && process.env && process.env.REACT_APP_RECEIPT_SKIP_QR === 'true';
    const termsQrSrc = !skipQr && termsUrl ? `https://api.qrserver.com/v1/create-qr-code/?size=${termsQrSize}x${termsQrSize}&data=${encodeURIComponent(termsUrl)}` : '';
    let termsQrDataUrl = '';
    if (termsQrSrc) {
      const qrTimeoutMs = 3000;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), qrTimeoutMs);
        const res = await fetch(termsQrSrc, { signal: controller.signal });
        clearTimeout(timeoutId);
        const blob = await res.blob();
        termsQrDataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(blob);
        });
      } catch (e) {
        if (e?.name !== 'AbortError') console.warn('Terms QR fetch failed', e);
      }
    }
    const termsQrBlock = termsQrDataUrl
      ? `<div class="receipt-end"><img src="${termsQrDataUrl}" alt="Terms" width="${termsQrSize}" height="${termsQrSize}" /><p>Scan for Terms / Masharti</p></div>`
      : '';
    const escape = (s) =>
      String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    const itemsTableRows = isStructured
      ? receiptTextOrData.items.map((r) => `<tr><td class="r-qty">${escape(r.qty)}</td><td class="r-desc">${escape(r.desc)}</td><td class="r-amount">${escape(r.amount)}</td></tr>`).join('')
      : '';
    const brandBlock = (isStructured && receiptTextOrData.brandTitle)
      ? `<div class="receipt-brand">${escape(receiptTextOrData.brandTitle)}</div>`
      : '';
    const bodyContent = isStructured
      ? `${brandBlock}<pre class="receipt-header">${escape(receiptTextOrData.headerText)}</pre>
              <table class="receipt-items"><thead><tr><th class="r-qty">Qty</th><th class="r-desc">Item</th><th class="r-amount">TSh</th></tr></thead><tbody>${itemsTableRows}</tbody></table>
              <pre class="receipt-footer">${escape(receiptTextOrData.footerText)}</pre>`
      : `<pre>${escape(receiptText)}</pre>`;
    const printHTML = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Receipt - SUPACLEAN</title>
            <meta charset="UTF-8">
            <style>
              @media print {
                @page { size: ${receiptWidthCss} auto; margin: 0; }
                html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; color: #000 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                .receipt-sheet { width: ${receiptWidthCss}; max-width: ${receiptWidthCss}; height: auto !important; min-height: 0 !important; overflow: visible !important; color: #000 !important; }
                body { font-family: 'Courier New', monospace; padding: ${receiptPadding}; margin: 0; background: white; width: ${receiptWidthCss}; max-width: ${receiptWidthCss}; font-size: ${receiptFontSize}; }
                pre, .receipt-items th, .receipt-items td { color: #000 !important; font-weight: 600; }
                .receipt-items .r-desc { color: #000 !important; font-weight: 600; }
                .receipt-footer { font-weight: bold; color: #000 !important; }
                .receipt-end p { font-weight: bold; color: #000 !important; }
                pre { margin: 0; padding: 0; white-space: pre; overflow: visible; }
                body.receipt-compact pre, body.receipt-compact .receipt-items { font-size: 8pt; }
                .receipt-end { margin-top: 6px; page-break-inside: avoid; }
                * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              }
              @media screen { body { font-family: 'Courier New', monospace; padding: 20px; max-width: ${receiptWidthCss}; margin: 0 auto; background: #f5f5f5; } }
              .receipt-sheet { text-align: center; margin: 0 auto; max-width: ${receiptWidthCss}; }
              .receipt-brand { font-weight: bold; text-align: center; margin: ${receiptBrandMargin}; font-size: ${receiptBrandFontSize}; color: #000; }
              body:not(.receipt-compact) pre, body:not(.receipt-compact) .receipt-items { font-size: ${receiptFontSize}; line-height: 1.15; }
              body.receipt-compact pre, body.receipt-compact .receipt-items { font-size: ${receiptCompactFontSize}; line-height: 1.05; }
              pre { margin: 0; color: black; white-space: pre; }
              .receipt-header, .receipt-footer { text-align: center; }
              .receipt-items { width: 100%; margin: 4px 0; border-collapse: collapse; text-align: center; }
              .receipt-items th, .receipt-items td { padding: 2px 4px; border: none; }
              .receipt-items .r-qty { width: 2.5em; text-align: center; }
              .receipt-items .r-desc { text-align: left; word-wrap: break-word; word-break: break-word; max-width: 1px; color: #000 !important; font-weight: 600; }
              .receipt-items .r-amount { width: 4.5em; text-align: right; white-space: nowrap; }
              .receipt-footer { font-weight: bold; }
              .receipt-end { text-align: center; margin-top: 8px; }
              .receipt-end p { margin: 4px 0 0 0; font-size: 8pt; color: #000; font-weight: bold; }
            </style>
          </head>
          <body class="${compact ? 'receipt-compact' : ''}">
            <div class="receipt-sheet">
              ${bodyContent}
              ${termsQrBlock}
            </div>
            <script>
              function doPrint() { try { window.focus(); window.print(); } catch (e) {} }
              window.onafterprint = function() { setTimeout(function() { try { window.close(); } catch (e) {} }, 500); };
              (function(){
                var run = false;
                function maybePrint() { if (!run) { run = true; setTimeout(doPrint, 350); } }
                var sheet = document.querySelector('.receipt-sheet');
                var img = sheet ? sheet.querySelector('img') : null;
                if (img && !img.complete) {
                  img.onload = maybePrint;
                  img.onerror = maybePrint;
                  setTimeout(maybePrint, 1200);
                } else {
                  if (document.readyState === 'complete') maybePrint();
                  else window.onload = function() { setTimeout(maybePrint, 400); };
                  setTimeout(maybePrint, 1000);
                }
              })();
            </script>
          </body>
        </html>
      `;

    try {
      const isPDA = typeof window !== 'undefined' && window.innerWidth <= 768;
      const printWindow = !isPDA ? window.open('', '_blank', 'width=400,height=600,scrollbars=yes') : null;
      if (printWindow && !printWindow.closed) {
        printWindow.document.open();
        printWindow.document.write(printHTML);
        printWindow.document.close();
        showToast('Receipt opened. Select your thermal printer.', 'success');
      } else {
        // PDA / popup blocked: use iframe so we print only receipt content, never the main page
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;border:none;visibility:hidden';
        document.body.appendChild(iframe);
        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(printHTML);
        doc.close();
        const cleanup = () => {
          try { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch (e) {}
        };
        iframe.contentWindow.onload = () => {
          setTimeout(() => {
            try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) {}
            setTimeout(cleanup, 1500);
          }, 400);
        };
        setTimeout(cleanup, 3000);
        showToast('Print dialog opened. Choose your thermal printer.', 'info');
      }
    } catch (error) {
      console.error('Error printing receipt:', error);
      showToast('Error printing receipt: ' + (error?.message || 'Unknown error'), 'error');
    }
  };

  // Group orders by receipt number
  const groupOrdersByReceipt = (ordersList) => {
    const grouped = {};
    ordersList.forEach(order => {
      const receiptNum = order.receipt_number;
      if (!grouped[receiptNum]) {
        grouped[receiptNum] = {
          receipt_number: receiptNum,
          customer_id: order.customer_id,
          customer_name: order.customer_name,
          customer_phone: order.customer_phone,
          branch_id: order.branch_id,
          branch_name: order.branch_name,
          branch_code: order.branch_code,
          order_date: order.order_date,
          estimated_collection_date: order.estimated_collection_date,
          items: [],
          total_amount: 0,
          paid_amount: 0,
          payment_status: order.payment_status,
          payment_method: order.payment_method,
          status: order.status, // Use the most common status or 'pending' if mixed
          order_ids: []
        };
      }
      grouped[receiptNum].items.push(order);
      grouped[receiptNum].total_amount += parseFloat(order.total_amount) || 0;
      grouped[receiptNum].paid_amount += parseFloat(order.paid_amount) || 0;
      grouped[receiptNum].order_ids.push(order.id);
      if (order.is_voided) {
        grouped[receiptNum].is_voided = true;
      }
      if (order.archived_at) {
        grouped[receiptNum].is_archived = true;
        grouped[receiptNum].archived_at = order.archived_at;
      }

      // Determine overall status (if all ready, show ready; if any pending, show pending; etc.)
      const statuses = grouped[receiptNum].items.map(o => o.status);
      if (grouped[receiptNum].is_archived) {
        grouped[receiptNum].status = 'archived';
      } else if (grouped[receiptNum].is_voided || statuses.every(s => s === 'voided')) {
        grouped[receiptNum].status = 'voided';
      } else if (statuses.every(s => s === 'ready')) {
        grouped[receiptNum].status = 'ready';
      } else if (statuses.some(s => s === 'pending')) {
        grouped[receiptNum].status = 'pending';
      } else if (statuses.some(s => s === 'processing')) {
        grouped[receiptNum].status = 'processing';
      } else if (statuses.every(s => s === 'collected')) {
        grouped[receiptNum].status = 'collected';
      }
    });
    return Object.values(grouped);
  };

  const loadReceiptDetail = useCallback(async (receiptNumber, fallbackItems = []) => {
    setReceiptDetails((prev) => ({
      ...prev,
      [receiptNumber]: { ...(prev[receiptNumber] || {}), loading: true, error: null },
    }));
    try {
      const res = await getOrderByReceipt(receiptNumber);
      const order = res?.data || null;
      setReceiptDetails((prev) => ({
        ...prev,
        [receiptNumber]: { order, loading: false, error: order ? null : 'Order not found' },
      }));
    } catch (err) {
      // Fall back to list items so managers still see a maximized panel
      const first = fallbackItems[0] || null;
      const fallbackOrder = first
        ? {
            ...first,
            total_amount: fallbackItems.reduce((s, i) => s + (parseFloat(i.total_amount) || 0), 0),
            paid_amount: fallbackItems.reduce((s, i) => s + (parseFloat(i.paid_amount) || 0), 0),
            all_items: fallbackItems,
          }
        : null;
      setReceiptDetails((prev) => ({
        ...prev,
        [receiptNumber]: {
          order: fallbackOrder,
          loading: false,
          error: fallbackOrder ? null : (err.response?.data?.error || err.message || 'Failed to load details'),
        },
      }));
    }
  }, []);

  // Deep link: /orders?receipt=XXX maximizes that receipt on this page (no Collection redirect)
  useEffect(() => {
    const receiptParam = searchParams.get('receipt');
    if (!receiptParam || !receiptParam.trim()) return;
    const rn = receiptParam.trim();
    if (deepLinkHandledRef.current === rn) return;
    deepLinkHandledRef.current = rn;
    setExpandedReceipts(new Set([rn]));
    loadReceiptDetail(rn, []);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('receipt');
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams, loadReceiptDetail]);

  const toggleReceiptExpansion = (receiptNumber, fallbackItems = []) => {
    const newExpanded = new Set(expandedReceipts);
    if (newExpanded.has(receiptNumber)) {
      newExpanded.delete(receiptNumber);
      setOpenOverflowMenu(null);
    } else {
      newExpanded.add(receiptNumber);
      if (!receiptDetails[receiptNumber]?.order) {
        loadReceiptDetail(receiptNumber, fallbackItems);
      }
    }
    setExpandedReceipts(newExpanded);
  };

  const openPaymentForReceipt = (receiptGroup) => {
    const balance = receiptGroup.total_amount - receiptGroup.paid_amount;
    setSelectedOrderForPayment({
      ...receiptGroup.items[0],
      total_amount: receiptGroup.total_amount,
      paid_amount: receiptGroup.paid_amount,
    });
    setPaymentAmount(balance.toString());
    setPaymentDate(todayYmd());
    setShowReceivePaymentModal(true);
    setOpenOverflowMenu(null);
  };

  const renderReceiptActions = (receiptGroup, { compact = false } = {}) => {
    const balance = receiptGroup.total_amount - receiptGroup.paid_amount;
    const isExpanded = expandedReceipts.has(receiptGroup.receipt_number);
    const menuOpen = openOverflowMenu === receiptGroup.receipt_number;
    const archivedOrVoided = receiptGroup.is_archived || receiptGroup.is_voided;
    const voidPending = pendingVoidReceipts.has(
      String(receiptGroup.receipt_number || '').trim().toUpperCase()
    );
    let primary = null;
    if (!archivedOrVoided && !voidPending && (receiptGroup.status === 'pending' || receiptGroup.status === 'processing')) {
      primary = (
        <button
          type="button"
          className="dk-btn dk-btn--success dk-btn--sm"
          onClick={() => handleReceiptStatusUpdate(receiptGroup.items, 'ready')}
        >
          Mark Ready
        </button>
      );
    } else if (!archivedOrVoided && !voidPending && receiptGroup.status === 'ready') {
      primary = (
        <button
          type="button"
          className="dk-btn dk-btn--primary dk-btn--sm"
          onClick={() => handleReceiptStatusUpdate(receiptGroup.items, 'collected')}
          disabled={balance > 0}
          title={balance > 0 ? 'Pay balance first' : 'Collect'}
        >
          Collect
        </button>
      );
    } else if (!archivedOrVoided && !voidPending && balance > 0) {
      primary = (
        <button
          type="button"
          className="dk-btn dk-btn--primary dk-btn--sm"
          onClick={() => openPaymentForReceipt(receiptGroup)}
        >
          Pay
        </button>
      );
    } else if (!archivedOrVoided && voidPending) {
      primary = (
        <span
          className="status-badge"
          style={{ backgroundColor: '#c2410c', color: '#fff' }}
          title="Awaiting admin approval"
        >
          Void pending
        </span>
      );
    }

    return (
      <div className="orders-actions-v2">
        {primary}
        {!archivedOrVoided && !voidPending && balance > 0 && receiptGroup.status === 'ready' && (
          <button
            type="button"
            className="dk-btn dk-btn--secondary dk-btn--sm"
            onClick={() => openPaymentForReceipt(receiptGroup)}
          >
            Pay
          </button>
        )}
        <button
          type="button"
          className={`dk-btn dk-btn--${isExpanded ? 'primary' : 'secondary'} dk-btn--sm`}
          onClick={() => toggleReceiptExpansion(receiptGroup.receipt_number, receiptGroup.items)}
          aria-expanded={isExpanded}
        >
          {isExpanded ? 'Minimize' : 'Details'}
        </button>
        <div className="orders-actions-v2__overflow">
          <button
            type="button"
            className="dk-btn dk-btn--secondary dk-btn--sm"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setOpenOverflowMenu(menuOpen ? null : receiptGroup.receipt_number);
            }}
          >
            More
          </button>
          {menuOpen && (
            <div className="orders-actions-v2__menu" role="menu" onClick={(e) => e.stopPropagation()}>
              {!archivedOrVoided && receiptGroup.status === 'ready' && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={sendingReminder !== null || isMissingCustomerPhone(receiptGroup.customer_phone)}
                  title={
                    isMissingCustomerPhone(receiptGroup.customer_phone)
                      ? 'Add a customer phone number first'
                      : 'Send collection reminder'
                  }
                  onClick={() => {
                    receiptGroup.items.forEach((item) => handleSendReminder(item.id));
                    setOpenOverflowMenu(null);
                  }}
                >
                  {sendingReminder ? 'Sending…' : 'Remind'}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  handlePrintReceipt(receiptGroup);
                  setOpenOverflowMenu(null);
                }}
              >
                Reprint
              </button>
              {hasPermission('canManageOrders') && !archivedOrVoided && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={
                    voidingReceipt === receiptGroup.receipt_number
                    || pendingVoidReceipts.has(String(receiptGroup.receipt_number || '').trim().toUpperCase())
                  }
                  onClick={() => {
                    handleVoidReceipt(receiptGroup);
                    setOpenOverflowMenu(null);
                  }}
                >
                  {voidingReceipt === receiptGroup.receipt_number
                    ? (isAdmin ? 'Voiding…' : 'Sending…')
                    : pendingVoidReceipts.has(String(receiptGroup.receipt_number || '').trim().toUpperCase())
                      ? 'Void pending'
                      : (isAdmin ? 'Void' : 'Request void')}
                </button>
              )}
            </div>
          )}
        </div>
        {compact ? null : null}
      </div>
    );
  };

  const renderExpandedDetail = (receiptGroup) => {
    const detail = receiptDetails[receiptGroup.receipt_number] || {};
    return (
      <ReceiptDetailPanel
        order={detail.order}
        items={receiptGroup.items}
        loading={!!detail.loading}
        error={detail.error}
        onClose={() => toggleReceiptExpansion(receiptGroup.receipt_number, receiptGroup.items)}
        actions={
          !receiptGroup.is_archived && !receiptGroup.is_voided ? (
            <>
              {(receiptGroup.status === 'pending' || receiptGroup.status === 'processing') && (
                <button
                  type="button"
                  className="dk-btn dk-btn--success dk-btn--sm"
                  onClick={() => handleReceiptStatusUpdate(receiptGroup.items, 'ready')}
                >
                  Mark Ready
                </button>
              )}
              {receiptGroup.status === 'ready' && (
                <button
                  type="button"
                  className="dk-btn dk-btn--primary dk-btn--sm"
                  onClick={() => handleReceiptStatusUpdate(receiptGroup.items, 'collected')}
                  disabled={receiptGroup.total_amount - receiptGroup.paid_amount > 0}
                >
                  Collect
                </button>
              )}
              {receiptGroup.total_amount - receiptGroup.paid_amount > 0 && (
                <button
                  type="button"
                  className="dk-btn dk-btn--secondary dk-btn--sm"
                  onClick={() => openPaymentForReceipt(receiptGroup)}
                >
                  Receive Payment
                </button>
              )}
              <button
                type="button"
                className="dk-btn dk-btn--secondary dk-btn--sm"
                onClick={() => handlePrintReceipt(receiptGroup)}
              >
                Reprint
              </button>
            </>
          ) : null
        }
      />
    );
  };

  const paymentStatusLabel = (ps) => {
    if (ps === 'paid_full') return 'Paid';
    if (ps === 'advance') return 'Advance';
    return 'Unpaid';
  };

  const buildPackagingExportRows = (receiptGroups) => {
    return receiptGroups.map((g) => {
      const items = g.items || [];
      const lineCount = items.length;
      const balance = roundMoney((g.total_amount || 0) - (g.paid_amount || 0));
      const paid = roundMoney(g.paid_amount || 0);
      const total = roundMoney(g.total_amount || 0);

      const itemLines = items.map((item) => {
        const name = item.garment_type || item.service_name || 'Item';
        const qty = Number(item.quantity) || 1;
        let line = `${name} x${qty}`;
        if (item.color) line += ` (${item.color})`;
        return line;
      });

      const itemsCell = [
        `${lineCount} ${lineCount === 1 ? 'item' : 'items'}`,
        ...itemLines,
      ].join('\n');

      const paymentStatusLabel = g.payment_status === 'not_paid'
        ? 'Not Paid'
        : g.payment_status === 'advance'
          ? 'Advance'
          : 'Paid Full';

      const paymentCell = [
        `Paid: TSh ${paid.toLocaleString()}`,
        balance > 0 ? `Balance: TSh ${balance.toLocaleString()}` : 'Paid Full',
        paymentStatusLabel,
      ].join('\n');

      const estCollection = g.estimated_collection_date
        ? new Date(g.estimated_collection_date).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
        : 'Not set';

      return {
        branch_name: g.branch_name || g.branch_code || '',
        receipt_no: formatReceiptForDisplay(g.receipt_number, items, g.branch_code),
        customer: [g.customer_name || '', formatCustomerPhoneDisplay(g.customer_phone)]
          .filter(Boolean)
          .join('\n'),
        items: itemsCell,
        total_amount: `TSh ${total.toLocaleString()}`,
        payment: paymentCell,
        order_date: g.order_date ? new Date(g.order_date).toLocaleDateString() : '',
        est_collection: estCollection,
      };
    });
  };

  const buildOrderExportRows = (ordersList) => {
    const grouped = groupOrdersByReceipt(ordersList);
    return grouped.map(g => {
      const outstanding = roundMoney((g.total_amount || 0) - (g.paid_amount || 0));
      const first = g.items && g.items[0];
      return {
        branch_id: first?.branch_id ?? '',
        branch_name: first?.branch_name ?? '',
        receipt_number: g.receipt_number ?? '',
        customer_name: g.customer_name ?? '',
        customer_phone: formatCustomerPhoneDisplay(g.customer_phone),
        total_amount: roundMoney(g.total_amount || 0),
        paid_amount: roundMoney(g.paid_amount || 0),
        outstanding,
        payment_status_label: paymentStatusLabel(g.payment_status),
        order_date: g.order_date ? new Date(g.order_date).toLocaleDateString() : '',
        estimated_collection_date: g.estimated_collection_date ? new Date(g.estimated_collection_date).toLocaleString() : '',
        status: g.status ?? '',
      };
    });
  };

  const handleExportOrders = async (format) => {
    setExporting(true);
    try {
      const params = { limit: 500, offset: 0 };
      if (selectedBranchId) params.branch_id = selectedBranchId;
      if (filter !== 'all') params.status = filter;
      Object.assign(params, {
        date_from: debouncedSearchFilters.dateFrom || undefined,
        date_to: debouncedSearchFilters.dateTo || undefined,
        min_amount: debouncedSearchFilters.minAmount || undefined,
        max_amount: debouncedSearchFilters.maxAmount || undefined,
        payment_status: debouncedSearchFilters.paymentStatus || undefined,
        overdue_only: debouncedSearchFilters.overdueOnly ? 'true' : undefined,
        customer: debouncedSearchFilters.customer || undefined,
      });
      const res = await getOrders(params);
      const data = res.data || [];
      if (data.length === 0) {
        showToast('No orders to export', 'info');
        return;
      }
      const title = `Orders_${filter}_${new Date().toISOString().slice(0, 10)}`;
      const exportBranch = { branchName: branch?.name, branchId: branch?.id ?? selectedBranchId };
      if (format === 'pdf') {
        const rows = buildOrderExportRows(data);
        await exportToPDF(title, ORDERS_EXPORT_COLUMNS, rows, exportBranch);
        showToast(`Exported ${rows.length} receipt(s) as PDF`, 'success');
      } else if (format === 'excel-summary') {
        const rows = buildOrderExportRows(data);
        await exportToExcel(title, ORDERS_EXPORT_COLUMNS, rows, exportBranch);
        showToast(`Exported ${rows.length} receipt(s) as Excel`, 'success');
      } else if (format === 'excel-detail') {
        const groups = groupOrdersByReceipt(data);
        const packagingRows = buildPackagingExportRows(groups);
        await exportOrdersPackagingExcel(packagingRows, exportBranch, title);
        showToast(`Exported ${packagingRows.length} receipt(s) for packaging managers`, 'success');
      }
      setShowExportPopup(false);
    } catch (error) {
      showToast('Export failed: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleArchiveOldOrders = async () => {
    const monthsText = window.prompt('Archive collected/voided receipts older than how many months?', '7');
    if (monthsText == null) return;
    const months = Number(monthsText);
    if (!Number.isFinite(months) || months < 1) {
      showToast('Enter a valid number of months.', 'error');
      return;
    }

    setArchivingOldOrders(true);
    try {
      const preview = await archiveOldOrders({ months, dry_run: true });
      const receipts = Number(preview?.data?.receipts_matched || 0);
      const items = Number(preview?.data?.items_matched || 0);
      if (receipts === 0) {
        showToast(`No completed receipts older than ${months} month(s) to archive.`, 'info');
        return;
      }
      if (!window.confirm(
        `Archive ${receipts.toLocaleString()} receipt(s) / ${items.toLocaleString()} item(s) older than ${months} month(s)?\n\nThey will leave active Orders, Dashboard and Collection views, but remain searchable in Archived.`
      )) {
        return;
      }
      const res = await archiveOldOrders({
        months,
        archive_reason: `Admin archived completed receipts older than ${months} months`
      });
      showToast(res?.data?.message || 'Old completed receipts archived', 'success');
      loadOrders(false);
    } catch (error) {
      showToast('Archive failed: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setArchivingOldOrders(false);
    }
  };

  const handleExportUncollectedStock = async (format) => {
    setExportingUncollected(true);
    try {
      const params = { status: 'ready', overdue_only: 'true', limit: 500 };
      if (selectedBranchId) params.branch_id = selectedBranchId;
      const res = await getOrders(params);
      const data = res.data || [];
      if (data.length === 0) {
        showToast('No uncollected (overdue) stock to export', 'info');
        return;
      }
      const title = 'Uncollected_Stock_' + new Date().toISOString().slice(0, 10);
      const exportBranch = { branchName: branch?.name, branchId: branch?.id ?? selectedBranchId };
      if (format === 'pdf') {
        const rows = buildOrderExportRows(data);
        await exportToPDF(title, ORDERS_EXPORT_COLUMNS, rows, exportBranch);
        showToast(`Exported ${rows.length} uncollected receipt(s) as PDF`, 'success');
      } else if (format === 'excel-summary') {
        const rows = buildOrderExportRows(data);
        await exportToExcel(title, ORDERS_EXPORT_COLUMNS, rows, exportBranch);
        showToast(`Exported ${rows.length} uncollected receipt(s) as Excel`, 'success');
      } else if (format === 'excel-detail') {
        const groups = groupOrdersByReceipt(data);
        const packagingRows = buildPackagingExportRows(groups);
        await exportOrdersPackagingExcel(packagingRows, exportBranch, title);
        showToast(`Exported ${packagingRows.length} receipt(s) for packaging managers`, 'success');
      }
      setShowExportPopup(false);
    } catch (error) {
      showToast('Export failed: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setExportingUncollected(false);
    }
  };

  // Get consolidated orders
  const consolidatedOrders = groupOrdersByReceipt(orders);
  const listReceiptNumbers = new Set(consolidatedOrders.map((g) => g.receipt_number));
  const orphanExpandedReceipts = [...expandedReceipts].filter((rn) => !listReceiptNumbers.has(rn));
  const canManageOrders = hasPermission('canManageOrders');

  return (
    <div className="orders-page">
      <ToastContainer />
      {showExportPopup && (
        <div className="export-popup-overlay" onClick={() => setShowExportPopup(false)} role="dialog" aria-label="Export options">
          <div className="export-popup" onClick={e => e.stopPropagation()}>
            <div className="export-popup-header">
              <h3>Export</h3>
              <button type="button" className="export-popup-close" onClick={() => setShowExportPopup(false)} aria-label="Close">×</button>
            </div>
            <div className="export-popup-section">
              <p className="export-popup-label">Current orders (this tab &amp; filters)</p>
              <div className="export-popup-actions">
                <button className="btn-primary" onClick={() => handleExportOrders('pdf')} disabled={exporting}>PDF</button>
                <button className="btn-primary" onClick={() => handleExportOrders('excel-summary')} disabled={exporting}>Excel</button>
                <button
                  className="btn-primary"
                  style={{ background: '#0f5132', minWidth: 130 }}
                  onClick={() => handleExportOrders('excel-detail')}
                  disabled={exporting}
                  title="Excel matching the Orders table: receipt, customer, full item list with qty and color, payment, and collection date. For packaging managers."
                >
                  {exporting ? 'Exporting…' : 'Excel — Packaging'}
                </button>
              </div>
            </div>
            <div className="export-popup-section">
              <p className="export-popup-label">Uncollected stock (overdue, not collected)</p>
              <div className="export-popup-actions">
                <button className="btn-primary" onClick={() => handleExportUncollectedStock('pdf')} disabled={exportingUncollected}>PDF</button>
                <button className="btn-primary" onClick={() => handleExportUncollectedStock('excel-summary')} disabled={exportingUncollected}>Excel</button>
                <button
                  className="btn-primary"
                  style={{ background: '#0f5132', minWidth: 130 }}
                  onClick={() => handleExportUncollectedStock('excel-detail')}
                  disabled={exportingUncollected}
                  title="Excel matching the Orders table for overdue uncollected stock. For packaging managers."
                >
                  {exportingUncollected ? 'Exporting…' : 'Excel — Packaging'}
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
      <div className="page-header-modern">
        <div>
          <h1>Orders</h1>
          <p className="subtitle">
            {filter === 'archived'
              ? 'Viewing archived receipts kept for history and audit'
              : 'View and manage all active orders'}
          </p>
        </div>
        <div className="header-actions">
          {isAdmin && (
            <button
              type="button"
              className="dk-btn dk-btn--secondary dk-btn--md"
              onClick={handleArchiveOldOrders}
              disabled={archivingOldOrders}
              title="Soft-archive old collected/voided receipts so active screens stay fast"
            >
              {archivingOldOrders ? 'Archiving…' : 'Archive Old'}
            </button>
          )}
          <button
            type="button"
            className="dk-btn dk-btn--secondary dk-btn--md"
            style={{ marginRight: '8px' }}
            onClick={() => setShowExportPopup(true)}
            disabled={exporting || exportingUncollected}
            title="Export orders or uncollected stock"
          >
            {(exporting || exportingUncollected) ? '…' : 'Export'}
          </button>
          <label className="dk-btn dk-btn--secondary dk-btn--md" style={{ cursor: 'pointer' }} title="CUST ID / receipt encodes the receipt day. Phone is optional — add missing numbers later on this screen. Paid = already paid when receipt was printed; items stay Ready until collected.">
            📦 Upload Stock Excel
            <input
              type="file"
              accept=".xlsx,.csv"
              style={{ display: 'none' }}
              onChange={handleStockExcelUpload}
            />
          </label>
        </div>
      </div>

      <div className="orders-filters-section">
        <div className="orders-quick-search">
          <label className="orders-search-label" htmlFor="orders-quick-search-input">
            <span className="orders-search-icon">🔍</span>
            Search
          </label>
          <input
            ref={ordersSearchInputRef}
            id="orders-quick-search-input"
            type="text"
            className="orders-quick-search-input"
            placeholder="Customer name or phone..."
            value={searchFilters.customer}
            onChange={(e) => handleFilterChange('customer', e.target.value)}
            aria-label="Search orders by customer name or phone"
            title="Search orders by customer (F2)"
          />
          {searchFilters.customer && (
            <button
              type="button"
              className="orders-search-clear"
              onClick={() => handleFilterChange('customer', '')}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        <div className="orders-filters">
          {['all', 'pending', 'ready', 'collected', 'voided', 'archived'].map(status => (
              <button
              key={status}
              className={`filter-btn ${filter === status ? 'active' : ''}`}
              onClick={() => setFilter(status)}
            >
              {status === 'pending' ? 'Pending Orders' : status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
          <button
            className="filter-btn btn-secondary"
            onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
          >
            {showAdvancedFilters ? '🔽 Hide Filters' : '🔍 Advanced Filters'}
          </button>
          <ListViewToggle view={listView} setView={setListView} />
        </div>

        {showAdvancedFilters && (
          <div className="advanced-filters-card">
            <div className="filters-grid">
              <div className="filter-group">
                <label>Customer (Name/Phone)</label>
                <input
                  type="text"
                  placeholder="Search customer..."
                  value={searchFilters.customer}
                  onChange={(e) => handleFilterChange('customer', e.target.value)}
                />
              </div>
              
              <div className="filter-group">
                <label>Date From</label>
                <input
                  type="date"
                  value={searchFilters.dateFrom}
                  onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
                />
              </div>
              
              <div className="filter-group">
                <label>Date To</label>
                <input
                  type="date"
                  value={searchFilters.dateTo}
                  onChange={(e) => handleFilterChange('dateTo', e.target.value)}
                />
              </div>
              
              <div className="filter-group">
                <label>Min Amount (TSh)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="0"
                  value={searchFilters.minAmount}
                  onChange={(e) => handleFilterChange('minAmount', e.target.value)}
                  min="0"
                />
              </div>
              
              <div className="filter-group">
                <label>Max Amount (TSh)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="Any"
                  value={searchFilters.maxAmount}
                  onChange={(e) => handleFilterChange('maxAmount', e.target.value)}
                  min="0"
                />
              </div>
              
              <div className="filter-group">
                <label>Payment Status</label>
                <select
                  value={searchFilters.paymentStatus}
                  onChange={(e) => handleFilterChange('paymentStatus', e.target.value)}
                >
                  <option value="">All</option>
                  <option value="not_paid">Not Paid</option>
                  <option value="advance">Advance Payment</option>
                  <option value="paid_full">Paid Full</option>
                </select>
              </div>
            </div>
            
            <div className="filter-options">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={searchFilters.overdueOnly}
                  onChange={(e) => handleFilterChange('overdueOnly', e.target.checked)}
                />
                <span>Show only overdue orders</span>
              </label>
            </div>
            
            <div className="filter-actions">
              <button className="btn-primary" onClick={handleApplyFilters}>
                🔍 Apply Filters
              </button>
              <button className="btn-secondary" onClick={handleClearFilters}>
                ✕ Clear All
              </button>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <Loader message="Loading orders…" fullPage />
      ) : (
        <>
      {orphanExpandedReceipts.map((rn) => {
        const detail = receiptDetails[rn] || {};
        return (
          <div key={`orphan-${rn}`} className="orders-orphan-detail" style={{ marginBottom: 16 }}>
            <ReceiptDetailPanel
              order={detail.order}
              loading={!!detail.loading}
              error={detail.error}
              onClose={() => toggleReceiptExpansion(rn, [])}
              actions={
                detail.order && !detail.order.is_voided ? (
                  <button
                    type="button"
                    className="dk-btn dk-btn--secondary dk-btn--sm"
                    onClick={() => handlePrintReceipt({
                      receipt_number: rn,
                      items: detail.order.all_items || [detail.order],
                      total_amount: detail.order.total_amount,
                      paid_amount: detail.order.paid_amount,
                      payment_status: detail.order.payment_status,
                      payment_method: detail.order.payment_method,
                      customer_name: detail.order.customer_name,
                      customer_phone: detail.order.customer_phone,
                      order_date: detail.order.order_date,
                      estimated_collection_date: detail.order.estimated_collection_date,
                      branch_code: detail.order.branch_code,
                    })}
                  >
                    Reprint
                  </button>
                ) : null
              }
            />
          </div>
        );
      })}
      {consolidatedOrders.length === 0 && orphanExpandedReceipts.length === 0 ? (
        <div className="empty-state-modern" role="status">
          <p className="empty-state-title">No orders match your filters</p>
          <p className="empty-state-hint">Try clearing filters above or create a new order from the Dashboard.</p>
        </div>
      ) : consolidatedOrders.length === 0 ? null : listView === 'card' ? (
        <>
        <div className="orders-cards-grid">
          {consolidatedOrders.map((receiptGroup) => {
            const balance = receiptGroup.total_amount - receiptGroup.paid_amount;
            const itemCount = receiptGroup.items.length;
            return (
              <div key={receiptGroup.receipt_number} className="orders-list-card dk-queue-card">
                <div className="orders-list-card-header">
                  <strong>{formatReceiptForDisplay(receiptGroup.receipt_number, receiptGroup.items)}</strong>
                  <span
                    className="status-badge"
                    style={{ backgroundColor: getStatusColor(receiptGroup.status === 'processing' ? 'pending' : receiptGroup.status), fontSize: '11px' }}
                  >
                    {receiptGroup.status === 'processing' ? 'Pending' : receiptGroup.status}
                  </span>
                </div>
                <div className="orders-list-card-body">
                  <p><strong>{receiptGroup.customer_name}</strong></p>
                  {renderCustomerPhoneCell(receiptGroup)}
                  <p>{itemCount} line(s) · TSh {receiptGroup.total_amount.toLocaleString()}</p>
                  <p>{balance > 0 ? <span style={{ color: 'var(--warning-color)', fontWeight: 'bold' }}>Balance TSh {balance.toLocaleString()}</span> : <span style={{ color: 'var(--success-color)' }}>Paid</span>}</p>
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Est: {formatDateTime(receiptGroup.estimated_collection_date)}</p>
                </div>
                <div className="orders-list-card-actions">
                  {renderReceiptActions(receiptGroup)}
                </div>
                {expandedReceipts.has(receiptGroup.receipt_number) && (
                  <div className="orders-list-card-detail">
                    {renderExpandedDetail(receiptGroup)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {hasMore && !loading && (
          <div className="load-more-row" style={{ padding: '12px', textAlign: 'center' }}>
            <button type="button" className="btn-secondary" onClick={() => loadOrders(true, orders.length)} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more orders'}
            </button>
          </div>
        )}
        </>
      ) : (
        <>
        <div className="orders-table">
          <div
            className="orders-table-wrapper interactive-scroll-region"
            tabIndex={0}
            role="region"
            aria-label="Orders table"
            {...tableScrollHandlers}
          >
            <table>
            <thead>
              <tr>
                <th style={{ width: '30px' }}></th>
                <th>Receipt No</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Total Amount</th>
                <th>Payment</th>
                <th>Order Date</th>
                <th>Est. Collection</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {consolidatedOrders.map((receiptGroup) => {
                const isExpanded = expandedReceipts.has(receiptGroup.receipt_number);
                const balance = receiptGroup.total_amount - receiptGroup.paid_amount;
                const itemCount = receiptGroup.items.length;
                
                return (
                  <Fragment key={receiptGroup.receipt_number}>
                    {/* Main consolidated row */}
                    <tr className="receipt-group-row" style={{ backgroundColor: isExpanded ? 'var(--bg-hover)' : 'transparent' }}>
                      <td>
                        <button
                          className="expand-btn"
                          onClick={() => toggleReceiptExpansion(receiptGroup.receipt_number, receiptGroup.items)}
                          style={{ 
                            background: 'none', 
                            border: 'none', 
                            cursor: 'pointer',
                            fontSize: '14px',
                            padding: '4px 8px'
                          }}
                          title={isExpanded ? 'Minimize details' : 'Maximize order details'}
                        >
                          {isExpanded ? '▼' : '▶'}
                        </button>
                      </td>
                      <td><strong>{formatReceiptForDisplay(receiptGroup.receipt_number, receiptGroup.items)}</strong></td>
                      <td>
                        <div>
                          <strong>{receiptGroup.customer_name}</strong>
                          {renderCustomerPhoneCell(receiptGroup)}
                        </div>
                      </td>
                      <td>
                        <div className="order-details">
                          <span style={{ fontWeight: '600' }}>{itemCount} {itemCount === 1 ? 'item' : 'items'}</span>
                          {!isExpanded && (
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                              {receiptGroup.items.slice(0, 2).map((item, idx) => (
                                <div key={idx}>
                                  {item.garment_type || item.service_name} x{item.quantity}
                                  {item.color && ` (${item.color})`}
                                </div>
                              ))}
                              {itemCount > 2 && <div>+ {itemCount - 2} more...</div>}
                            </div>
                          )}
                        </div>
                      </td>
                      <td><strong>TSh {receiptGroup.total_amount.toLocaleString()}</strong></td>
                      <td>
                        <div className="payment-info">
                          <div>Paid: TSh {receiptGroup.paid_amount.toLocaleString()}</div>
                          {balance > 0 ? (
                            <div style={{ color: 'var(--warning-color)', fontWeight: 'bold' }}>
                              Balance: TSh {balance.toLocaleString()}
                            </div>
                          ) : (
                            <div style={{ color: 'var(--success-color)' }}>✅ Paid Full</div>
                          )}
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {receiptGroup.payment_status === 'not_paid' ? 'Not Paid' : 
                             receiptGroup.payment_status === 'advance' ? 'Advance' : 'Paid Full'}
                          </div>
                        </div>
                      </td>
                      <td>{new Date(receiptGroup.order_date).toLocaleDateString()}</td>
                      <td>
                        {editingDate && editingDate.receiptNumber === receiptGroup.receipt_number ? (
                          <div className="date-edit-controls">
                            <input
                              type="datetime-local"
                              value={editingDate.value}
                              onChange={(e) => setEditingDate({ ...editingDate, value: e.target.value })}
                              min={new Date().toISOString().slice(0, 16)}
                              className="date-edit-input"
                              autoFocus
                            />
                            <div className="date-edit-buttons">
                              <button
                                className="btn-small btn-success"
                                onClick={() => {
                                  // Update all orders in this receipt group
                                  receiptGroup.items.forEach(item => {
                                    handleSaveEstimatedDate(item.id);
                                  });
                                }}
                                title="Save"
                              >
                                ✓
                              </button>
                              <button
                                className="btn-small btn-secondary"
                                onClick={handleCancelEdit}
                                title="Cancel"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div 
                            className="estimated-date-cell"
                            onClick={() => {
                              const firstOrder = receiptGroup.items[0];
                              handleEditEstimatedDate(firstOrder.id, receiptGroup.estimated_collection_date);
                              setEditingDate(prev => ({ ...prev, receiptNumber: receiptGroup.receipt_number }));
                            }}
                            title="Click to edit"
                          >
                            <span className={receiptGroup.estimated_collection_date ? '' : 'not-set'}>
                              {formatDateTime(receiptGroup.estimated_collection_date)}
                            </span>
                            <button
                              className="edit-date-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                const firstOrder = receiptGroup.items[0];
                                handleEditEstimatedDate(firstOrder.id, receiptGroup.estimated_collection_date);
                                setEditingDate(prev => ({ ...prev, receiptNumber: receiptGroup.receipt_number }));
                              }}
                              title="Edit estimated collection date"
                            >
                              ✏️
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        <span
                          className="status-badge"
                          style={{ backgroundColor: getStatusColor(receiptGroup.status === 'processing' ? 'pending' : receiptGroup.status) }}
                        >
                          {receiptGroup.status === 'processing' ? 'Pending' : receiptGroup.status}
                        </span>
                      </td>
                      <td>
                        {renderReceiptActions(receiptGroup)}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="orders-expand-row">
                        <td colSpan={10}>
                          {renderExpandedDetail(receiptGroup)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
        {hasMore && !loading && (
          <div className="load-more-row" style={{ padding: '12px', textAlign: 'center' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => loadOrders(true, orders.length)}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load more orders'}
            </button>
          </div>
        )}
        </>
      )}
      </>
      )}

      {/* Receive Payment Modal */}
      {showReceivePaymentModal && selectedOrderForPayment && (() => {
        const receiptOrders = orders.filter((o) => o.receipt_number === selectedOrderForPayment.receipt_number);
        const source = receiptOrders.length > 0 ? receiptOrders : [selectedOrderForPayment];
        const receiptTotal = roundMoney(source.reduce((sum, item) => sum + (parseFloat(item.total_amount) || 0), 0));
        const receiptPaid = roundMoney(source.reduce((sum, item) => sum + (parseFloat(item.paid_amount) || 0), 0));
        const balanceDue = roundMoney(receiptTotal - receiptPaid);
        return (
        <div className="modal-overlay" onClick={() => setShowReceivePaymentModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>💰 Receive Payment</h2>
              <button className="modal-close" onClick={() => setShowReceivePaymentModal(false)}>×</button>
            </div>
            <form onSubmit={handleReceivePaymentSubmit}>
              <div className="modal-body">
                <div className="payment-summary">
                  <div className="payment-item">
                    <span>Receipt No:</span>
                    <strong>{formatReceiptForDisplay(selectedOrderForPayment.receipt_number, source)}</strong>
                  </div>
                  <div className="payment-item">
                    <span>Customer:</span>
                    <strong>{selectedOrderForPayment.customer_name}</strong>
                  </div>
                  <div className="payment-item">
                    <span>Total Amount:</span>
                    <strong>TSh {receiptTotal.toLocaleString()}</strong>
                  </div>
                  <div className="payment-item">
                    <span>Amount Paid:</span>
                    <strong>TSh {receiptPaid.toLocaleString()}</strong>
                  </div>
                  <div className="payment-item balance-due">
                    <span>Balance Due:</span>
                    <strong>TSh {balanceDue.toLocaleString()}</strong>
                  </div>
                </div>
                <div className="form-group">
                  <label>Payment Amount * (full or partial, up to balance due)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    placeholder={`Enter up to TSh ${balanceDue.toLocaleString()}`}
                    min="0"
                    step="0.01"
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label>Payment Method *</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    required
                  >
                    <option value="cash">Cash</option>
                    <option value="mobile_money">Mobile Money</option>
                    <option value="card">Card</option>
                    <option value="bank_transfer">Bank Transfer</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Payment Date *</label>
                  <input
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    required
                  />
                </div>
                <div className="info-notice" style={{ marginTop: '15px', padding: '10px', background: 'var(--primary-light)', borderRadius: '8px', fontSize: '14px' }}>
                  ℹ️ This will record the payment and update the order's payment status. The order status will remain unchanged.
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => {
                  setShowReceivePaymentModal(false);
                  setSelectedOrderForPayment(null);
                  setPaymentAmount('');
                  setPaymentDate(todayYmd());
                }}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={receivingPayment}>
                  {receivingPayment ? '⏳ Processing...' : '💰 Receive Payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
        );
      })()}
    </div>
  );
};

export default Orders;
