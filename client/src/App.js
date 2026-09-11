import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Layout from './components/Layout';
import LegacyLayout from './components/layout-legacy/Layout';
import InstallPrompt from './components/InstallPrompt';
import Loader from './components/Loader';
import Login from './pages/Login';
import './App.css';

// Route-level code splitting: each page loads only when visited (smaller initial JS, faster first paint).
const Dashboard = lazy(() => import(/* webpackChunkName: "page-dashboard" */ './pages/Dashboard'));
const NewOrder = lazy(() => import(/* webpackChunkName: "page-new-order" */ './pages/NewOrder'));
const Orders = lazy(() => import(/* webpackChunkName: "page-orders" */ './pages/Orders'));
const Customers = lazy(() => import(/* webpackChunkName: "page-customers" */ './pages/Customers'));
const Collection = lazy(() => import(/* webpackChunkName: "page-collection" */ './pages/Collection'));
const Reports = lazy(() => import(/* webpackChunkName: "page-reports" */ './pages/Reports'));
const PriceList = lazy(() => import(/* webpackChunkName: "page-price-list" */ './pages/PriceList'));
const CashManagement = lazy(() => import(/* webpackChunkName: "page-cash" */ './pages/CashManagement'));
const Expenses = lazy(() => import(/* webpackChunkName: "page-expenses" */ './pages/Expenses'));
const AdminBranches = lazy(() => import(/* webpackChunkName: "page-admin-branches" */ './pages/AdminBranches'));
const AdminBanking = lazy(() => import(/* webpackChunkName: "page-admin-banking" */ './pages/AdminBanking'));
const MonthlyBilling = lazy(() => import(/* webpackChunkName: "page-billing" */ './pages/MonthlyBilling'));
const CleaningServices = lazy(() => import(/* webpackChunkName: "page-cleaning" */ './pages/CleaningServices'));
const Payroll = lazy(() => import(/* webpackChunkName: "page-payroll" */ './pages/Payroll'));
const Terms = lazy(() => import(/* webpackChunkName: "page-terms" */ './pages/Terms'));
const AdminSmsMarketing = lazy(() => import(/* webpackChunkName: "page-admin-sms-marketing" */ './pages/AdminSmsMarketing'));

class AppErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('App error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px 24px',
          maxWidth: '560px',
          margin: '40px auto',
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          border: '1px solid var(--border-color)',
          color: 'var(--text-primary)',
          textAlign: 'center'
        }}>
          <h1 style={{ marginBottom: '16px', fontSize: '20px' }}>Something went wrong</h1>
          <p style={{ marginBottom: '20px', color: 'var(--text-secondary)' }}>
            The page could not load. Try refreshing. If it continues, check the browser console for errors.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 20px',
              background: 'var(--primary-color)',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            Refresh page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Protected Route Component
const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, loading, verifySession, user } = useAuth();
  const hasStoredToken = typeof localStorage !== 'undefined' && !!localStorage.getItem('sessionToken');

  React.useEffect(() => {
    if (!isAuthenticated && hasStoredToken) {
      verifySession();
    }
  }, [hasStoredToken, isAuthenticated, verifySession]);

  if (loading || (!isAuthenticated && hasStoredToken)) {
    return <Loader message="Loading…" fullPage delayMs={0} />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user?.mustChangePassword) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

const legacyPosShell =
  process.env.REACT_APP_LEGACY_POS_SHELL === '1' ||
  process.env.REACT_APP_LEGACY_POS_SHELL === 'true';
const AppLayout = legacyPosShell ? LegacyLayout : Layout;

function App() {
  return (
    <ThemeProvider>
      <InstallPrompt />
      <AuthProvider>
        <AppErrorBoundary>
        <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Suspense fallback={<Loader message="Loading page…" fullPage delayMs={0} />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/terms" element={<Terms />} />
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <AppLayout>
                      <Routes>
                        <Route path="/" element={<Navigate to="/dashboard" replace />} />
                        <Route path="/dashboard" element={<Dashboard />} />
                        <Route path="/new-order" element={<NewOrder />} />
                        <Route path="/orders" element={<Orders />} />
                        <Route path="/customers" element={<Customers />} />
                        <Route path="/collection" element={<Collection />} />
                        <Route path="/price-list" element={<PriceList />} />
                        <Route path="/cash-management" element={<CashManagement />} />
                        <Route path="/expenses" element={<Expenses />} />
                        <Route path="/reports" element={<Reports />} />
                        <Route path="/monthly-billing" element={<MonthlyBilling />} />
                        <Route path="/payroll" element={<Payroll />} />
                        <Route path="/cleaning-services" element={<CleaningServices />} />
                        <Route path="/admin/branches" element={<AdminBranches />} />
                        <Route path="/admin/banking" element={<AdminBanking />} />
                        <Route path="/admin/sms-marketing" element={<AdminSmsMarketing />} />
                        <Route path="*" element={<Navigate to="/dashboard" replace />} />
                      </Routes>
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </Suspense>
        </Router>
        </AppErrorBoundary>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
