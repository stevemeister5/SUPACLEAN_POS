import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import api from '../api/api';

const AuthContext = createContext();
const AUTH_DEBUG = false;
const debugLog = (...args) => {
  if (AUTH_DEBUG) console.log(...args);
};

const STORAGE_VERSION = '2';
function ensureStorageVersion() {
  if (typeof localStorage === 'undefined') return;
  if (localStorage.getItem('app_storage_version') !== STORAGE_VERSION) {
    // Keep auth/session keys to avoid unexpected logout loops across deployments.
    // We only reset branch filter, which is safe to recompute.
    localStorage.removeItem('selectedBranchId');
    localStorage.setItem('app_storage_version', STORAGE_VERSION);
  }
}
ensureStorageVersion();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

function readCachedSessionUser() {
  try {
    const cached = localStorage.getItem('sessionUser');
    if (!cached) return null;
    return JSON.parse(cached);
  } catch (_) {
    return null;
  }
}

function writeCachedSessionUser(userData) {
  try {
    if (userData) localStorage.setItem('sessionUser', JSON.stringify(userData));
    else localStorage.removeItem('sessionUser');
  } catch (e) {
    console.warn('Could not cache session user', e);
  }
}

export const AuthProvider = ({ children }) => {
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem('sessionToken'));
  const [user, setUser] = useState(() => (localStorage.getItem('sessionToken') ? readCachedSessionUser() : null));
  const [branch, setBranch] = useState(() => {
    const cached = localStorage.getItem('sessionToken') ? readCachedSessionUser() : null;
    return cached?.branch ?? null;
  });
  const [loading, setLoading] = useState(true);
  const [selectedBranchId, setSelectedBranchIdState] = useState(() => {
    try {
      const s = localStorage.getItem('selectedBranchId');
      return s ? parseInt(s, 10) : null;
    } catch (_) { return null; }
  });
  const isLoggingInRef = useRef(false);
  const userRef = useRef(user);

  const setSelectedBranch = useCallback((branchId) => {
    const id = branchId == null ? null : (typeof branchId === 'number' ? branchId : parseInt(branchId, 10));
    setSelectedBranchIdState(Number.isNaN(id) ? null : id);
    if (id != null) localStorage.setItem('selectedBranchId', String(id));
    else localStorage.removeItem('selectedBranchId');
  }, []);

  const logout = useCallback(async () => {
    try {
      if (sessionToken) {
        await api.post('/auth/logout');
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setSessionToken(null);
      localStorage.removeItem('sessionToken');
      localStorage.removeItem('sessionUser');
      localStorage.removeItem('selectedBranchId');
      setUser(null);
      setBranch(null);
      setSelectedBranchIdState(null);
      userRef.current = null;
    }
  }, [sessionToken]);

  const verifySession = useCallback(async ({ allowCachedOnAuthFailure = true } = {}) => {
    // Skip verification if we're in the middle of logging in
    if (isLoggingInRef.current) {
      debugLog('⏸️ Skipping verifySession - login in progress');
      return;
    }

    const token = localStorage.getItem('sessionToken');
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      debugLog('🔍 Verifying session...');
      const response = await api.get('/auth/verify');
      if (response.data.valid) {
        const nextUser = response.data.user;
        debugLog('✅ Session valid:', nextUser.username);
        setUser(nextUser);
        setBranch(nextUser.branch ?? null);
        userRef.current = nextUser;
        writeCachedSessionUser(nextUser);
        setLoading(false);
      } else {
        debugLog('❌ Session invalid');
        logout();
      }
    } catch (error) {
      console.error('❌ Session verification failed:', error);
      if (!isLoggingInRef.current && error.response?.status === 401) {
        const parsed = allowCachedOnAuthFailure ? readCachedSessionUser() : null;
        // Never keep a forced password-change gate from a dead/expired session
        if (parsed && !parsed.mustChangePassword) {
          setUser(parsed);
          setBranch(parsed.branch ?? null);
          userRef.current = parsed;
          setLoading(false);
          debugLog('📴 Session re-check failed (401); using cached user so you can keep using the app.');
          return;
        }
        debugLog('🔒 Logging out due to 401');
        logout();
      } else if (!isLoggingInRef.current) {
        const parsed = readCachedSessionUser();
        if (parsed) {
          setUser(parsed);
          setBranch(parsed.branch ?? null);
          userRef.current = parsed;
          debugLog('📴 Offline mode: using cached user', parsed.username);
        }
        setLoading(false);
      }
    }
  }, [logout]);

  // Update ref when user changes
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Always re-verify when a token exists so mustChangePassword stays accurate after refresh/deploy
  useEffect(() => {
    if (isLoggingInRef.current) {
      debugLog('⏸️ useEffect: Skipping - login in progress');
      return;
    }

    if (sessionToken) {
      debugLog('🔍 useEffect: Verifying session for token');
      verifySession({ allowCachedOnAuthFailure: true });
    } else {
      debugLog('🚫 useEffect: No token, clearing state');
      setUser(null);
      setBranch(null);
      userRef.current = null;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  const login = async (username, password) => {
    // Set flag to prevent verifySession from running during login
    isLoggingInRef.current = true;
    setLoading(true);
    
    try {
      debugLog('🔐 Attempting login for:', username);
      const response = await api.post('/auth/login', { username, password });
      debugLog('✅ Login response:', response.data);
      
      if (response.data.success) {
        const token = response.data.sessionToken;
        const userData = response.data.user;
        
        debugLog('✅ Login successful, setting user state...');
        
        // Persist token and user immediately to avoid transient unauthenticated states
        // when route changes happen quickly after login.
        setSessionToken(token);
        localStorage.setItem('sessionToken', token);
        writeCachedSessionUser(userData);

        // Set user and branch (this updates userRef via useEffect)
        setUser(userData);
        setBranch(userData.branch);
        userRef.current = userData;
        setLoading(false);
        isLoggingInRef.current = false;
        debugLog('✅ Login complete');
        
        return { success: true, mustChangePassword: !!userData.mustChangePassword };
      } else {
        console.error('❌ Login failed - no success flag');
        isLoggingInRef.current = false;
        setLoading(false);
        return {
          success: false,
          error: response.data.error || 'Login failed'
        };
      }
    } catch (error) {
      console.error('❌ Login error:', error);
      console.error('Error details:', {
        message: error.message,
        code: error.code,
        response: error.response?.data,
        status: error.response?.status
      });

      isLoggingInRef.current = false;
      setLoading(false);

      if (error.isDatabaseUnreachable) {
        return { success: false, error: error.message, isDatabaseUnreachable: true };
      }
      if (error.response) {
        const msg = error.response.data?.error || error.response.data?.message;
        return {
          success: false,
          error: msg || `Server error: ${error.response.status} ${error.response.statusText || ''}`.trim()
        };
      }
      return {
        success: false,
        error: error.message || 'Login failed. Check your connection and try again.'
      };
    }
  };


  // Permission checking helpers
  const hasPermission = (permission) => {
    if (!user || !user.role) return false;
    
    const permissions = {
      admin: {
        canManageUsers: true,
        canManageBranches: true,
        canEditPrices: true,
        canViewAllBranches: true,
        canManageOrders: true,
        canCreateOrders: true,
        canCollect: true,
        canViewReports: true,
        canManageCash: true,
        canReconcile: true,
        canManageCustomers: true,
        canManageExpenses: true,
        canViewDashboard: true,
        canManagePayroll: true,
        canRecordSalaryAdvances: true,
      },
      manager: {
        canManageUsers: false,
        canManageBranches: false,
        canEditPrices: false,
        canViewAllBranches: false,
        canManageOrders: true,
        canCreateOrders: true,
        canCollect: true,
        canViewReports: true,
        canManageCash: true,
        canReconcile: true,
        canManageCustomers: true,
        canManageExpenses: true,
        canViewDashboard: true,
        canManagePayroll: false,
        canRecordSalaryAdvances: true,
      },
      cashier: {
        canManageUsers: false,
        canManageBranches: false,
        canEditPrices: false,
        canViewAllBranches: false,
        canManageOrders: false,
        canCreateOrders: true,
        canCollect: true,
        canViewReports: false,
        canManageCash: true,
        canReconcile: false,
        canManageCustomers: false,
        canManageExpenses: false,
        canViewDashboard: true,
        canManagePayroll: false,
        canRecordSalaryAdvances: true,
      },
      processor: {
        canManageUsers: false,
        canManageBranches: false,
        canEditPrices: false,
        canViewAllBranches: false,
        canManageOrders: true,
        canCreateOrders: false,
        canCollect: true,
        canViewReports: false,
        canManageCash: false,
        canReconcile: false,
        canManageCustomers: false,
        canManageExpenses: false,
        canViewDashboard: true,
        canManagePayroll: false,
        canRecordSalaryAdvances: false,
      }
    };
    
    return permissions[user.role]?.[permission] === true;
  };

  const clearMustChangePassword = () => {
    if (!user) return;
    const next = { ...user, mustChangePassword: false };
    setUser(next);
    userRef.current = next;
    writeCachedSessionUser(next);
  };

  const value = {
    user,
    branch,
    loading,
    login,
    logout,
    verifySession,
    clearMustChangePassword,
    isAuthenticated: !!user,
    isAdmin: user?.role === 'admin',
    isManager: user?.role === 'manager',
    isCashier: user?.role === 'cashier',
    isProcessor: user?.role === 'processor',
    hasPermission,
    selectedBranchId: user?.role === 'admin' ? selectedBranchId : (user?.branchId ?? null),
    setSelectedBranch: user?.role === 'admin' ? setSelectedBranch : () => {}
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
