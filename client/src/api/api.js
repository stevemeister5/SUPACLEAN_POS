import axios from 'axios';
import { addToQueue, getAllPending, removeFromQueue } from '../utils/offlineQueue';
import { getSyncCache, setSyncCache, isNetworkError, isOffline } from '../utils/syncCache';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 15000, // 15 second timeout
});

// Add request interceptor: auth token + branch context for admin (data isolation per branch)
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('sessionToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    const branchId = localStorage.getItem('selectedBranchId');
    if (branchId) {
      config.headers['X-Branch-Id'] = branchId;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor: error handling + offline queue for mutations
api.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error) => {
    const isNetworkError = !error.response && (error.request || error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED' ||
      /Network Error|Failed to fetch|timeout|ETIMEDOUT/i.test(error.message || ''));
    const method = error.config?.method?.toUpperCase();
    const isMutation = method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    // Queue mutations that failed due to network so they can sync when back online
    const requestUrl = String(error.config?.url || '');
    const isOrderCreate =
      requestUrl === '/orders' ||
      requestUrl === '/orders/batch' ||
      requestUrl.startsWith('/orders/batch');
    // Never queue order creates offline — retries duplicate lines and inflate receipt totals.
    if (isNetworkError && isMutation && error.config?.url && !isOrderCreate) {
      error.queuedForSync = true;
      try {
        await addToQueue(method, error.config.url, error.config.data ?? null);
      } catch (e) {
        console.warn('Offline queue add failed', e);
      }
    }

    const isTimeout = error.code === 'ECONNABORTED' || (error.message && /timeout|ETIMEDOUT/i.test(error.message));
    const isRefused = error.code === 'ECONNREFUSED' || (error.message && /Network Error|Failed to fetch/i.test(error.message));
    const raw = error.response?.data?.error || error.response?.data?.message || error.message || '';
    const isDbUnreachable = /getaddrinfo\s+ENOTFOUND|ENOTFOUND|pooler\.supabase|ECONNREFUSED.*54\d{2}/i.test(raw) ||
      (error.response?.status === 500 && /ENOTFOUND|supabase|postgres|getaddrinfo/i.test(String(raw)));

    if (isRefused) {
      error.message = 'Cannot connect to server. Make sure the backend is running (npm run dev) and reachable.';
    } else if (isTimeout) {
      error.message = 'Connection timed out. The server may be slow or unreachable. Check that the backend is running.';
    } else if (isDbUnreachable) {
      error.message = 'Database unreachable. Check your internet connection, DATABASE_URL in .env, and that Supabase is up. See SETUP_GUIDE.md → Troubleshooting.';
      error.isDatabaseUnreachable = true;
    } else if (error.response) {
      const rawStr = String(raw);
      if (/too many clients|maxclients|max.?client|connection limit|remaining connection slots|pool.*exhausted/i.test(rawStr)) {
        error.message =
          'The database hit a temporary connection limit. Wait a few seconds and try again, or ask your host to raise the pool size.';
      } else if (/quota|exceeded|storage.*full|QuotaExceeded/i.test(rawStr)) {
        error.message =
          'Browser storage is full. Clear site data for this app or use another browser tab, then try again.';
      } else {
        error.message = raw || error.message;
      }
    } else if (error.request) {
      error.message = 'No response from server. Ensure the backend is running (npm run dev) and the API URL is correct.';
    }
    return Promise.reject(error);
  }
);

// Export default for use in components
export default api;

// Sync pending offline actions when back online (backup/sync)
export async function syncPendingActions({ onProgress } = {}) {
  const pending = await getAllPending();
  let synced = 0;
  let failed = 0;
  for (const item of pending) {
    try {
      await api.request({
        method: item.method,
        url: item.url,
        data: item.body ?? undefined
      });
      await removeFromQueue(item.id);
      synced++;
      onProgress?.({ synced, total: pending.length, last: item });
    } catch (err) {
      console.warn('Sync failed for queued action', item.id, err);
      failed++;
    }
  }
  return { synced, failed, total: pending.length };
}

