import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { getOrders, updateOrderStatus, getCollectionQueue, getOrderDashboardStats, getTodayCashSummary, getCashSummaryRange, getUnreconciledClosings, getAdminInboxCounts } from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import { useListViewPreference } from '../hooks/useListViewPreference';
import ListViewToggle from '../components/ListViewToggle';
import Loader from '../components/Loader';
import { formatReceiptForDisplay } from '../utils/receiptId';
import './Dashboard.css';

const DASHBOARD_LIST_LIMIT = 50;

const Dashboard = () => {
  const navigate = useNavigate();
  const { showToast, ToastContainer } = useToast();
  const { selectedBranchId, user, hasPermission, branch } = useAuth();
  const isCashier = user?.role === 'cashier';
  const isAdmin = user?.role === 'admin';
  const canManageCash = hasPermission?.('canManageCash') ?? false;
  const canManageOrders = hasPermission?.('canManageOrders') ?? false;
  const canViewReports = hasPermission?.('canViewReports') ?? false;
  const isManager = canManageCash || canManageOrders || canViewReports;
  const isOwnerView = isAdmin || user?.role === 'manager';
  const [listView, setListView] = useListViewPreference();
  const [unreconciledCount, setUnreconciledCount] = useState(0);
  const [inboxOpenCount, setInboxOpenCount] = useState(0);
  const visibleRef = useRef(true);
  const [summary, setSummary] = useState(null);
  const [monthIncome, setMonthIncome] = useState(0);
  const [orderStats, setOrderStats] = useState(null);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [readyQueue, setReadyQueue] = useState([]); // Collection queue (grouped by receipt)
  const [loading, setLoading] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [readySearchTerm, setReadySearchTerm] = useState('');
  const [pendingSearchTerm, setPendingSearchTerm] = useState('');
  const [readySearchInput, setReadySearchInput] = useState('');
  const [pendingSearchInput, setPendingSearchInput] = useState('');
  const today = new Date().toISOString().split('T')[0];

  const todayIncome = useMemo(
    () =>
      Number(summary?.cash_sales || 0) +
      Number(summary?.book_sales || 0) +
      Number(summary?.card_sales || 0) +
      Number(summary?.mobile_money_sales || 0),
    [summary]
  );
  const cashBookPortion = useMemo(
    () => Number(summary?.cash_sales || 0) + Number(summary?.book_sales || 0),
    [summary]
  );
  const digitalToday = useMemo(
    () => Number(summary?.card_sales || 0) + Number(summary?.mobile_money_sales || 0),
    [summary]
  );
  const expensesToday = useMemo(
    () =>
      Number(summary?.expenses_from_cash || 0) +
      Number(summary?.expenses_from_bank || 0) +
      Number(summary?.expenses_from_mpesa || 0),
    [summary]
  );
  const cashPosition = useMemo(
    () => Number(summary?.cash_in_hand ?? summary?.closing_balance ?? 0),
    [summary]
  );
  const overdueCount = useMemo(() => readyQueue.filter((r) => r.is_overdue).length, [readyQueue]);
  const openBalancesTotal = useMemo(
    () =>
      readyQueue.reduce((sum, r) => {
        const b = (Number(r.total_amount) || 0) - (Number(r.paid_amount) || 0);
        return sum + (b > 0 ? b : 0);
      }, 0),
    [readyQueue]
  );
  const subtitleDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const branchLine = branch?.name || '';

  const loadDashboardData = useCallback(async () => {
    const readyCustomer = readySearchTerm.trim() || undefined;
    const pendingCustomer = pendingSearchTerm.trim() || undefined;
    const monthStart = `${today.slice(0, 7)}-01`;

    try {
      // Phase 1: headline stats (fast cached cash + counts) — paint KPIs first
      const [summaryRes, statsRes] = await Promise.all([
        getTodayCashSummary(),
        getOrderDashboardStats(),
      ]);
      setSummary(summaryRes.data);
      setOrderStats(statsRes.data || null);
      setLoading(false);

      // Phase 2: lists + month total + unreconciled (non-blocking for first paint)
      const unreconciledPromise = canManageCash
        ? getUnreconciledClosings({ limit: 50 }).catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] });
      const inboxPromise = isAdmin
        ? getAdminInboxCounts().catch(() => ({ data: {} }))
        : Promise.resolve({ data: {} });
      const [pendingRes, queueRes, monthRes, unreconRes, inboxRes] = await Promise.all([
        getOrders({ status: 'pending', limit: DASHBOARD_LIST_LIMIT, ...(pendingCustomer && { customer: pendingCustomer }) }),
        getCollectionQueue({ limit: DASHBOARD_LIST_LIMIT, ...(readyCustomer && { customer: readyCustomer }) }),
        getCashSummaryRange(monthStart, today),
        unreconciledPromise,
        inboxPromise,
      ]);
      const monthTotal = (Array.isArray(monthRes?.data) ? monthRes.data : []).reduce((acc, row) => (
        acc + (Number(row.cash_sales || 0) + Number(row.book_sales || 0) + Number(row.card_sales || 0) + Number(row.mobile_money_sales || 0))
      ), 0);

      setMonthIncome(monthTotal);
      setPendingOrders(pendingRes.data || []);
      setReadyQueue(queueRes.data || []);
      setUnreconciledCount(Array.isArray(unreconRes.data) ? unreconRes.data.length : 0);
      const counts = inboxRes?.data || {};
      setInboxOpenCount(Number(counts.unread || counts.pending_actions || 0));
      const synced = [summaryRes, pendingRes, queueRes].find((r) => r.fromCache && r.syncedAt);
      if (synced) setLastSyncedAt(synced.syncedAt); else setLastSyncedAt(null);
    } catch (error) {
      console.error('Error loading dashboard:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Network Error';
      if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Network Error')) {
        showToast('Cannot connect to server. Please ensure the server is running.', 'error');
      }
      setPendingOrders([]);
      setReadyQueue([]);
      setOrderStats(null);
      setMonthIncome(0);
      setLoading(false);
    }
  }, [today, readySearchTerm, pendingSearchTerm, showToast, canManageCash, isAdmin]);

  useEffect(() => {
    loadDashboardData();
    const interval = setInterval(() => {
      if (!document.hidden) loadDashboardData();
    }, 30000);
    const onVis = () => { visibleRef.current = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [loadDashboardData, selectedBranchId]);

  // Debounce search terms so we don't refetch on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setReadySearchTerm(readySearchInput), 400);
    return () => clearTimeout(t);
  }, [readySearchInput]);
  useEffect(() => {
    const t = setTimeout(() => setPendingSearchTerm(pendingSearchInput), 400);
    return () => clearTimeout(t);
  }, [pendingSearchInput]);

  const handleQuickAction = (action) => {
    if (action === 'new-order') {
      navigate('/new-order');
    }
  };

  const viewInReports = () => {
    const end = new Date().toISOString().split('T')[0];
    const start = new Date(new Date().setDate(new Date().getDate() - 6)).toISOString().split('T')[0];
    navigate(`/reports?start=${start}&end=${end}`);
  };

  // Group orders by receipt_number so one receipt = one card (same receipt number not shown twice)
  const groupPendingByReceipt = (ordersList) => {
    const grouped = {};
    (ordersList || []).forEach((order) => {
      const rn = order.receipt_number;
      if (!grouped[rn]) {
        grouped[rn] = {
          receipt_number: rn,
          customer_name: order.customer_name,
          customer_phone: order.customer_phone,
          service_name: order.service_name,
          items: [],
          total_amount: 0,
          order_ids: []
        };
      }
      grouped[rn].items.push(order);
      grouped[rn].total_amount += parseFloat(order.total_amount) || 0;
      grouped[rn].order_ids.push(order.id);
    });
    return Object.values(grouped);
  };

  const groupedPending = groupPendingByReceipt(pendingOrders);

  // Update status for entire receipt (all line items) so one click = one receipt
  const handleReceiptStatusUpdate = async (receiptGroup, newStatus) => {
    try {
      for (const id of receiptGroup.order_ids) {
        await updateOrderStatus(id, newStatus);
      }
      showToast(`Receipt ${formatReceiptForDisplay(receiptGroup.receipt_number, receiptGroup.items)} marked as ${newStatus}`, 'success');
      loadDashboardData();
    } catch (error) {
      const msg = error.response?.data?.error || error.message || 'Error updating order';
      showToast(msg, 'error');
    }
  };

  if (loading) {
    return <Loader message="Loading dashboard…" fullPage />;
  }

  return (
    <div className="dashboard-modern">
      <ToastContainer />
      {lastSyncedAt && (
        <div className="sync-cache-banner" role="status">
          Showing data from last sync — {new Date(lastSyncedAt).toLocaleString()}
        </div>
      )}
      <div className="dashboard-header">
        <div>
          <h1>Dashboard</h1>
          <p className="subtitle">
            {isCashier ? 'Quick access: new orders & collection' : "Today's overview"}
            {branchLine ? ` · ${subtitleDate} · ${branchLine}` : ` · ${subtitleDate}`}
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="dk-btn dk-btn--secondary dk-btn--md"
            onClick={viewInReports}
          >
            📈 Reports
          </button>
          <button
            type="button"
            className="dk-btn dk-btn--secondary dk-btn--md"
            onClick={() => navigate('/orders')}
          >
            Go to Collection
          </button>
          <button
            type="button"
            className="dk-btn dk-btn--primary dk-btn--md"
            onClick={() => handleQuickAction('new-order')}
          >
            ➕ New Order
          </button>
        </div>
      </div>

      {isManager && (() => {
        const pendingCount = orderStats?.pending_receipts ?? groupedPending.length;
        const tasks = [];
        if (canManageCash && unreconciledCount > 0)
          tasks.push({ key: 'unrec', label: 'Unreconciled days', value: unreconciledCount, path: '/cash-management', accent: 'warning' });
        if (isAdmin && inboxOpenCount > 0)
          tasks.push({ key: 'inbox', label: 'Admin alerts', value: inboxOpenCount, path: '/dashboard', accent: 'danger' });
        if (overdueCount > 0)
          tasks.push({ key: 'overdue', label: 'Ready overdue', value: overdueCount, path: '/orders', accent: 'danger' });
        if (openBalancesTotal > 0)
          tasks.push({ key: 'balances', label: 'Open balances', value: `TSh ${openBalancesTotal.toLocaleString()}`, path: '/orders', accent: 'warning' });
        if (pendingCount > 0)
          tasks.push({ key: 'pending', label: 'Pending in progress', value: pendingCount, path: '/orders', accent: 'info' });
        return tasks.length > 0 ? (
          <div className="dk-task-inbox" role="region" aria-label="Manager tasks">
            {tasks.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`dk-task-card dk-task-card--${t.accent}`}
                onClick={() => navigate(t.path)}
              >
                <span className="dk-task-card__value">{t.value}</span>
                <span className="dk-task-card__label">{t.label}</span>
              </button>
            ))}
          </div>
        ) : null;
      })()}

      <div className="dk-stat-strip" role="region" aria-label="Dashboard summary">
        <div className="dk-stat-cell">
          <div className="dk-stat-cell__row">
            <span className="dk-stat-cell__dot dk-accent-success" aria-hidden />
            <span className="dk-stat-cell__label">Income today</span>
          </div>
          <div className="dk-stat-cell__value-row">
            <span className="dk-stat-cell__value">TSh {todayIncome.toLocaleString()}</span>
          </div>
          <span className="dk-stat-cell__sub">
            Cash+book TSh {cashBookPortion.toLocaleString()} · MTD TSh {Number(monthIncome || 0).toLocaleString()}
          </span>
        </div>
        {isOwnerView && (
          <>
            <div className="dk-stat-cell">
              <div className="dk-stat-cell__row">
                <span className="dk-stat-cell__dot dk-accent-info" aria-hidden />
                <span className="dk-stat-cell__label">Digital today</span>
              </div>
              <div className="dk-stat-cell__value-row">
                <span className="dk-stat-cell__value">TSh {digitalToday.toLocaleString()}</span>
              </div>
              <span className="dk-stat-cell__sub">Card + M-Pesa</span>
            </div>
            <div className="dk-stat-cell">
              <div className="dk-stat-cell__row">
                <span className="dk-stat-cell__dot dk-accent-warning" aria-hidden />
                <span className="dk-stat-cell__label">Expenses today</span>
              </div>
              <div className="dk-stat-cell__value-row">
                <span className="dk-stat-cell__value">TSh {expensesToday.toLocaleString()}</span>
              </div>
              <span className="dk-stat-cell__sub">Operating outflows</span>
            </div>
            <div className="dk-stat-cell">
              <div className="dk-stat-cell__row">
                <span className="dk-stat-cell__dot dk-accent-success" aria-hidden />
                <span className="dk-stat-cell__label">Cash position</span>
              </div>
              <div className="dk-stat-cell__value-row">
                <span className="dk-stat-cell__value">TSh {cashPosition.toLocaleString()}</span>
              </div>
              <span className="dk-stat-cell__sub">Expected cash in hand</span>
            </div>
          </>
        )}
        <div className="dk-stat-cell">
          <div className="dk-stat-cell__row">
            <span className="dk-stat-cell__dot dk-accent-info" aria-hidden />
            <span className="dk-stat-cell__label">Total orders</span>
          </div>
          <div className="dk-stat-cell__value-row">
            <span className="dk-stat-cell__value">{(orderStats?.total_receipts ?? 0).toLocaleString()}</span>
          </div>
          <span className="dk-stat-cell__sub">Receipts (all statuses)</span>
        </div>
        <div className="dk-stat-cell">
          <div className="dk-stat-cell__row">
            <span className="dk-stat-cell__dot dk-accent-warning" aria-hidden />
            <span className="dk-stat-cell__label">Pending</span>
          </div>
          <div className="dk-stat-cell__value-row">
            <span className="dk-stat-cell__value">{(orderStats?.pending_receipts ?? groupedPending.length).toLocaleString()}</span>
          </div>
          <span className="dk-stat-cell__sub">In progress</span>
        </div>
        <div className="dk-stat-cell">
          <div className="dk-stat-cell__row">
            <span className="dk-stat-cell__dot dk-accent-success" aria-hidden />
            <span className="dk-stat-cell__label">Ready</span>
          </div>
          <div className="dk-stat-cell__value-row">
            <span className="dk-stat-cell__value">{(orderStats?.ready_receipts ?? readyQueue.length).toLocaleString()}</span>
          </div>
          <span className="dk-stat-cell__sub">For collection</span>
        </div>
        <div className="dk-stat-cell">
          <div className="dk-stat-cell__row">
            <span className="dk-stat-cell__dot dk-accent-danger" aria-hidden />
            <span className="dk-stat-cell__label">Overdue</span>
          </div>
          <div className="dk-stat-cell__value-row">
            <span className="dk-stat-cell__value">{overdueCount.toLocaleString()}</span>
          </div>
          <span className="dk-stat-cell__sub">Ready queue</span>
        </div>
        <div className="dk-stat-cell">
          <div className="dk-stat-cell__row">
            <span className={`dk-stat-cell__dot ${openBalancesTotal > 0 ? 'dk-accent-warning' : 'dk-accent-info'}`} aria-hidden />
            <span className="dk-stat-cell__label">Open balances</span>
          </div>
          <div className="dk-stat-cell__value-row">
            <span className="dk-stat-cell__value">TSh {openBalancesTotal.toLocaleString()}</span>
          </div>
          <span className="dk-stat-cell__sub">Ready queue unpaid</span>
        </div>
      </div>

      <div className="dashboard-reports-link-wrap" style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        <button type="button" className="btn-link dashboard-reports-link" onClick={viewInReports}>
          📈 View in Reports (last 7 days)
        </button>
        <ListViewToggle view={listView} setView={setListView} />
      </div>

      <div className="dashboard-grid dashboard-queues-grid">
        <div className="dashboard-card queue-card ready-queue-card">
          <div className="card-header">
            <div>
              <h2>✅ Ready Orders Queue ({readyQueue.length})</h2>
              {readyQueue.filter(r => r.is_overdue).length > 0 && (
                <span className="overdue-count-badge">
                  ⚠️ {readyQueue.filter(r => r.is_overdue).length} Overdue
                </span>
              )}
            </div>
            <button className="btn-link" onClick={() => navigate('/orders')}>
              View in Collection →
            </button>
          </div>
          <div className="dashboard-search-wrap">
            <span className="dashboard-search-icon" aria-hidden>🔍</span>
            <input
              type="text"
              className="dashboard-search-input"
              placeholder="Search by customer name or phone..."
              value={readySearchInput}
              onChange={(e) => setReadySearchInput(e.target.value)}
              aria-label="Search ready orders by customer name"
            />
          </div>
          {readyQueue.length > 0 ? (
            listView === 'card' ? (
              <div className="dashboard-cards-grid queue-scroll-area">
                {readyQueue.map(receipt => {
                  const balance = (receipt.total_amount || 0) - (receipt.paid_amount || 0);
                  const isOverdue = receipt.is_overdue;
                  const hoursOverdue = receipt.hours_overdue || 0;
                  const itemCount = receipt.receipt_item_count || 1;
                  const timeRemaining = !isOverdue && receipt.estimated_collection_date ? (() => {
                    const estDate = new Date(receipt.estimated_collection_date);
                    const now = new Date();
                    const diffHours = Math.floor((estDate - now) / (1000 * 60 * 60));
                    if (diffHours <= 2 && diffHours > 0) return `${diffHours}h left`;
                    return null;
                  })() : null;
                  return (
                    <div
                      key={receipt.receipt_number}
                      className={`dashboard-list-card dk-queue-card dk-queue-card--ready ${isOverdue ? 'overdue dk-queue-card--overdue' : ''}`}
                    >
                      <div className="dashboard-list-card-header">
                        <Link
                          to={`/orders?receipt=${encodeURIComponent(receipt.receipt_number)}`}
                          className={`receipt-badge receipt-link dk-receipt-chip ${isOverdue ? 'dk-receipt-chip--overdue overdue-badge' : 'dk-receipt-chip--outline'}`}
                        >
                          {formatReceiptForDisplay(receipt.receipt_number, receipt.all_items || [])}
                        </Link>
                        {isOverdue && hoursOverdue > 0 && <span className="overdue-indicator">⚠️ {hoursOverdue}h overdue</span>}
                        {timeRemaining && <span className="time-remaining">⏰ {timeRemaining}</span>}
                      </div>
                      <div className="dashboard-list-card-body">
                        <p><strong>{receipt.customer_name}</strong></p>
                        <p className="text-muted">{receipt.customer_phone}</p>
                        <p>{itemCount} item(s) · TSh {(receipt.total_amount || 0).toLocaleString()}</p>
                        <p>{balance > 0 ? <span className="balance-due">Balance TSh {balance.toLocaleString()}</span> : 'Paid'}</p>
                      </div>
                      <div className="dashboard-list-card-actions">
                        <button type="button" className="btn-small btn-success" onClick={() => navigate(`/orders?receipt=${receipt.receipt_number}`)}>
                          Collect
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="dashboard-table-wrap queue-scroll-area">
                <table className="dashboard-table">
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th>Items</th>
                      <th>Total</th>
                      <th>Balance</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {readyQueue.map(receipt => {
                      const balance = (receipt.total_amount || 0) - (receipt.paid_amount || 0);
                      const isOverdue = receipt.is_overdue;
                      const hoursOverdue = receipt.hours_overdue || 0;
                      const itemCount = receipt.receipt_item_count || 1;
                      const timeRemaining = !isOverdue && receipt.estimated_collection_date ? (() => {
                        const estDate = new Date(receipt.estimated_collection_date);
                        const now = new Date();
                        const diffHours = Math.floor((estDate - now) / (1000 * 60 * 60));
                        if (diffHours <= 2 && diffHours > 0) return `${diffHours}h left`;
                        return null;
                      })() : null;
                      return (
                        <tr key={receipt.receipt_number} className={isOverdue ? 'row-overdue dk-table-row--accent-danger' : 'dk-table-row--accent-success'}>
                          <td>
                            <Link
                              to={`/orders?receipt=${encodeURIComponent(receipt.receipt_number)}`}
                              className={`receipt-badge receipt-link dk-receipt-chip ${isOverdue ? 'dk-receipt-chip--overdue overdue-badge' : 'dk-receipt-chip--outline'}`}
                              title="Open in Collection"
                            >
                              {formatReceiptForDisplay(receipt.receipt_number, receipt.all_items || [])}
                            </Link>
                          </td>
                          <td><strong>{receipt.customer_name}</strong></td>
                          <td className="text-muted">{receipt.customer_phone}</td>
                          <td>{itemCount}</td>
                          <td className="amount-cell">TSh {(receipt.total_amount || 0).toLocaleString()}</td>
                          <td>{balance > 0 ? <span className="balance-due">TSh {balance.toLocaleString()}</span> : '—'}</td>
                          <td>
                            {isOverdue && hoursOverdue > 0 && <span className="overdue-indicator">⚠️ {hoursOverdue}h overdue</span>}
                            {timeRemaining && <span className="time-remaining">⏰ {timeRemaining}</span>}
                            {!isOverdue && !timeRemaining && '—'}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn-small btn-success btn-table-action"
                              onClick={() => navigate(`/orders?receipt=${receipt.receipt_number}`)}
                            >
                              Collect
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <div className="empty-state-modern">
              <div className="empty-icon">📭</div>
              <p>{readySearchInput.trim() ? 'No ready orders match that name' : 'No orders ready for collection'}</p>
            </div>
          )}
        </div>

        <div className="dashboard-card queue-card pending-queue-card">
          <div className="card-header">
            <h2>⏳ Pending Orders ({groupedPending.length})</h2>
            <button className="btn-link" onClick={() => navigate('/orders')}>
              View in Orders →
            </button>
          </div>
          <div className="dashboard-search-wrap">
            <span className="dashboard-search-icon" aria-hidden>🔍</span>
            <input
              type="text"
              className="dashboard-search-input"
              placeholder="Search by customer name or phone..."
              value={pendingSearchInput}
              onChange={(e) => setPendingSearchInput(e.target.value)}
              aria-label="Search pending orders by customer name"
            />
          </div>
          {groupedPending.length > 0 ? (
            listView === 'card' ? (
              <div className="dashboard-cards-grid queue-scroll-area">
                {groupedPending.map((receiptGroup) => (
                  <div key={receiptGroup.receipt_number} className="dashboard-list-card dk-queue-card">
                    <div className="dashboard-list-card-header">
                      <span className="receipt-badge dk-receipt-chip dk-receipt-chip--filled">
                        {formatReceiptForDisplay(receiptGroup.receipt_number, receiptGroup.items)}
                      </span>
                    </div>
                    <div className="dashboard-list-card-body">
                      <p><strong>{receiptGroup.customer_name}</strong></p>
                      <p className="text-muted">{receiptGroup.customer_phone}</p>
                      <p>{receiptGroup.items.length} line(s) · TSh {(receiptGroup.total_amount || 0).toLocaleString()}</p>
                    </div>
                    <div className="dashboard-list-card-actions">
                      <button type="button" className="btn-small btn-secondary" onClick={() => navigate(`/orders?receipt=${encodeURIComponent(receiptGroup.receipt_number)}`)}>View</button>
                      <button type="button" className="btn-small btn-success" onClick={() => handleReceiptStatusUpdate(receiptGroup, 'ready')}>Mark Ready</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="dashboard-table-wrap queue-scroll-area">
                <table className="dashboard-table">
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th>Items</th>
                      <th>Total</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupedPending.map((receiptGroup) => (
                      <tr key={receiptGroup.receipt_number} className="dk-table-row--accent-primary">
                        <td>
                          <span className="receipt-badge dk-receipt-chip dk-receipt-chip--filled">
                            {formatReceiptForDisplay(receiptGroup.receipt_number, receiptGroup.items)}
                          </span>
                        </td>
                        <td><strong>{receiptGroup.customer_name}</strong></td>
                        <td className="text-muted">{receiptGroup.customer_phone}</td>
                        <td>{receiptGroup.items.length}</td>
                        <td className="amount-cell">TSh {(receiptGroup.total_amount || 0).toLocaleString()}</td>
                        <td>
                          <div className="quick-actions">
                            <button
                              type="button"
                              className="btn-small btn-secondary btn-table-action"
                              onClick={() => navigate(`/orders?receipt=${encodeURIComponent(receiptGroup.receipt_number)}`)}
                              title="View receipt details on Orders"
                            >
                              View
                            </button>
                            <button
                              type="button"
                              className="btn-small btn-success btn-table-action"
                              onClick={() => handleReceiptStatusUpdate(receiptGroup, 'ready')}
                            >
                              Mark Ready
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <div className="empty-state-modern">
              <div className="empty-icon">✨</div>
              <p>{pendingSearchInput.trim() ? 'No pending orders match that name' : 'No pending orders'}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
