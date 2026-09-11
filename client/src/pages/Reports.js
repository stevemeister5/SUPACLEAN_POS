import React, { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getOverviewReport,
  getFinancialReport,
  getDailyProfitReport,
  getSalesReport,
  getServiceReport,
  getCustomerReport,
  getBusinessHealthReport,
  setReportsMonthlyTarget,
  unreconcileDailyCash,
  getBankDeposits,
  getBranches
} from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import useHorizontalScrollRegion from '../hooks/useHorizontalScrollRegion';
import Loader from '../components/Loader';
import './Reports.css';

const ReportsCharts = lazy(() =>
  import(/* webpackChunkName: "reports-recharts" */ './ReportsCharts')
);

class ChartErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('Chart error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="report-chart-wrap report-chart-fallback" role="alert">
          <p>Chart could not be displayed. Tables below still show the data.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const formatTSh = (n) => (n != null && !Number.isNaN(n) ? `TSh ${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'TSh 0');

const formatDelta = (pct) => {
  const v = Number(pct);
  if (!Number.isFinite(v) || v === 0) return { label: '0%', className: 'reports-delta--flat' };
  if (v > 0) return { label: `+${v}%`, className: 'reports-delta--up' };
  return { label: `${v}%`, className: 'reports-delta--down' };
};

const reportsChartSuspenseFallback = (
  <div className="report-chart-wrap report-chart-fallback" role="status" aria-live="polite">
    <p>Loading chart…</p>
  </div>
);

const presetRanges = () => {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();
  const toStr = (date) => date.toISOString().split('T')[0];
  return {
    last7: {
      start: toStr(new Date(y, m, d - 6)),
      end: toStr(today),
      label: 'Last 7 days'
    },
    thisMonth: {
      start: toStr(new Date(y, m, 1)),
      end: toStr(today),
      label: 'This month'
    },
    lastMonth: {
      start: toStr(new Date(y, m - 1, 1)),
      end: toStr(new Date(y, m, 0)),
      label: 'Last month'
    },
    today: {
      start: toStr(today),
      end: toStr(today),
      label: 'Today'
    }
  };
};

const exportCSV = (rows, columns, filename, branchLabel) => {
  if (!rows || rows.length === 0) return;
  const headers = columns.map((c) => (typeof c === 'string' ? c : c.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((col) => {
      const key = typeof col === 'string' ? col : col.key;
      let val = row[key];
      if (val instanceof Date) val = val.toISOString().split('T')[0];
      if (typeof val === 'number') return val;
      return `"${String(val ?? '').replace(/"/g, '""')}"`;
    }).join(',')
  );
  const headerLine = branchLabel ? `Branch: ${branchLabel}\n` : '';
  const csv = headerLine + [headers, ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename || 'report.csv';
  link.click();
  URL.revokeObjectURL(link.href);
};