// Helper to check server connection
export const checkServerConnection = async () => {
  try {
    const response = await api.get('/health');
    return { connected: true, data: response.data };
  } catch (error) {
    return { 
      connected: false, 
      error: error.message || 'Cannot connect to server',
      details: error.code === 'ECONNREFUSED' 
        ? 'Server is not running on port 5000'
        : error.message
    };
  }
};

// Customers (offline-first: use cache when offline so loading doesn't hang)
// options: { limit, offset, light } – light=1 skips balance calc for faster load
export async function getCustomers(search = '', options = {}) {
  const { limit = 50, offset = 0, light = true } = options;
  if (isOffline()) {
    try {
      const cached = await getSyncCache('customers');
      if (cached && Array.isArray(cached.data)) {
        let data = cached.data;
        if (String(search).trim()) {
          const s = String(search).trim().toLowerCase();
          data = data.filter(
            (c) =>
              (c.name && c.name.toLowerCase().includes(s)) ||
              (c.phone && String(c.phone).includes(s)) ||
              (c.email && c.email.toLowerCase().includes(s))
          );
        }
        const start = offset;
        const end = start + limit;
        return { data: data.slice(start, end), fromCache: true, syncedAt: cached.syncedAt, hasMore: data.length > end };
      }
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (light) params.set('light', '1');
  try {
    const res = await api.get(`/customers?${params.toString()}`);
    const data = res.data || [];
    if (data.length > 0) await setSyncCache('customers', data);
    return { ...res, data, hasMore: data.length === limit };
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('customers');
        if (cached && Array.isArray(cached.data)) {
          let data = cached.data;
          if (String(search).trim()) {
            const s = String(search).trim().toLowerCase();
            data = data.filter(
              (c) =>
                (c.name && c.name.toLowerCase().includes(s)) ||
                (c.phone && String(c.phone).includes(s)) ||
                (c.email && c.email.toLowerCase().includes(s))
            );
          }
          return { data, fromCache: true, syncedAt: cached.syncedAt };
        }
      } catch (e) {}
    }
    throw err;
  }
}

/** Fast typeahead for New Order / Collection autocomplete */
export async function searchCustomers(q, options = {}) {
  const term = String(q || '').trim();
  if (term.length < 2) {
    return { data: [] };
  }
  const limit = options.limit || 15;
  if (isOffline()) {
    try {
      const cached = await getSyncCache('customers');
      if (cached && Array.isArray(cached.data)) {
        const s = term.toLowerCase();
        const data = cached.data
          .filter(
            (c) =>
              (c.name && c.name.toLowerCase().includes(s)) ||
              (c.phone && String(c.phone).includes(term))
          )
          .slice(0, limit);
        return { data, fromCache: true };
      }
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  const params = new URLSearchParams({ q: term, limit: String(limit) });
  return api.get(`/customers/search?${params.toString()}`);
}

export const getCustomer = (id) => api.get(`/customers/${id}`);
export const createCustomer = (data) => api.post('/customers', data);
export const updateCustomer = (id, data) => api.put(`/customers/${id}`, data);
export const getCustomerOrders = (id) => api.get(`/customers/${id}/orders`);
export const uploadCustomersExcel = (formData) => api.post('/customers/upload-excel', formData, {
  headers: {
    'Content-Type': 'multipart/form-data'
  }
});
export const sendBalanceReminder = (customerId, channels = ['sms']) => api.post(`/customers/${customerId}/send-balance-reminder`, { channels });

/** SMS provider config and setup hints. */
export const getSmsStatus = () => api.get('/sms-status');

// Services (offline-first)
export async function getServices(includeInactive = false) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('services');
      if (cached && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get(`/services?include_inactive=${includeInactive}`);
    await setSyncCache('services', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('services');
        if (cached && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const getService = (id) => api.get(`/services/${id}`);
export const createService = (data) => api.post('/services', data);
export const updateService = (id, data) => api.put(`/services/${id}`, data);

// Items (offline-first)
export async function getItems(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('items');
      if (cached && Array.isArray(cached.data)) {
        let data = cached.data;
        const cat = params && params.category;
        if (cat && cat !== 'all') data = data.filter((i) => (i.category || 'general') === cat);
        return { data, fromCache: true, syncedAt: cached.syncedAt };
      }
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/items', { params });
    await setSyncCache('items', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('items');
        if (cached && Array.isArray(cached.data)) {
          let data = cached.data;
          const cat = params && params.category;
          if (cat && cat !== 'all') data = data.filter((i) => (i.category || 'general') === cat);
          return { data, fromCache: true, syncedAt: cached.syncedAt };
        }
      } catch (e) {}
    }
    throw err;
  }
}
export const getItem = (id) => api.get(`/items/${id}`);
export const getItemsByCategory = (category) => api.get(`/items/category/${category}`);
export const createItem = (data) => api.post('/items', data);
export const updateItem = (id, data) => api.put(`/items/${id}`, data);
export const getBranchItemPrice = (itemId, branchId) => api.get(`/items/${itemId}/branch-price/${branchId}`);
export const setBranchItemPrice = (itemId, branchId, price) => api.post(`/items/${itemId}/branch-price/${branchId}`, { price });
export const deleteBranchItemPrice = (itemId, branchId) => api.delete(`/items/${itemId}/branch-price/${branchId}`);

// Orders (offline-first)
export async function getOrders(params = {}) {
  const key = params.status === 'pending' ? 'orders_pending' : params.status === 'ready' ? 'orders_ready' : 'orders_list';
  if (isOffline()) {
    try {
      const cached = await getSyncCache(key);
      if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/orders', { params });
    await setSyncCache(key, res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache(key);
        if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const getOrderDashboardStats = () => api.get('/orders/dashboard-stats');
export const searchOrdersByCustomer = (params = {}) => api.get('/orders/search/customer', { params });
export const getReceiptQRCode = (receiptNumber) => api.get(`/orders/receipt/${receiptNumber}/qrcode`);
export const getOrder = (id) => api.get(`/orders/${id}`);
export const getOrderByReceipt = (receiptNumber) => api.get(`/orders/receipt/${receiptNumber}`);
// Partial receipt search for the Collection page (matches any part of the receipt number)
export const searchReceipts = (q) => api.get('/orders/search/receipt', { params: { q } });
export const generateReceiptNumber = (forDate = null, branchId = null) =>
  api.get('/orders/generate-receipt-number', {
    params: {
      ...(forDate ? { for_date: forDate } : {}),
      ...(branchId != null && branchId !== '' ? { branch_id: branchId } : {}),
    },
  });
export const createOrder = (data, options = {}) => {
  const headers = {};
  const key = options.idempotencyKey || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null);
  if (key) headers['Idempotency-Key'] = key;
  return api.post('/orders', data, Object.keys(headers).length ? { headers } : undefined);
};
export const createOrderBatch = (data, options = {}) => {
  const headers = {};
  const key = options.idempotencyKey || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null);
  if (key) headers['Idempotency-Key'] = key;
  return api.post('/orders/batch', data, Object.keys(headers).length ? { headers } : undefined);
};
export const sendReceiptSms = (receiptNumber) => api.post(`/orders/receipt/${encodeURIComponent(receiptNumber)}/send-receipt-sms`);
export const updateOrderStatus = (id, status) => api.put(`/orders/${id}/status`, { status });
export const updateEstimatedCollectionDate = (id, estimated_collection_date) => api.put(`/orders/${id}/estimated-collection-date`, { estimated_collection_date });
export const collectOrder = (receiptNumber, paymentData = {}) => api.post(`/orders/collect/${receiptNumber}`, paymentData);
export const receivePayment = (orderId, paymentData) => api.post(`/orders/${orderId}/receive-payment`, paymentData);
export const voidOrderReceipt = (receiptNumber, data = {}) =>
  api.post(`/orders/receipt/${encodeURIComponent(receiptNumber)}/void`, data);
export const requestVoidOrderReceipt = (receiptNumber, data = {}) =>
  api.post(`/orders/receipt/${encodeURIComponent(receiptNumber)}/void-request`, data);
export const getVoidOrderRequest = (receiptNumber) =>
  api.get(`/orders/receipt/${encodeURIComponent(receiptNumber)}/void-request`);
export const getPendingVoidRequests = (params = {}) =>
  api.get('/orders/void-requests/pending', { params });
export const archiveOldOrders = (data = {}) => api.post('/orders/archive-old', data);

export const getAdminInbox = (params = {}) => api.get('/admin/inbox', { params });
export const getAdminInboxCounts = (params = {}) => api.get('/admin/inbox/counts', { params });
export const markAdminInboxRead = (id) => api.post(`/admin/inbox/${id}/read`);
export const dismissAdminInboxItem = (id) => api.post(`/admin/inbox/${id}/dismiss`);
export const approveAdminInboxItem = (id, data = {}) => api.post(`/admin/inbox/${id}/approve`, data);
export const rejectAdminInboxItem = (id, data = {}) => api.post(`/admin/inbox/${id}/reject`, data);
export async function getCollectionQueue(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('collection_queue');
      if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/orders/collection-queue', { params });
    await setSyncCache('collection_queue', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('collection_queue');
        if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
// Stock import runs many DB rows sequentially; 15s default axios timeout is too low on slow networks / cold Render.
export const uploadStockExcel = (formData) =>
  api.post('/orders/upload-stock-excel', formData, {
    headers: {
      'Content-Type': 'multipart/form-data'
    },
    timeout: 300000 // 5 minutes
  });
export const updateOrderCustomerPhone = (customerId, phone) =>
  api.patch(`/orders/customer/${customerId}/phone`, { phone });
export const getOrderItemPhotos = (orderId) => api.get('/order-item-photos', { params: { order_id: orderId } });
export const uploadOrderItemPhoto = (orderId, file, caption) => {
  const fd = new FormData();
  fd.append('order_id', String(orderId));
  fd.append('photo', file);
  if (caption) fd.append('caption', caption);
  return api.post('/order-item-photos/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
};
export const sendCollectionReminder = (orderId, channels = ['sms']) => api.post(`/orders/${orderId}/send-reminder`, { channels });

// Delivery Notes (legacy)
export const getDeliveryNotes = (params = {}) => api.get('/delivery-notes', { params });
export const getDeliveryNote = (id) => api.get(`/delivery-notes/${id}`);
export const createDeliveryNote = (data) => api.post('/delivery-notes', data);
export const updateDeliveryNote = (id, data) => api.put(`/delivery-notes/${id}`, data);
export const deleteDeliveryNote = (id) => api.delete(`/delivery-notes/${id}`);

// Bills (offline-first)
export async function getBills(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('bills');
      if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/bills', { params });
    await setSyncCache('bills', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('bills');
        if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const getBill = (id) => api.get(`/bills/${id}`);
export const createBill = (data) => api.post('/bills', data);

// Cleaning services (independent from laundry – own customers, payments, expenses)
export const getCleaningDocuments = (params = {}) => api.get('/cleaning-documents', { params });
export const getCleaningDocument = (id) => api.get(`/cleaning-documents/${id}`);
export const createCleaningDocument = (data) => api.post('/cleaning-documents', data);
export const getCleaningFinancialSummary = (params = {}) => api.get('/cleaning-documents/financial-summary', { params });
export const recordCleaningPayment = (documentId, data) => api.post(`/cleaning-documents/${documentId}/payments`, data);
export const getCleaningCustomers = () => api.get('/cleaning-customers');
export const createCleaningCustomer = (data) => api.post('/cleaning-customers', data);
export const getCleaningExpenses = (params = {}) => api.get('/cleaning-expenses', { params });
export const getCleaningExpenseCategories = () => api.get('/cleaning-expenses/categories');
export const createCleaningExpense = (data) => api.post('/cleaning-expenses', data);

// Customers quick-add (name, phone, TIN, VRN for billing)
export const quickAddCustomer = (data) => api.post('/customers/quick-add', data);

// Invoices (offline-first)
export async function getInvoices(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('invoices');
      if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/invoices', { params });
    await setSyncCache('invoices', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('invoices');
        if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export async function getInvoicesOverdue() {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('invoices_overdue');
      if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/invoices/overdue');
    await setSyncCache('invoices_overdue', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('invoices_overdue');
        if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const getInvoice = (id) => api.get(`/invoices/${id}`);
export const createInvoice = (data) => api.post('/invoices', data);
export const recordInvoicePayment = (id, data) => api.post(`/invoices/${id}/payments`, data);
export const getInvoicePayments = (id) => api.get(`/invoices/${id}/payments`);

// Transactions (offline-first)
export async function getTransactions(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('transactions');
      if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/transactions', { params });
    await setSyncCache('transactions', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('transactions');
        if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export async function getDailySummary(date) {
  const emptySummary = { data: { total_income: 0, cash_income: 0, total_transactions: 0, total_expenses: 0, net_income: 0 } };
  if (isOffline()) {
    try {
      const cached = await getSyncCache('daily_summary');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return emptySummary;
    } catch (e) {
      return emptySummary;
    }
  }
  try {
    const res = await api.get('/transactions/daily-summary', { params: { date } });
    await setSyncCache('daily_summary', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('daily_summary');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const createTransaction = (data) => api.post('/transactions', data);

// Reports (offline-first)
export async function getSalesReport(startDate, endDate) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('reports_sales');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  }
  try {
    const res = await api.get('/reports/sales', { params: { start_date: startDate, end_date: endDate } });
    await setSyncCache('reports_sales', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('reports_sales');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export async function getServiceReport(startDate, endDate) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('reports_services');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  }
  try {
    const res = await api.get('/reports/services', { params: { start_date: startDate, end_date: endDate } });
    await setSyncCache('reports_services', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('reports_services');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export async function getCustomerReport(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('reports_customers');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/reports/customers', { params });
    await setSyncCache('reports_customers', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('reports_customers');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const getMonthlyLoyaltyReport = (month, year) => api.get('/reports/loyalty/monthly', { params: { month, year } });
export async function getFinancialReport(startDate, endDate, period = 'day') {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('reports_financial');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  }
  try {
    const res = await api.get('/reports/financial', { params: { start_date: startDate, end_date: endDate, period } });
    await setSyncCache('reports_financial', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('reports_financial');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const getDailyProfitReport = (startDate, endDate) => api.get('/reports/profit/daily', { params: { start_date: startDate, end_date: endDate } });
export async function getOverviewReport(date) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('reports_overview');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  }
  try {
    const res = await api.get('/reports/overview', { params: { date } });
    await setSyncCache('reports_overview', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('reports_overview');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}

export async function getBusinessHealthReport(startDate, endDate) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('reports_business_health');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  }
  try {
    const res = await api.get('/reports/business-health', { params: { start_date: startDate, end_date: endDate } });
    await setSyncCache('reports_business_health', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('reports_business_health');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}

export const setReportsMonthlyTarget = (amount) =>
  api.put('/reports/monthly-target', { amount });

// Settings (offline-first)
export async function getSettings() {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('settings');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: {} };
    } catch (e) {
      return { data: {} };
    }
  }
  try {
    const res = await api.get('/settings');
    await setSyncCache('settings', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('settings');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const getSetting = (key) => api.get(`/settings/${key}`);
export const updateSetting = (key, data) => api.put(`/settings/${key}`, data);

// Expenses (offline-first)
export async function getExpenses(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('expenses');
      if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/expenses', { params });
    await setSyncCache('expenses', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('expenses');
        if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const getExpense = (id) => api.get(`/expenses/${id}`);
export const createExpense = (data) => api.post('/expenses', data);
export const updateExpense = (id, data) => api.put(`/expenses/${id}`, data);
export const deleteExpense = (id, body) =>
  body != null ? api.delete(`/expenses/${id}`, { data: body }) : api.delete(`/expenses/${id}`);
export const getExpenseCategories = () => api.get('/expenses/categories');
export const createExpenseCategory = (data) => api.post('/expenses/categories', data);
export async function getExpenseSummary(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('expenses_summary');
      if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/expenses/summary/by-category', { params });
    await setSyncCache('expenses_summary', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('expenses_summary');
        if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}

// Payroll
export const getPayrollEmployees = () => api.get('/payroll/employees');
export const getPayrollEmployeesForAdvances = () => api.get('/payroll/employees/for-advances');
export const createPayrollEmployee = (data) => api.post('/payroll/employees', data);
export const updatePayrollEmployee = (id, data) => api.put(`/payroll/employees/${id}`, data);
export const getSalaryAdvances = (params = {}) => api.get('/payroll/advances', { params });
export const createSalaryAdvance = (data) => api.post('/payroll/advances', data);
export const getMonthlyPayroll = (month) => api.get('/payroll/monthly', { params: { month } });
export const saveMonthlyPayroll = (payload) => api.post('/payroll/monthly/save', payload);
export const reopenPayrollMonth = (monthKey) => api.post('/payroll/monthly/reopen', { month_key: monthKey });
export const getSavedMonthlyPayroll = (month) => api.get('/payroll/monthly/saved', { params: { month } });
export const getPayrollHistory = (params = {}) => api.get('/payroll/history', { params });

// Cash Management (offline-first)
export async function getDailyCashSummary(date) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('cash_daily');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  }
  try {
    const res = await api.get(`/cash-management/daily/${date}`);
    await setSyncCache('cash_daily', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('cash_daily');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export async function getTodayCashSummary() {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('cash_today');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  }
  try {
    const res = await api.get('/cash-management/today');
    await setSyncCache('cash_today', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('cash_today');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const createDailyCashSummary = (data) => api.post('/cash-management/daily', data);
export const saveOpeningSession = (date, data) => api.post(`/cash-management/opening-session/${date}`, data);
/** Recompute daily closing from live data. Pass `{ force: true }` to refresh reconciled days (updates stored sales/closing, keeps lock). */
export const recalculateDailyCashForDate = (date, opts = {}) =>
  api.post(`/cash-management/daily/recalculate/${date}`, { force: !!opts.force });
/** Recompute from this date forward (all unreconciled days) — fixes bank deposit + opening/closing chain. */
export const refreshCashChainFromDate = (date) => api.post(`/cash-management/daily/refresh-chain/${date}`);
/** Line items that make up cash_sales / book_sales for a date (branch-scoped). */
export const getCashSalesDetailForDate = (date) =>
  api.get(`/cash-management/details/cash-sales/${date}`);
export const getBookSalesDetailForDate = (date) =>
  api.get(`/cash-management/details/book-sales/${date}`);
export const reconcileDailyCash = (date, data) => api.post(`/cash-management/reconcile/${date}`, data);
export const sendDailyClosingReport = (date, data = {}) => api.post(`/cash-management/send-report/${date}`, data);
/** Admin only: unlock a reconciled day so the branch can correct expenses/payments and reconcile again. */
export const unreconcileDailyCash = (date, data) => api.post(`/cash-management/unreconcile/${date}`, data);
export const getUnreconciledClosings = (params = {}) => api.get('/cash-management/unreconciled', { params });
export async function getCashSummaryRange(startDate, endDate) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('cash_range');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  }
  try {
    const res = await api.get('/cash-management/range', { params: { start_date: startDate, end_date: endDate } });
    await setSyncCache('cash_range', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('cash_range');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}

// Bank Deposits (offline-first)
export async function getBankDeposits(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('bank_deposits');
      if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/bank-deposits', { params });
    await setSyncCache('bank_deposits', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('bank_deposits');
        if (cached != null && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
// Bank accounts (admin: full list; others: active only for dropdown)
export const getBankAccounts = () => api.get('/bank-accounts');
export const getActiveBankAccounts = () => api.get('/bank-accounts/active');
export const createBankAccount = (data) => api.post('/bank-accounts', data);
export const updateBankAccount = (id, data) => api.put(`/bank-accounts/${id}`, data);
export const deleteBankAccount = (id) => api.delete(`/bank-accounts/${id}`);

export const getBankDeposit = (id) => api.get(`/bank-deposits/${id}`);
export const createBankDeposit = (data) => api.post('/bank-deposits', data);
export const updateBankDeposit = (id, data) => api.put(`/bank-deposits/${id}`, data);
export const deleteBankDeposit = (id) => api.delete(`/bank-deposits/${id}`);
export async function getBankDepositTotal(params = {}) {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('bank_deposits_total');
      if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  }
  try {
    const res = await api.get('/bank-deposits/summary/total', { params });
    await setSyncCache('bank_deposits_total', res.data);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('bank_deposits_total');
        if (cached != null && cached.data != null) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}

// Loyalty
export const getCustomerLoyalty = (customerId) => api.get(`/loyalty/customer/${customerId}`);
export const getLoyaltyTransactions = (customerId, limit = 50) => api.get(`/loyalty/customer/${customerId}/transactions`, { params: { limit } });
export const earnLoyaltyPoints = (customerId, orderId, orderAmount) => api.post('/loyalty/earn', { customerId, orderId, orderAmount });
export const redeemLoyaltyPoints = (customerId, points, orderId) => api.post('/loyalty/redeem', { customerId, points, orderId });
export const getLoyaltyRewards = () => api.get('/loyalty/rewards');
export const getLoyaltyTiers = () => api.get('/loyalty/tiers');

// Health check (shorter timeout so login page detects unreachable server quickly)
export const checkServerHealth = () => api.get('/health', { timeout: 5000 });
export const changePassword = (current_password, new_password) =>
  api.post('/auth/change-password', { current_password, new_password });

// Branches
// Branches (offline-first)
export async function getBranches() {
  if (isOffline()) {
    try {
      const cached = await getSyncCache('branches');
      if (cached && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      return { data: [] };
    } catch (e) {
      return { data: [] };
    }
  }
  try {
    const res = await api.get('/branches');
    await setSyncCache('branches', res.data || []);
    return res;
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        const cached = await getSyncCache('branches');
        if (cached && Array.isArray(cached.data)) return { data: cached.data, fromCache: true, syncedAt: cached.syncedAt };
      } catch (e) {}
    }
    throw err;
  }
}
export const getBranch = (id) => api.get(`/branches/${id}`);
export const createBranch = (data) => api.post('/branches', data);
export const updateBranch = (id, data) => api.put(`/branches/${id}`, data);
export const getBranchFeatures = (id) => api.get(`/branches/${id}/features`);
export const updateBranchFeatures = (id, features) => api.put(`/branches/${id}/features`, { features }, { timeout: 30000 });

// Users
export const getUsers = () => api.get('/users');
export const getUser = (id) => api.get(`/users/${id}`);
export const createUser = (data) => api.post('/users', data, { timeout: 45000 });
export const updateUser = (id, data) => api.put(`/users/${id}`, data, { timeout: 45000 });
export const deleteUser = (id) => api.delete(`/users/${id}`);
export const deleteUserPermanent = (id) => api.delete(`/users/${id}?permanent=true`);
export const resetUserPassword = (id, data = {}) => api.post(`/users/${id}/reset-password`, data, { timeout: 45000 });
export const downloadAuditExport = (params = {}) =>
  api.get('/admin/audit-export', { params: { format: 'csv', ...params }, responseType: 'blob', timeout: 60000 });

// Admin: clear all customers, orders, and related data (test data reset). Requires { confirm: 'CLEAR' }.
export const clearAllCustomerData = () => api.post('/admin/clear-customer-data', { confirm: 'CLEAR' });