const Reports = () => {
  const [searchParams] = useSearchParams();
  const { showToast, ToastContainer } = useToast();
  const { branch, user, hasPermission, selectedBranchId } = useAuth();
  const csvBranchLabel = branch?.name || (branch?.id != null ? `Branch ID ${branch.id}` : null);
  const [summary, setSummary] = useState(null);
  const [financialReport, setFinancialReport] = useState(null);
  const [profitReport, setProfitReport] = useState([]);
  const [salesReport, setSalesReport] = useState([]);
  const [serviceReport, setServiceReport] = useState([]);
  const [customerReport, setCustomerReport] = useState([]);
  const [dateRange, setDateRange] = useState(() => {
    const start = searchParams.get('start');
    const end = searchParams.get('end');
    if (start && end) return { start, end };
    const presets = presetRanges();
    return {
      start: presets.last7.start,
      end: presets.last7.end
    };
  });
  const [reportPeriod, setReportPeriod] = useState('day');
  const [customerFilter, setCustomerFilter] = useState({
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear()
  });
  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [loadedTabs, setLoadedTabs] = useState({ overview: false, sales: false, services: false, customers: false });
  const [expandedSections, setExpandedSections] = useState({
    sales: true,
    services: true,
    customers: true,
    financial: true,
    dailyProfit: true
  });
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [unreconcileModal, setUnreconcileModal] = useState(null);
  const [unreconcileReason, setUnreconcileReason] = useState('');
  const [unreconcileSubmitting, setUnreconcileSubmitting] = useState(false);
  const [bankDeposits, setBankDeposits] = useState([]);
  const [businessHealth, setBusinessHealth] = useState(null);
  const [branchesList, setBranchesList] = useState([]);
  const tableScrollHandlers = useHorizontalScrollRegion();
  const isAdmin = user?.role === 'admin';
  const canViewBankDeposits = hasPermission('canManageCash');

  const branchPerformance = useMemo(() => {
    const map = new Map();
    for (const row of profitReport) {
      const id = row.branch_id;
      if (id == null) continue;
      const o = map.get(id) || {
        branch_id: id,
        branch_name: row.branch_name || `Branch ${id}`,
        revenue: 0,
        expenses: 0,
        profit: 0,
        days: 0,
        reconciled_days: 0
      };
      o.revenue += parseFloat(row.revenue) || 0;
      o.expenses += parseFloat(row.expenses) || 0;
      o.profit += parseFloat(row.profit) || 0;
      o.days += 1;
      const v = row.is_reconciled;
      if (v === true || v === 1 || v === '1' || v === 'true') o.reconciled_days += 1;
      map.set(id, o);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [profitReport]);

  const salesPeriodTotals = useMemo(() => {
    let orders = 0;
    let revenue = 0;
    let collected = 0;
    for (const d of salesReport) {
      orders += parseInt(d.total_orders, 10) || 0;
      revenue += parseFloat(d.total_revenue) || 0;
      collected += parseFloat(d.collected_revenue) || 0;
    }
    return { orders, revenue, collected };
  }, [salesReport]);

  const bankDepositsTotal = useMemo(
    () => bankDeposits.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0),
    [bankDeposits]
  );

  const reconciledRowsCount = useMemo(
    () =>
      profitReport.filter((r) => {
        const v = r.is_reconciled;
        return v === true || v === 1 || v === '1' || v === 'true';
      }).length,
    [profitReport]
  );

  const scopeLabel = useMemo(() => {
    if (selectedBranchId == null && isAdmin) return 'All branches';
    const name = branchesList.find((b) => b.id === selectedBranchId)?.name;
    return name || branch?.name || (selectedBranchId != null ? `Branch #${selectedBranchId}` : 'Current branch');
  }, [selectedBranchId, isAdmin, branchesList, branch?.name]);

  const loadOverviewTab = useCallback(async (isInitial = false) => {
    if (isInitial) { setLoading(true); setLoadError(null); }
    else setTabLoading(true);
    try {
      const today = new Date().toISOString().split('T')[0];
      const depositPromise =
        canViewBankDeposits
          ? getBankDeposits({ start_date: dateRange.start, end_date: dateRange.end }).catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] });

      const [summaryRes, financialRes, profitRes, salesRes, healthRes, depRes] = await Promise.all([
        getOverviewReport(today),
        getFinancialReport(dateRange.start, dateRange.end, reportPeriod),
        getDailyProfitReport(dateRange.start, dateRange.end),
        getSalesReport(dateRange.start, dateRange.end),
        getBusinessHealthReport(dateRange.start, dateRange.end),
        depositPromise
      ]);

      setSummary(summaryRes.data);
      setFinancialReport(financialRes.data);
      setProfitReport(profitRes.data || []);
      setSalesReport(salesRes.data || []);
      setBusinessHealth(healthRes.data || null);
      setBankDeposits(Array.isArray(depRes.data) ? depRes.data : []);
      setLoadedTabs((prev) => ({ ...prev, overview: true }));
      const synced = [summaryRes, financialRes].find((r) => r.fromCache && r.syncedAt);
      if (synced) setLastSyncedAt(synced.syncedAt); else setLastSyncedAt(null);
    } catch (error) {
      console.error('Error loading reports:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Network Error';
      if (isInitial) {
        setLoadError(errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Network Error')
          ? 'Cannot connect to server. Ensure the backend is running (npm run dev).'
          : errorMsg);
      }
      setSummary(null);
      setFinancialReport(null);
      setProfitReport([]);
      setSalesReport([]);
      setBusinessHealth(null);
      setBankDeposits([]);
    } finally {
      if (isInitial) setLoading(false);
      else setTabLoading(false);
    }
  }, [dateRange.start, dateRange.end, reportPeriod, canViewBankDeposits]);

  const loadTabData = useCallback(async (tab) => {
    setTabLoading(true);
    try {
      if (tab === 'sales') {
        const res = await getSalesReport(dateRange.start, dateRange.end);
        setSalesReport(res.data || []);
      } else if (tab === 'services') {
        const res = await getServiceReport(dateRange.start, dateRange.end);
        setServiceReport(res.data || []);
      } else if (tab === 'customers') {
        const res = await getCustomerReport({ month: customerFilter.month, year: customerFilter.year });
        setCustomerReport(res.data || []);
      }
      setLoadedTabs((prev) => ({ ...prev, [tab]: true }));
    } catch (error) {
      console.error(`Error loading ${tab} report:`, error);
    } finally {
      setTabLoading(false);
    }
  }, [dateRange.start, dateRange.end, customerFilter.month, customerFilter.year]);

  const handleTabSwitch = useCallback((tab) => {
    setActiveTab(tab);
    if (tab === 'overview' && !loadedTabs.overview) {
      loadOverviewTab(false);
    } else if (!loadedTabs[tab]) {
      loadTabData(tab);
    }
  }, [loadedTabs, loadOverviewTab, loadTabData]);

  const loadReports = useCallback(async () => {
    await loadOverviewTab(true);
  }, [loadOverviewTab]);

  useEffect(() => {
    loadOverviewTab(true);
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    getBranches()
      .then((r) => setBranchesList(Array.isArray(r.data) ? r.data : []))
      .catch(() => setBranchesList([]));
  }, [isAdmin]);

  const applyPreset = (key) => {
    const presets = presetRanges();
    const p = presets[key];
    if (p) {
      setDateRange({ start: p.start, end: p.end });
      showToast(`Date range set to ${p.label}`, 'info');
    }
  };

  const handleCustomerFilterChange = async () => {
    setTabLoading(true);
    try {
      const res = await getCustomerReport({ month: customerFilter.month, year: customerFilter.year });
      setCustomerReport(res.data || []);
      setLoadedTabs((prev) => ({ ...prev, customers: true }));
      if (res.fromCache && res.syncedAt) setLastSyncedAt(res.syncedAt); else setLastSyncedAt(null);
    } catch (error) {
      console.error('Error loading customer report:', error);
    } finally {
      setTabLoading(false);
    }
  };

  const handleDateRangeChange = async () => {
    setLoadedTabs({ overview: false, sales: false, services: false, customers: false });
    if (activeTab === 'overview') {
      await loadOverviewTab(false);
    } else {
      await loadOverviewTab(false);
      await loadTabData(activeTab);
    }
  };

  const isProfitRowReconciled = (row) => {
    const v = row.is_reconciled;
    return v === true || v === 1 || v === '1' || v === 'true';
  };

  const openUnreconcileModal = (row) => {
    const bid = row.branch_id != null ? Number(row.branch_id) : NaN;
    if (!Number.isFinite(bid)) {
      showToast('This row has no branch; cannot reverse reconciliation.', 'error');
      return;
    }
    setUnreconcileReason('');
    setUnreconcileModal({
      date: row.date,
      branchId: bid,
      branchName: row.branch_name || `Branch ${bid}`,
    });
  };

  const handleConfirmUnreconcile = async () => {
    if (!unreconcileModal) return;
    setUnreconcileSubmitting(true);
    try {
      await unreconcileDailyCash(unreconcileModal.date, {
        branch_id: unreconcileModal.branchId,
        reason: unreconcileReason.trim() || undefined,
      });
      showToast('Reconciliation reversed. The branch can correct entries and reconcile again in Cash Management.', 'success');
      setUnreconcileModal(null);
      await handleDateRangeChange();
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Could not reverse reconciliation', 'error');
    } finally {
      setUnreconcileSubmitting(false);
    }
  };

  const toggleSection = (section) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const hasFinancialData = financialReport?.data?.length > 0;
  const hasProfitData = profitReport?.length > 0;
  const hasSalesData = salesReport?.length > 0;
  const hasServiceData = serviceReport?.length > 0;
  const hasCustomerData = customerReport?.length > 0;

  const overviewSummaryLine = summary
    ? `Today: ${formatTSh(summary.total_income)} income · ${summary.total_transactions || 0} transactions · Net ${formatTSh(summary.net_income)}`
    : 'No data for today yet.';
  const financialSummaryLine = hasFinancialData && financialReport?.totals
    ? `Period ${dateRange.start} – ${dateRange.end}: Revenue ${formatTSh(financialReport.totals.total_revenue)} · Expenses ${formatTSh(financialReport.totals.total_expenses)} · Profit ${formatTSh(financialReport.totals.total_profit)}`
    : 'No reconciled data for this period. Reconcile days in Cash Management to see financial report.';
  const salesSummaryLine = hasSalesData
    ? `${salesReport.length} days · Total revenue ${formatTSh(salesReport.reduce((s, d) => s + (parseFloat(d.total_revenue) || 0), 0))} · ${salesReport.reduce((s, d) => s + (d.total_orders || 0), 0)} orders`
    : 'No sales data for this period.';
  const servicesSummaryLine = hasServiceData
    ? `${serviceReport.length} services · Total revenue ${formatTSh(serviceReport.reduce((s, r) => s + (parseFloat(r.total_revenue) || 0), 0))}`
    : 'No service data for this period.';
  const customersSummaryLine = hasCustomerData
    ? `Top ${Math.min(20, customerReport.length)} customers · ${customerFilter.month}/${customerFilter.year}`
    : 'No customer data for this month.';

  const periodRangeLabel = `${dateRange.start} → ${dateRange.end}`;

  const handleSaveMonthlyTarget = async () => {
    const raw = window.prompt('Monthly revenue target (TZS) for this scope:', businessHealth?.monthly_target ?? '');
    if (raw === null) return;
    const amount = parseFloat(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount < 0) {
      showToast('Enter a valid non-negative amount.', 'error');
      return;
    }
    try {
      await setReportsMonthlyTarget(amount);
      showToast('Monthly target saved.', 'success');
      await loadOverviewTab(false);
    } catch (e) {
      showToast(e.response?.data?.error || e.message || 'Could not save target', 'error');
    }
  };

  if (loadError && !summary && !financialReport) {
    return (
      <div className="reports-page">
        <ToastContainer />
        <div className="page-header">
          <h1>Reports & Analytics</h1>
          <p>View business insights and statistics</p>
        </div>
        <div className="reports-error-state">
          <p className="reports-error-message">{loadError}</p>
          <button type="button" className="dk-btn dk-btn--primary dk-btn--md" onClick={loadReports}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (loading && !summary) {
    return (
      <div className="reports-page">
        <ToastContainer />
        <Loader message="Loading reports…" fullPage />
      </div>
    );
  }

  const chartColors = { revenue: 'var(--primary-color)', expenses: '#f44336', profit: '#4caf50' };
  const profitChartData = (profitReport || [])
    .slice()
    .reverse()
    .map((r) => ({
      date: r.date,
      revenue: parseFloat(r.revenue || 0),
      expenses: parseFloat(r.expenses || 0),
      profit: parseFloat(r.profit || 0)
    }));
  const salesChartData = (salesReport || []).slice().reverse().map((d) => ({
    date: d.date,
    revenue: parseFloat(d.total_revenue || 0),
    orders: parseInt(d.total_orders || 0, 10)
  }));
  const serviceChartData = (serviceReport || []).slice(0, 10).map((s) => ({
    name: (s.service_name || 'Other').substring(0, 15),
    revenue: parseFloat(s.total_revenue || 0),
    orders: parseInt(s.order_count || 0, 10)
  }));

  return (
    <div className="reports-page">
      <ToastContainer />
      {unreconcileModal && (
        <div
          className="reports-modal-overlay"
          onClick={() => !unreconcileSubmitting && setUnreconcileModal(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="unreconcile-modal-title"
        >
          <div className="reports-modal" onClick={(e) => e.stopPropagation()}>
            <h3 id="unreconcile-modal-title">Reverse reconciliation?</h3>
            <p className="reports-modal-body">
              Unlock <strong>{unreconcileModal.date}</strong> for <strong>{unreconcileModal.branchName}</strong> so managers can add missing expenses,
              payments, or book sales, then reconcile again. An audit line is appended to the daily summary notes.
            </p>
            <label htmlFor="unreconcile-reason" className="reports-modal-label">
              Reason (optional)
            </label>
            <textarea
              id="unreconcile-reason"
              className="reports-modal-textarea"
              rows={3}
              value={unreconcileReason}
              onChange={(e) => setUnreconcileReason(e.target.value)}
              placeholder="e.g. Branch forgot to record an expense for this date"
              disabled={unreconcileSubmitting}
            />
            <div className="reports-modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setUnreconcileModal(null)} disabled={unreconcileSubmitting}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={handleConfirmUnreconcile} disabled={unreconcileSubmitting}>
                {unreconcileSubmitting ? 'Working…' : 'Reverse reconciliation'}
              </button>
            </div>
          </div>
        </div>
      )}
      {lastSyncedAt && (
        <div className="sync-cache-banner" role="status">
          Showing data from last sync — {new Date(lastSyncedAt).toLocaleString()}
        </div>
      )}
      <header className="reports-dashboard-header">
        <div className="reports-dashboard-header-inner">
          <div>
            <h1 className="reports-dashboard-title">Reports &amp; analytics</h1>
            <p className="reports-dashboard-sub">Reconciled financials, sales velocity, and bank deposits for the selected period.</p>
          </div>
          <div className="reports-scope-chip" title="Change branch in the sidebar (admin)">
            <span className="reports-scope-chip-label">Scope</span>
            <span className="reports-scope-chip-value">{scopeLabel}</span>
          </div>
        </div>
      </header>

      <div className="reports-tabs-wrap reports-tabs-modern">
        <nav className="reports-tabs" aria-label="Report sections">
          <button
            type="button"
            className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => handleTabSwitch('overview')}
          >
            Overview
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'sales' ? 'active' : ''}`}
            onClick={() => handleTabSwitch('sales')}
          >
            Sales
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'customers' ? 'active' : ''}`}
            onClick={() => handleTabSwitch('customers')}
          >
            Customers
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'services' ? 'active' : ''}`}
            onClick={() => handleTabSwitch('services')}
          >
            Services
          </button>
        </nav>
      </div>

      {activeTab === 'overview' && (
        <>
          <p className="reports-live-line" aria-live="polite">{overviewSummaryLine}</p>

          {businessHealth?.alerts?.length > 0 && (
            <section className="reports-alerts" aria-label="Business alerts">
              {businessHealth.alerts.map((alert) => (
                <div key={alert.type} className={`reports-alert reports-alert--${alert.severity || 'info'}`} role="status">
                  {alert.message}
                </div>
              ))}
            </section>
          )}

          {businessHealth?.current?.financial && (
            <section className="reports-panel reports-panel--health" aria-label="Business health">
              <div className="reports-health-head">
                <div>
                  <h2 className="reports-panel-heading">Business health</h2>
                  <p className="reports-panel-lead">
                    Reconciled financials vs prior {businessHealth.comparison?.span_days || '—'} day(s) ({businessHealth.comparison?.prior_start} → {businessHealth.comparison?.prior_end}).
                  </p>
                </div>
                {(isAdmin || user?.role === 'manager') && (
                  <button type="button" className="btn-secondary reports-target-btn" onClick={handleSaveMonthlyTarget}>
                    Set monthly target
                  </button>
                )}
              </div>
              <div className="reports-kpi-grid reports-kpi-grid--health">
                <div className="reports-kpi reports-kpi--revenue">
                  <span className="reports-kpi-label">Revenue (reconciled)</span>
                  <span className="reports-kpi-value">{formatTSh(businessHealth.current.financial.total_revenue)}</span>
                  <span className={`reports-delta ${formatDelta(businessHealth.comparison?.revenue_change_pct).className}`}>
                    {formatDelta(businessHealth.comparison?.revenue_change_pct).label} vs prior
                  </span>
                </div>
                <div className="reports-kpi reports-kpi--profit">
                  <span className="reports-kpi-label">Profit</span>
                  <span className="reports-kpi-value">{formatTSh(businessHealth.current.financial.total_profit)}</span>
                  <span className={`reports-delta ${formatDelta(businessHealth.comparison?.profit_change_pct).className}`}>
                    {formatDelta(businessHealth.comparison?.profit_change_pct).label} vs prior
                  </span>
                </div>
                <div className="reports-kpi">
                  <span className="reports-kpi-label">Profit margin</span>
                  <span className="reports-kpi-value">{businessHealth.current.financial.profit_margin_pct ?? 0}%</span>
                  <span className="reports-kpi-foot">Expense ratio {businessHealth.current.financial.expense_ratio_pct ?? 0}%</span>
                </div>
                <div className="reports-kpi">
                  <span className="reports-kpi-label">Orders</span>
                  <span className="reports-kpi-value">{businessHealth.current.sales?.total_orders ?? 0}</span>
                  <span className={`reports-delta ${formatDelta(businessHealth.comparison?.orders_change_pct).className}`}>
                    {formatDelta(businessHealth.comparison?.orders_change_pct).label} vs prior
                  </span>
                </div>
                <div className="reports-kpi">
                  <span className="reports-kpi-label">Avg order value</span>
                  <span className="reports-kpi-value">{formatTSh(businessHealth.current.sales?.average_order_value)}</span>
                  <span className={`reports-delta ${formatDelta(businessHealth.comparison?.aov_change_pct).className}`}>
                    {formatDelta(businessHealth.comparison?.aov_change_pct).label} vs prior
                  </span>
                </div>
                {businessHealth.monthly_target != null && (
                  <div className="reports-kpi reports-kpi--target">
                    <span className="reports-kpi-label">Monthly target</span>
                    <span className="reports-kpi-value">{formatTSh(businessHealth.monthly_target)}</span>
                    <span className="reports-kpi-foot">
                      {businessHealth.target_progress_pct != null
                        ? `${businessHealth.target_progress_pct}% of target in this period`
                        : 'Target set'}
                    </span>
                  </div>
                )}
              </div>
            </section>
          )}

          <section className="reports-panel reports-panel--today">
            <h2 className="reports-panel-heading">Today (live)</h2>
            <div className="reports-kpi-grid reports-kpi-grid--sm">
              <div className="reports-kpi reports-kpi--income">
                <span className="reports-kpi-label">Total income</span>
                <span className="reports-kpi-value">{formatTSh(summary?.total_income)}</span>
              </div>
              <div className="reports-kpi">
                <span className="reports-kpi-label">Cash income</span>
                <span className="reports-kpi-value">{formatTSh(summary?.cash_income)}</span>
              </div>
              <div className="reports-kpi">
                <span className="reports-kpi-label">Transactions</span>
                <span className="reports-kpi-value">{summary?.total_transactions ?? 0}</span>
              </div>
              <div className="reports-kpi reports-kpi--profit">
                <span className="reports-kpi-label">Net (today)</span>
                <span className="reports-kpi-value">{formatTSh(summary?.net_income)}</span>
              </div>
            </div>
          </section>

          <section className="reports-control-card" aria-label="Date range and grouping">
            <div className="reports-control-head">
              <h2 className="reports-panel-heading">Period &amp; grouping</h2>
              <p className="reports-control-hint">
                Admins: use the <strong>branch selector</strong> in the sidebar to compare all branches or focus one location. Data below respects that scope.
              </p>
            </div>
            <div className="reports-presets-row">
              {Object.entries(presetRanges()).map(([key, p]) => (
                <button key={key} type="button" className="reports-preset-pill" onClick={() => applyPreset(key)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="reports-date-row">
              <label className="reports-date-field">
                <span>From</span>
                <input
                  type="date"
                  value={dateRange.start}
                  onChange={(e) => setDateRange((prev) => ({ ...prev, start: e.target.value }))}
                  aria-label="Start date"
                />
              </label>
              <label className="reports-date-field">
                <span>To</span>
                <input
                  type="date"
                  value={dateRange.end}
                  onChange={(e) => setDateRange((prev) => ({ ...prev, end: e.target.value }))}
                  aria-label="End date"
                />
              </label>
              <label className="reports-date-field reports-date-field--grow">
                <span>Columns</span>
                <select
                  value={reportPeriod}
                  onChange={(e) => setReportPeriod(e.target.value)}
                  aria-label="Group financial totals by"
                >
                  <option value="day">Daily summary</option>
                  <option value="week">Weekly summary</option>
                  <option value="month">Monthly summary</option>
                </select>
              </label>
              <div className="reports-date-actions">
                <button type="button" className="btn-primary" onClick={handleDateRangeChange}>
                  Apply range
                </button>
                {hasFinancialData && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      exportCSV(
                        financialReport.data,
                        [
                          { key: 'period', label: 'Period' },
                          { key: 'total_revenue', label: 'Revenue' },
                          { key: 'total_expenses', label: 'Expenses' },
                          { key: 'profit', label: 'Profit' },
                          { key: 'reconciled_days', label: 'Reconciled Days' }
                        ],
                        `financial-${dateRange.start}-${dateRange.end}.csv`,
                        csvBranchLabel
                      )
                    }
                  >
                    Export CSV
                  </button>
                )}
              </div>
            </div>
            <p className="reports-period-meta">
              {dateRange.start} → {dateRange.end} ·{' '}
              {reportPeriod === 'month' ? 'Monthly business totals (reconciled days in each bucket)' : reportPeriod === 'week' ? 'Weekly rollups' : 'Daily columns'}{' '}
              — {financialSummaryLine}
            </p>
          </section>

          <section className="reports-kpi-strip" aria-label="Period KPIs">
            <div className="reports-kpi reports-kpi--revenue">
              <span className="reports-kpi-label">Revenue (reconciled)</span>
              <span className="reports-kpi-value">{formatTSh(financialReport?.totals?.total_revenue)}</span>
            </div>
            <div className="reports-kpi reports-kpi--expense">
              <span className="reports-kpi-label">Expenses</span>
              <span className="reports-kpi-value">{formatTSh(financialReport?.totals?.total_expenses)}</span>
            </div>
            <div className="reports-kpi reports-kpi--profit">
              <span className="reports-kpi-label">Profit</span>
              <span className="reports-kpi-value">{formatTSh(financialReport?.totals?.total_profit)}</span>
            </div>
            <div className="reports-kpi">
              <span className="reports-kpi-label">Orders (period)</span>
              <span className="reports-kpi-value">{salesPeriodTotals.orders.toLocaleString()}</span>
            </div>
            <div className="reports-kpi">
              <span className="reports-kpi-label">Sales revenue</span>
              <span className="reports-kpi-value">{formatTSh(salesPeriodTotals.revenue)}</span>
            </div>
            {canViewBankDeposits && (
              <div className="reports-kpi reports-kpi--bank">
                <span className="reports-kpi-label">Bank deposits</span>
                <span className="reports-kpi-value">{formatTSh(bankDepositsTotal)}</span>
                <span className="reports-kpi-foot">{bankDeposits.length} transfer{bankDeposits.length === 1 ? '' : 's'}</span>
              </div>
            )}
            <div className="reports-kpi">
              <span className="reports-kpi-label">Reconciled rows</span>
              <span className="reports-kpi-value">{reconciledRowsCount}</span>
              <span className="reports-kpi-foot">daily summaries</span>
            </div>
          </section>

          {financialReport?.totals && (financialReport.totals.cash_revenue > 0 || financialReport.totals.book_revenue > 0 || financialReport.totals.digital_revenue > 0) && (
            <section className="reports-panel reports-panel--mix" aria-label="Revenue by payment channel">
              <h2 className="reports-panel-heading">Revenue mix (reconciled)</h2>
              <div className="reports-mix-grid">
                <div className="reports-mix-item">
                  <span>Cash</span>
                  <strong>{formatTSh(financialReport.totals.cash_revenue)}</strong>
                </div>
                <div className="reports-mix-item">
                  <span>Book / credit</span>
                  <strong>{formatTSh(financialReport.totals.book_revenue)}</strong>
                </div>
                <div className="reports-mix-item">
                  <span>Card / M-Pesa</span>
                  <strong>{formatTSh(financialReport.totals.digital_revenue)}</strong>
                </div>
              </div>
            </section>
          )}

          {reportPeriod === 'month' && hasFinancialData && (
            <section className="reports-panel reports-panel--monthly" aria-label="Monthly summary">
              <h2 className="reports-panel-heading">Monthly business summary</h2>
              <p className="reports-panel-lead">
                Each column is one calendar month of <strong>reconciled</strong> daily cash data in the current branch scope. Use this for board-level revenue and cost trends.
              </p>
              <div className="reports-monthly-cards">
                {financialReport.data.slice(0, 12).map((row, idx) => (
                  <div key={idx} className="reports-month-card">
                    <div className="reports-month-card-period">{row.period}</div>
                    <div className="reports-month-card-metric">
                      <span>Revenue</span>
                      <strong>{formatTSh(row.total_revenue)}</strong>
                    </div>
                    <div className="reports-month-card-metric">
                      <span>Profit</span>
                      <strong className={parseFloat(row.profit || 0) >= 0 ? 'pos' : 'neg'}>{formatTSh(row.profit)}</strong>
                    </div>
                    <div className="reports-month-card-foot">
                      {row.reconciled_days > 0 ? `${row.reconciled_days} rec. days` : '—'}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="reports-split-layout">
            {branchPerformance.length > 0 && (
              <section className="reports-panel reports-panel--branch" aria-label="Branch comparison">
                <h2 className="reports-panel-heading">Branch comparison</h2>
                <p className="reports-panel-lead">Totals from reconciled daily summaries in this date range (per branch).</p>
                <div className="table-wrapper interactive-scroll-region" tabIndex={0} role="region" {...tableScrollHandlers}>
                  <table className="reports-table-pro">
                    <thead>
                      <tr>
                        <th scope="col">Branch</th>
                        <th scope="col" className="num">Revenue</th>
                        <th scope="col" className="num">Expenses</th>
                        <th scope="col" className="num">Profit</th>
                        <th scope="col" className="num">Rec. days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {branchPerformance.map((b) => (
                        <tr key={b.branch_id}>
                          <td>{b.branch_name}</td>
                          <td className="num">{formatTSh(b.revenue)}</td>
                          <td className="num">{formatTSh(b.expenses)}</td>
                          <td className="num">
                            <span className={b.profit >= 0 ? 'reports-num-pos' : 'reports-num-neg'}>{formatTSh(b.profit)}</span>
                          </td>
                          <td className="num">
                            {b.reconciled_days}/{b.days}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {canViewBankDeposits && (
              <section className="reports-panel reports-panel--deposits" aria-label="Bank deposits">
                <h2 className="reports-panel-heading">Bank deposits</h2>
                <p className="reports-panel-lead">
                  Cash banked in the selected range ({formatTSh(bankDepositsTotal)} total). Recorded in Cash Management → Bank deposits.
                </p>
                {bankDeposits.length > 0 ? (
                  <div className="table-wrapper interactive-scroll-region" tabIndex={0} role="region" {...tableScrollHandlers}>
                    <table className="reports-table-pro reports-table-pro--compact">
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col">Account</th>
                          <th scope="col" className="num">Amount</th>
                          <th scope="col">Reference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bankDeposits.slice(0, 25).map((d) => (
                          <tr key={d.id}>
                            <td>{d.date}</td>
                            <td>{d.bank_account_name || d.bank_name || '—'}</td>
                            <td className="num">{formatTSh(d.amount)}</td>
                            <td className="reports-cell-muted">{d.reference_number || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {bankDeposits.length > 25 && (
                      <p className="reports-table-cap">Showing 25 of {bankDeposits.length} deposits — narrow the date range if needed.</p>
                    )}
                  </div>
                ) : (
                  <p className="reports-empty-inline">No bank deposits in this period for the current scope.</p>
                )}
              </section>
            )}
          </div>

          <div className="reports-financial-block">
            <h2 className="reports-section-title">Financial report (reconciled)</h2>
            <p className="report-summary-line report-summary-line--muted">{financialSummaryLine}</p>

            {hasFinancialData && (
              <div className="table-wrapper interactive-scroll-region" style={{ marginTop: '16px' }} tabIndex={0} role="region" aria-label="Financial report table" {...tableScrollHandlers}>
                <table className="reports-table-pro" aria-label="Financial report by period">
                  <caption className="sr-only">Financial report by period: revenue, expenses, profit, reconciled days</caption>
                  <thead>
                    <tr>
                      <th scope="col">Period</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Revenue</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Expenses</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Profit</th>
                      <th scope="col" style={{ textAlign: 'center' }}>Reconciled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {financialReport.data.map((row, idx) => (
                      <tr key={idx}>
                        <td>{row.period}</td>
                        <td style={{ textAlign: 'right', color: 'var(--primary-color)' }}>
                          {formatTSh(row.total_revenue)}
                        </td>
                        <td style={{ textAlign: 'right', color: '#f44336' }}>{formatTSh(row.total_expenses)}</td>
                        <td style={{ textAlign: 'right', color: parseFloat(row.profit || 0) >= 0 ? '#4caf50' : '#f44336', fontWeight: 'bold' }}>
                          {formatTSh(row.profit)}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {row.reconciled_days > 0 ? `✅ ${row.reconciled_days}/${row.days_count}` : '❌'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!hasFinancialData && (
              <p className="empty-state empty-state--explained">
                No reconciled data for this period. Close and reconcile days in <strong>Cash Management</strong> to see revenue, expenses and profit here.
              </p>
            )}
          </div>

          {/* Daily Profit section */}
          <div className="reports-panel reports-panel--daily">
            <h2 className="reports-panel-heading reports-panel-heading--row">
              <span>Daily profit (reconciled detail)</span>
              <button
                type="button"
                className="collapse-btn"
                onClick={() => toggleSection('dailyProfit')}
                aria-expanded={expandedSections.dailyProfit}
              >
                {expandedSections.dailyProfit ? '▼' : '▶'}
              </button>
            </h2>
            {expandedSections.dailyProfit && (
              <>
                {isAdmin && (
                  <p className="reports-admin-unreconcile-hint">
                    <strong>Admin:</strong> Reconciled days that still need corrections (missing expense, cash payment, book sale, etc.) can be{' '}
                    <strong>unlocked</strong> with <em>Reverse</em> so the branch fixes Cash Management and reconciles again.
                  </p>
                )}
                {hasProfitData && profitChartData.length > 0 && (
                  <ChartErrorBoundary>
                    <Suspense fallback={reportsChartSuspenseFallback}>
                      <ReportsCharts
                        variant="profit"
                        profitChartData={profitChartData}
                        chartColors={chartColors}
                        formatTSh={formatTSh}
                      />
                    </Suspense>
                  </ChartErrorBoundary>
                )}
                {hasProfitData ? (
                  <div className="table-wrapper interactive-scroll-region" tabIndex={0} role="region" aria-label="Daily profit table" {...tableScrollHandlers}>
                    <table className="reports-table-pro reports-table-pro--compact" aria-label="Daily profit by date">
                      <caption className="sr-only">Daily profit: date, revenue, expenses, profit</caption>
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col">Branch</th>
                          <th scope="col" className="reports-th-center">Status</th>
                          <th scope="col" className="num">Revenue</th>
                          <th scope="col" className="num">Expenses</th>
                          <th scope="col" className="num">Profit</th>
                          {isAdmin && <th scope="col" className="reports-th-center">Admin</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {profitReport.slice(0, 31).map((row, idx) => (
                          <tr key={`${row.date}-${row.branch_id ?? 'x'}-${idx}`}>
                            <td>{row.date}</td>
                            <td>{row.branch_name || (row.branch_id != null ? `Branch ${row.branch_id}` : '—')}</td>
                            <td style={{ textAlign: 'center' }}>
                              {isProfitRowReconciled(row) ? (
                                <span className="reports-reconciled-pill" title="Locked — use Reverse (admin) to allow edits">
                                  Reconciled
                                </span>
                              ) : (
                                <span className="reports-pending-pill">Open</span>
                              )}
                            </td>
                            <td style={{ textAlign: 'right', color: 'var(--primary-color)' }}>{formatTSh(row.revenue)}</td>
                            <td style={{ textAlign: 'right', color: '#f44336' }}>{formatTSh(row.expenses)}</td>
                            <td style={{ textAlign: 'right', color: parseFloat(row.profit || 0) >= 0 ? '#4caf50' : '#f44336', fontWeight: 'bold' }}>
                              {formatTSh(row.profit)}
                            </td>
                            {isAdmin && (
                              <td style={{ textAlign: 'center' }}>
                                {isProfitRowReconciled(row) ? (
                                  <button
                                    type="button"
                                    className="btn-secondary reports-reverse-btn"
                                    onClick={() => openUnreconcileModal(row)}
                                    title="Unlock this day for the branch so they can correct entries"
                                  >
                                    Reverse
                                  </button>
                                ) : (
                                  <span className="reports-muted-dash">—</span>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="empty-state empty-state--explained">
                    No daily profit data. Reconcile days in Cash Management to see daily revenue, expenses and profit.
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}

      {activeTab !== 'overview' && tabLoading && !loadedTabs[activeTab] && (
        <div className="reports-tab-skeleton" role="status" aria-live="polite">
          <Loader message={`Loading ${activeTab} data…`} fullPage={false} />
        </div>
      )}

      {activeTab !== 'overview' && (
        <p className="reports-period-banner">
          Period: <strong>{periodRangeLabel}</strong> · Scope: <strong>{scopeLabel}</strong>
          {' '}— change dates on the <button type="button" className="reports-inline-link" onClick={() => handleTabSwitch('overview')}>Overview</button> tab.
        </p>
      )}

      {activeTab === 'sales' && loadedTabs.sales && (
        <section className="reports-panel reports-panel--sales" aria-label="Sales report">
          <p className="reports-live-line" aria-live="polite">{salesSummaryLine}</p>
          <p className="reports-panel-lead">Uses the same date range as Overview (apply range there first).</p>
          <h2 className="reports-panel-heading reports-panel-heading--row">
            <span>Sales by date</span>
            <button
              type="button"
              className="collapse-btn"
              onClick={() => toggleSection('sales')}
              aria-expanded={expandedSections.sales}
            >
              {expandedSections.sales ? '▼' : '▶'}
            </button>
          </h2>
          {expandedSections.sales && (
            <>
              {hasSalesData && salesChartData.length > 0 && (
                <ChartErrorBoundary>
                  <Suspense fallback={reportsChartSuspenseFallback}>
                    <ReportsCharts variant="sales" salesChartData={salesChartData} formatTSh={formatTSh} />
                  </Suspense>
                </ChartErrorBoundary>
              )}
              <div className="table-wrapper interactive-scroll-region" tabIndex={0} role="region" aria-label="Sales report table" {...tableScrollHandlers}>
                {hasSalesData ? (
                  <>
                    <table className="reports-table-pro reports-table-pro--compact" aria-label="Sales by date">
                      <caption className="sr-only">Sales by date: orders, revenue, collected, pending, ready</caption>
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col" className="num">Orders</th>
                          <th scope="col" className="num">Total revenue</th>
                          <th scope="col" className="num">Collected</th>
                          <th scope="col" className="num">Pending</th>
                          <th scope="col" className="num">Ready</th>
                        </tr>
                      </thead>
                      <tbody>
                        {salesReport.map((day) => (
                          <tr key={day.date}>
                            <td>{new Date(day.date).toLocaleDateString('en-GB')}</td>
                            <td className="num">{day.total_orders}</td>
                            <td className="num">{formatTSh(day.total_revenue)}</td>
                            <td className="num">{formatTSh(day.collected_revenue)}</td>
                            <td className="num">{day.pending_orders}</td>
                            <td className="num">{day.ready_orders}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="reports-export-row">
                      <button
                        type="button"
                        className="btn-secondary btn-export"
                        onClick={() =>
                          exportCSV(
                            salesReport,
                            [
                              { key: 'date', label: 'Date' },
                              { key: 'total_orders', label: 'Orders' },
                              { key: 'total_revenue', label: 'Total Revenue' },
                              { key: 'collected_revenue', label: 'Collected' },
                              { key: 'pending_orders', label: 'Pending' },
                              { key: 'ready_orders', label: 'Ready' }
                            ],
                            `sales-${dateRange.start}-${dateRange.end}.csv`,
                            csvBranchLabel
                          )
                        }
                      >
                        Export CSV
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="empty-state empty-state--explained">
                    No sales data for this period. Select a date range in Overview or ensure orders exist for the period.
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {activeTab === 'services' && loadedTabs.services && (
        <section className="reports-panel reports-panel--services" aria-label="Services report">
          <p className="reports-live-line" aria-live="polite">{servicesSummaryLine}</p>
          <p className="reports-panel-lead">Uses the same date range as Overview.</p>
          <h2 className="reports-panel-heading reports-panel-heading--row">
            <span>Service performance</span>
            <button
              type="button"
              className="collapse-btn"
              onClick={() => toggleSection('services')}
              aria-expanded={expandedSections.services}
            >
              {expandedSections.services ? '▼' : '▶'}
            </button>
          </h2>
          {expandedSections.services && (
            <>
              {hasServiceData && serviceChartData.length > 0 && (
                <ChartErrorBoundary>
                  <Suspense fallback={reportsChartSuspenseFallback}>
                    <ReportsCharts variant="services" serviceChartData={serviceChartData} formatTSh={formatTSh} />
                  </Suspense>
                </ChartErrorBoundary>
              )}
              <div className="table-wrapper interactive-scroll-region" tabIndex={0} role="region" aria-label="Service report table" {...tableScrollHandlers}>
                {hasServiceData ? (
                  <>
                    <table className="reports-table-pro reports-table-pro--compact" aria-label="Service performance">
                      <caption className="sr-only">Service performance: orders, revenue, average order value</caption>
                      <thead>
                        <tr>
                          <th scope="col">Service</th>
                          <th scope="col" className="num">Orders</th>
                          <th scope="col" className="num">Total revenue</th>
                          <th scope="col" className="num">Avg order</th>
                        </tr>
                      </thead>
                      <tbody>
                        {serviceReport.map((service) => (
                          <tr key={service.service_name}>
                            <td>{service.service_name}</td>
                            <td className="num">{service.order_count ?? 0}</td>
                            <td className="num">{formatTSh(service.total_revenue)}</td>
                            <td className="num">{formatTSh(Math.round(service.average_order_value || 0))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="reports-export-row">
                      <button
                        type="button"
                        className="btn-secondary btn-export"
                        onClick={() =>
                          exportCSV(
                            serviceReport,
                            [
                              { key: 'service_name', label: 'Service' },
                              { key: 'order_count', label: 'Orders' },
                              { key: 'total_revenue', label: 'Total Revenue' },
                              { key: 'average_order_value', label: 'Avg Order Value' }
                            ],
                            `services-${dateRange.start}-${dateRange.end}.csv`,
                            csvBranchLabel
                          )
                        }
                      >
                        Export CSV
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="empty-state empty-state--explained">
                    No service data for this period. Ensure orders are linked to services and date range has orders.
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {activeTab === 'customers' && loadedTabs.customers && (
        <section className="reports-panel reports-panel--customers" aria-label="Customers loyalty report">
          <p className="reports-live-line" aria-live="polite">{customersSummaryLine}</p>
          <p className="reports-panel-lead">Filter by calendar month; independent of the Overview date range.</p>
          <h2 className="reports-panel-heading reports-panel-heading--row">
            <span>Top customers — loyalty</span>
            <button
              type="button"
              className="collapse-btn"
              onClick={() => toggleSection('customers')}
              aria-expanded={expandedSections.customers}
            >
              {expandedSections.customers ? '▼' : '▶'}
            </button>
          </h2>
          {expandedSections.customers && (
            <>
              <div className="reports-filter-bar">
                <select
                  value={customerFilter.month}
                  onChange={(e) => setCustomerFilter((prev) => ({ ...prev, month: parseInt(e.target.value, 10) }))}
                  aria-label="Month"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((mo) => (
                    <option key={mo} value={mo}>
                      {new Date(2000, mo - 1, 1).toLocaleString('en-GB', { month: 'long' })}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  inputMode="numeric"
                  value={customerFilter.year}
                  onChange={(e) => setCustomerFilter((prev) => ({ ...prev, year: parseInt(e.target.value, 10) || new Date().getFullYear() }))}
                  min="2020"
                  max="2099"
                  placeholder="Year"
                  aria-label="Year"
                />
                <button type="button" className="btn-primary" onClick={handleCustomerFilterChange}>
                  Filter
                </button>
                {hasCustomerData && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      exportCSV(
                        customerReport.slice(0, 50),
                        [
                          { key: 'name', label: 'Customer' },
                          { key: 'phone', label: 'Phone' },
                          { key: 'total_orders', label: 'Orders' },
                          { key: 'total_spent', label: 'Spent' },
                          { key: 'current_points', label: 'Points' },
                          { key: 'tier', label: 'Tier' },
                          { key: 'last_order_date', label: 'Last Order' }
                        ],
                        `customers-${customerFilter.year}-${customerFilter.month}.csv`,
                        csvBranchLabel
                      )
                    }
                  >
                    Export CSV
                  </button>
                )}
              </div>
              <div className="reports-info-banner">
                <strong>Loyalty points:</strong> 1 point per 20,000 TSh spent. 100 points = free wash worth 10,000 TSh
              </div>
              <div className="table-wrapper interactive-scroll-region" tabIndex={0} role="region" aria-label="Customer report table" {...tableScrollHandlers}>
                {hasCustomerData ? (
                  <table className="reports-table-pro reports-table-pro--compact" aria-label="Top customers loyalty">
                    <caption className="sr-only">Top customers by loyalty: orders, spent, points, tier, last order</caption>
                    <thead>
                      <tr>
                        <th scope="col">Customer</th>
                        <th scope="col" className="num">Orders</th>
                        <th scope="col" className="num">Spent</th>
                        <th scope="col">Points</th>
                        <th scope="col">Tier</th>
                        <th scope="col">Last order</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customerReport.slice(0, 20).map((customer) => (
                        <tr key={customer.id}>
                          <td>
                            <div className="customer-cell">
                              <strong>{customer.name}</strong>
                              <small>{customer.phone}</small>
                            </div>
                          </td>
                          <td className="num">{customer.total_orders ?? 0}</td>
                          <td className="num">{formatTSh(customer.total_spent)}</td>
                          <td>
                            <div className="points-cell">
                              <span className="points-display points-monthly">{customer.monthly_points_earned ?? 0} this month</span>
                              <span className="points-display points-current">{customer.current_points ?? 0} available</span>
                              <span className="points-lifetime">{customer.lifetime_points ?? 0} lifetime</span>
                            </div>
                          </td>
                          <td>
                            <span className={`badge-compact badge-tier-${(customer.tier || 'bronze').toLowerCase()}`}>
                              {customer.tier || 'Bronze'}
                            </span>
                          </td>
                          <td className="text-muted">
                            {customer.last_order_date
                              ? new Date(customer.last_order_date).toLocaleDateString('en-GB')
                              : 'N/A'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="empty-state empty-state--explained">
                    No customer data for this month. Customers appear here when they have orders or loyalty activity in the selected month.
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
};

export default Reports;
