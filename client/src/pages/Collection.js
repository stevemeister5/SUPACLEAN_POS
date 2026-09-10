import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getOrderByReceipt, collectOrder, receivePayment, searchCustomers, searchOrdersByCustomer, getCollectionQueue, searchReceipts } from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import { useListViewPreference } from '../hooks/useListViewPreference';
import ListViewToggle from '../components/ListViewToggle';
import Loader from '../components/Loader';
import { receiptWidthCss, receiptPadding, receiptFontSize, receiptCompactFontSize, termsQrSize, receiptBrandMargin, receiptBrandFontSize } from '../utils/receiptPrintConfig';
import { formatCustomerReceiptId, formatReceiptForDisplay, formatBranchReceiptLine } from '../utils/receiptId';
import { playSuccessSound } from '../utils/sound';
import OrderDetailsModal from '../components/OrderDetailsModal';
import './Collection.css';

const roundMoney = (x) => (typeof x !== 'number' || Number.isNaN(x) ? 0 : Math.round(x * 100) / 100);
const roundFigure = (x) => (typeof x !== 'number' || Number.isNaN(x) ? 0 : Math.round(x));
const todayYmd = () => new Date().toISOString().slice(0, 10);

function getReceiptTotals(order, allReceiptOrders) {
  const items = (allReceiptOrders && allReceiptOrders.length > 0) ? allReceiptOrders : (order ? [order] : []);
  const receiptTotal = roundMoney(
    order?.total_amount ?? items.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0)
  );
  const receiptPaid = roundMoney(
    order?.paid_amount !== undefined && order?.paid_amount !== null
      ? order.paid_amount
      : items.reduce((sum, o) => sum + (parseFloat(o.paid_amount) || 0), 0)
  );
  const balanceDue = roundMoney(receiptTotal - receiptPaid);
  return { receiptTotal, receiptPaid, balanceDue };
}

const formatReceiptMoney = (n) => (n != null && !Number.isNaN(n) ? `TSh ${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'TSh 0');

const Collection = () => {
  const [searchParams] = useSearchParams();
  const { showToast, ToastContainer } = useToast();
  const { branch } = useAuth();
  const [listView, setListView] = useListViewPreference();
  const [receiptNumber, setReceiptNumber] = useState(searchParams.get('receipt') || '');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [searchByPhone, setSearchByPhone] = useState(false);
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showQueue, setShowQueue] = useState(true);
  const [queueOrders, setQueueOrders] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showReceivePaymentModal, setShowReceivePaymentModal] = useState(false);
  const [showOrderDetailsModal, setShowOrderDetailsModal] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentDate, setPaymentDate] = useState(todayYmd());
  const [collecting, setCollecting] = useState(false);
  const [receivingPayment, setReceivingPayment] = useState(false);
  const [customerSearchResults, setCustomerSearchResults] = useState([]);
  const [showCustomerResults, setShowCustomerResults] = useState(false);
  const [allReceiptOrders, setAllReceiptOrders] = useState([]); // Store all orders for a receipt number
  const [searchedByCustomer, setSearchedByCustomer] = useState(false); // Track if search was by customer
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState([]);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [queueSearch, setQueueSearch] = useState('');
  const [queueSearchDebounced, setQueueSearchDebounced] = useState('');
  const [customerReceiptsList, setCustomerReceiptsList] = useState([]); // All receipts for current customer (when searched by customer)
  const [receiptSearchResults, setReceiptSearchResults] = useState([]); // Partial receipt search matches (Collection)
  const [showCollectConfirmModal, setShowCollectConfirmModal] = useState(false);
  const [pendingCollectPaymentData, setPendingCollectPaymentData] = useState(null);
  const searchInputRef = useRef(null);
  const autocompleteRef = useRef(null);

  /** Group order rows by receipt_number for table display */
  const groupOrdersByReceipt = (orders) => {
    if (!orders || !orders.length) return [];
    const byReceipt = {};
    orders.forEach((row) => {
      const rn = row.receipt_number;
      if (!byReceipt[rn]) {
        byReceipt[rn] = {
          receipt_number: rn,
          customer_name: row.customer_name,
          customer_phone: row.customer_phone,
          order_date: row.order_date,
          estimated_collection_date: row.estimated_collection_date,
          status: row.status,
          collected_date: row.collected_date,
          payment_method: row.payment_method,
          ready_date: row.ready_date,
          items: [],
          total_amount: 0,
          paid_amount: 0
        };
      }
      byReceipt[rn].items.push(row);
      byReceipt[rn].total_amount += parseFloat(row.total_amount) || 0;
    });
    return Object.values(byReceipt).map((g) => ({
      ...g,
      paid_amount: g.items[0]?.paid_amount != null ? parseFloat(g.items[0].paid_amount) : 0,
      item_count: g.items.length
    }));
  };

  useEffect(() => {
    const t = setTimeout(() => setQueueSearchDebounced(queueSearch), 400);
    return () => clearTimeout(t);
  }, [queueSearch]);

  const loadQueue = useCallback(async () => {
    try {
      setQueueLoading(true);
      const params = { limit: 80 };
      if (queueSearchDebounced && queueSearchDebounced.trim()) {
        params.customer = queueSearchDebounced.trim();
      }
      const res = await getCollectionQueue(params);
      setQueueOrders(res.data || []);
      if (res.fromCache && res.syncedAt) setLastSyncedAt(res.syncedAt); else setLastSyncedAt(null);
    } catch (error) {
      console.error('Error loading queue:', error);
      setQueueOrders([]);
    } finally {
      setQueueLoading(false);
    }
  }, [queueSearchDebounced]);

  useEffect(() => {
    loadQueue();
    const queueInterval = setInterval(() => {
      if (!document.hidden && showQueue) loadQueue();
    }, 30000);
    const onVis = () => {
      if (!document.hidden && showQueue) loadQueue();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(queueInterval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [showQueue, loadQueue]);

  // Focus search input on mount so cashier can type or scan immediately
  useEffect(() => {
    const t = setTimeout(() => {
      searchInputRef.current?.focus();
    }, 150);
    return () => clearTimeout(t);
  }, []);

  // F2: focus receipt/customer search (same as New Order item search shortcut for consistency)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'F2' && !e.target.tagName.match(/INPUT|TEXTAREA|SELECT/)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // When URL has ?receipt=XXX (e.g. from Dashboard deep link), ensure search runs
  useEffect(() => {
    const r = searchParams.get('receipt');
    if (!r || !r.trim()) return;
    setReceiptNumber(r);
    setSearchByPhone(false);
    const run = async () => {
      setLoading(true);
      setError('');
      setOrder(null);
      setCustomerReceiptsList([]);
      setReceiptSearchResults([]);
      setShowAutocomplete(false);
      try {
        const singleRes = await getOrderByReceipt(r.trim());
        const mainOrder = singleRes.data;
        if (!mainOrder) {
          setError('Order not found');
          setOrder(null);
          setAllReceiptOrders([]);
          return;
        }
        if (mainOrder.all_items && mainOrder.all_items.length > 0) {
          setAllReceiptOrders(mainOrder.all_items);
          setOrder(mainOrder);
          setSearchedByCustomer(false);
          setShowOrderDetailsModal(true);
          showToast(`Receipt found (${mainOrder.all_items.length} items)`, 'success');
        } else {
          setOrder(mainOrder);
          setAllReceiptOrders([mainOrder]);
          setSearchedByCustomer(false);
          setShowOrderDetailsModal(true);
          showToast('Order found', 'success');
        }
      } catch (err) {
        const errorMsg = err.response?.data?.error || 'Order not found';
        setError(errorMsg);
        setOrder(null);
        setAllReceiptOrders([]);
        showToast(errorMsg, 'error');
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [searchParams]);

  // Autocomplete: Fetch customers as user types (debounced)
  useEffect(() => {
    if (!searchByPhone || !phoneNumber.trim()) {
      setAutocompleteSuggestions([]);
      setShowAutocomplete(false);
      return;
    }

    const searchTerm = phoneNumber.trim();
    if (searchTerm.length < 2) {
      setAutocompleteSuggestions([]);
      setShowAutocomplete(false);
      return;
    }

    // Debounce the search
    const timer = setTimeout(async () => {
      try {
        const customersRes = await searchCustomers(searchTerm);
        const matchingCustomers = customersRes.data || [];
        setAutocompleteSuggestions(matchingCustomers); // Show all matches; dropdown scrolls
        setShowAutocomplete(matchingCustomers.length > 0);
      } catch (err) {
        console.error('Error fetching autocomplete suggestions:', err);
        setAutocompleteSuggestions([]);
        setShowAutocomplete(false);
      }
    }, 400); // 400ms debounce

    return () => clearTimeout(timer);
  }, [phoneNumber, searchByPhone]);

  // Close autocomplete when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        autocompleteRef.current &&
        !autocompleteRef.current.contains(event.target) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(event.target)
      ) {
        setShowAutocomplete(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearchByReceipt = async () => {
    if (!receiptNumber.trim()) {
      setError('Please enter a receipt number');
      return;
    }

    setLoading(true);
    setError('');
    setOrder(null);
    setSearchedByCustomer(false);
    setCustomerReceiptsList([]);
    setReceiptSearchResults([]);
    setShowAutocomplete(false);

    try {
      // Case-insensitive receipt search (backend handles case-insensitivity)
      const receiptNum = receiptNumber.trim();
      const singleRes = await getOrderByReceipt(receiptNum);
      const mainOrder = singleRes.data;
      
      if (!mainOrder) {
        throw new Error('Order not found');
      }
      
      // The API now returns receipt totals and all items
      // mainOrder should have receipt totals if it has multiple items
      if (mainOrder.all_items && mainOrder.all_items.length > 0) {
        setAllReceiptOrders(mainOrder.all_items);
        // Use mainOrder which has receipt totals
        setOrder(mainOrder);
        const itemCount = mainOrder.receipt_item_count || mainOrder.all_items.length;
        showToast(`Receipt found (${itemCount} ${itemCount === 1 ? 'item' : 'items'})`, 'success');
      } else {
        // Single item or legacy response
        setOrder(mainOrder);
        setAllReceiptOrders([mainOrder]);
        setShowOrderDetailsModal(true);
        showToast('Order found', 'success');
      }
    } catch (err) {
      // Exact match failed — fall back to partial search so a partial receipt
      // number (e.g. the last 4 digits) can still surface matching receipts.
      if (err.response && err.response.status === 404) {
        try {
          const partialRes = await searchReceipts(receiptNumber.trim());
          const matches = partialRes.data || [];
          if (matches.length === 0) {
            setError('Receipt not found');
            showToast('Receipt not found', 'error');
          } else if (matches.length === 1) {
            // Single partial match — load it directly
            setReceiptSearchResults([]);
            await handleSelectReceiptFromList(matches[0]);
            return;
          } else {
            setReceiptSearchResults(matches);
            setOrder(null);
            showToast(`${matches.length} matching receipts found. Select one below.`, 'success');
          }
          setAllReceiptOrders([]);
        } catch (searchErr) {
          setError('Receipt not found');
          showToast('Receipt not found', 'error');
          setOrder(null);
          setAllReceiptOrders([]);
        }
      } else {
        const errorMsg = err.response?.data?.error || 'Order not found';
        setError(errorMsg);
        showToast(errorMsg, 'error');
        setOrder(null);
        setAllReceiptOrders([]);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSearchByPhone = async () => {
    if (!phoneNumber.trim()) {
      setError('Please enter a phone number or customer name');
      return;
    }

    setLoading(true);
    setError('');
    setOrder(null);
    setCustomerReceiptsList([]);
    setShowCustomerResults(false);
    setShowAutocomplete(false);
    setSearchedByCustomer(true);

    try {
      const searchTerm = phoneNumber.trim();
      const customersRes = await searchCustomers(searchTerm);
      const matchingCustomers = customersRes.data || [];

      if (matchingCustomers.length > 1) {
        setCustomerSearchResults(matchingCustomers);
        setShowCustomerResults(true);
        setLoading(false);
        return;
      }

      const isPhone = /\d/.test(searchTerm);
      const allParams = isPhone ? { phone: searchTerm } : { name: searchTerm };
      const allRes = await searchOrdersByCustomer(allParams);

      if (!allRes.data || allRes.data.length === 0) {
        throw new Error('No orders found for this customer');
      }

      const groups = groupOrdersByReceipt(allRes.data);
      setCustomerReceiptsList(groups);

      const first = groups[0];
      try {
        const receiptRes = await getOrderByReceipt(first.receipt_number);
        const receiptOrder = receiptRes.data;
        if (receiptOrder && receiptOrder.all_items) {
          setAllReceiptOrders(receiptOrder.all_items);
          setOrder(receiptOrder);
        } else {
          setOrder(first.items[0]);
          setAllReceiptOrders(first.items);
        }
      } catch (err) {
        setOrder(first.items[0]);
        setAllReceiptOrders(first.items);
      }
      setReceiptNumber(first.receipt_number);
      setShowOrderDetailsModal(true);
      showToast(groups.length === 1 ? '1 receipt found' : `${groups.length} receipts found. Select one below.`, 'success');
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message || 'No orders found';
      setError(errorMsg);
      showToast(errorMsg, 'error');
      setOrder(null);
      setCustomerReceiptsList([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectCustomer = async (customer) => {
    setShowCustomerResults(false);
    setPhoneNumber(customer.phone);
    setCustomerReceiptsList([]);
    try {
      const allRes = await searchOrdersByCustomer({ phone: customer.phone });
      if (!allRes.data || allRes.data.length === 0) {
        showToast('No orders found for this customer', 'info');
        return;
      }
      const groups = groupOrdersByReceipt(allRes.data);
      setCustomerReceiptsList(groups);
      setSearchedByCustomer(true);

      const first = groups[0];
      try {
        const receiptRes = await getOrderByReceipt(first.receipt_number);
        const receiptOrder = receiptRes.data;
        if (receiptOrder && receiptOrder.all_items) {
          setAllReceiptOrders(receiptOrder.all_items);
          setOrder(receiptOrder);
        } else {
          setOrder(first.items[0]);
          setAllReceiptOrders(first.items);
        }
      } catch (err) {
        setOrder(first.items[0]);
        setAllReceiptOrders(first.items);
      }
      setReceiptNumber(first.receipt_number);
      setShowOrderDetailsModal(true);
      showToast(groups.length === 1 ? '1 receipt' : `${groups.length} receipts`, 'success');
    } catch (err) {
      showToast('Error loading orders: ' + (err.response?.data?.error || err.message), 'error');
    }
  };

  const handleSelectReceiptFromList = async (receiptGroup) => {
    setReceiptNumber(receiptGroup.receipt_number);
    setShowOrderDetailsModal(true);
    try {
      const receiptRes = await getOrderByReceipt(receiptGroup.receipt_number);
      const receiptOrder = receiptRes.data;
      if (receiptOrder && receiptOrder.all_items) {
        setAllReceiptOrders(receiptOrder.all_items);
        setOrder(receiptOrder);
      } else {
        setOrder(receiptGroup.items[0]);
        setAllReceiptOrders(receiptGroup.items);
      }
    } catch (err) {
      setOrder(receiptGroup.items[0]);
      setAllReceiptOrders(receiptGroup.items);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (searchByPhone) {
      await handleSearchByPhone();
    } else {
      await handleSearchByReceipt();
    }
  };

  const handleCollect = async () => {
    if (!order) {
      showToast('No order selected', 'warning');
      return;
    }

    // Check if any item is ready (for multi-item receipts)
    const items = allReceiptOrders.length > 0 ? allReceiptOrders : [order];
    const allReady = items.every(item => item.status === 'ready');
    
    if (!allReady) {
      showToast('Not all items on this receipt are ready for collection', 'warning');
      return;
    }

    const { balanceDue } = getReceiptTotals(order, allReceiptOrders);
    
    // If there's a balance due, show payment modal. Cashier records balance due (not full receipt total).
    if (balanceDue > 0) {
      setPaymentAmount(String(balanceDue));
      setPaymentDate(todayYmd());
      setShowPaymentModal(true);
      return;
    }

    // No balance, proceed with collection
    await confirmCollect();
  };

  const confirmCollect = async (paymentData = {}) => {
    if (!order) return;
    setPendingCollectPaymentData(paymentData);
    setShowCollectConfirmModal(true);
  };

  const confirmCollectProceed = async () => {
    if (!order) return;
    const paymentData = pendingCollectPaymentData || {};
    setShowCollectConfirmModal(false);
    setPendingCollectPaymentData(null);
    const itemCount = order.receipt_item_count || allReceiptOrders.length || 1;
    try {
      setCollecting(true);
      const res = await collectOrder(order.receipt_number, paymentData);
      const receiptTotal = res.data?.receipt_total || res.data?.order?.total_amount || order.total_amount;
      const itemCountMsg = res.data?.order?.receipt_item_count || itemCount;
      showToast(`Receipt collected successfully! (${itemCountMsg} ${itemCountMsg === 1 ? 'item' : 'items'})`, 'success');
      playSuccessSound();
      if (paymentData.payment_amount > 0) {
        showToast(`Payment of TSh ${paymentData.payment_amount.toLocaleString()} recorded`, 'success');
      }
      setOrder(null);
      setReceiptNumber('');
      setPhoneNumber('');
      setError('');
      setAllReceiptOrders([]);
      setShowPaymentModal(false);
      setPaymentAmount('');
      setPaymentDate(todayYmd());
      loadQueue();
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
    } catch (err) {
      showToast('Error collecting receipt: ' + (err.response?.data?.error || err.message), 'error');
    } finally {
      setCollecting(false);
    }
  };

  const handlePaymentSubmit = async (e) => {
    e.preventDefault();
    if (!order) return;
    
    const { balanceDue } = getReceiptTotals(order, allReceiptOrders);
    const payment = roundFigure(parseFloat(paymentAmount) || 0);
    const tol = 0.01;
    
    if (payment <= 0) {
      showToast('Payment amount must be greater than 0', 'error');
      return;
    }
    if (payment > balanceDue + tol) {
      showToast(`Payment cannot exceed the balance due of TSh ${balanceDue.toLocaleString()}.`, 'error');
      return;
    }

    await confirmCollect({
      payment_amount: payment,
      payment_method: paymentMethod,
      payment_date: paymentDate
    });
  };

  const handleReceivePayment = () => {
    if (!order) {
      showToast('No order selected', 'error');
      return;
    }
    
    const { receiptTotal, balanceDue } = getReceiptTotals(order, allReceiptOrders);
    
    if (balanceDue <= 0) {
      showToast('Receipt is already fully paid', 'info');
      return;
    }
    // Pre-fill with balance due. Cashier may receive full or partial amount.
    setPaymentAmount(String(balanceDue));
    setPaymentDate(todayYmd());
    setShowReceivePaymentModal(true);
  };

  const handleReceivePaymentSubmit = async (e) => {
    e.preventDefault();
    if (!order) return;

    const { balanceDue } = getReceiptTotals(order, allReceiptOrders);
    const payment = roundFigure(parseFloat(paymentAmount) || 0);
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
      const itemCount = allReceiptOrders?.length || 1;
      const res = await receivePayment(order.id, {
        payment_amount: payment,
        payment_method: paymentMethod,
        payment_date: paymentDate,
        notes: `Payment received for receipt ${order.receipt_number} (${itemCount} ${itemCount === 1 ? 'item' : 'items'})`
      });
      
      showToast(`Payment of TSh ${payment.toLocaleString()} received successfully!`, 'success');
      
      // Reload order to get updated payment info
      if (searchByPhone) {
        await handleSearchByPhone();
      } else {
        await handleSearchByReceipt();
      }
      
      setShowReceivePaymentModal(false);
      setPaymentAmount('');
      setPaymentDate(todayYmd());
      loadQueue(); // Refresh queue
    } catch (err) {
      showToast('Error receiving payment: ' + (err.response?.data?.error || err.message), 'error');
    } finally {
      setReceivingPayment(false);
    }
  };

  const handlePrintReceipt = async () => {
    if (!order) {
      showToast('No order selected', 'error');
      return;
    }

    try {
      // Use all items from the receipt - prioritize all_items from order, then allReceiptOrders
      const itemsToPrint = (order.all_items && order.all_items.length > 0) 
        ? order.all_items 
        : (allReceiptOrders.length > 0 ? allReceiptOrders : [order]);
      
      // Generate consolidated receipt with all items (structured: header, items, footer)
      const receiptData = await generateConsolidatedReceipt(itemsToPrint, order);
      
      // Print the receipt (centered, table with wrapped description and visible amount)
      await printReceiptText(receiptData);
    } catch (error) {
      console.error('Error in handlePrintReceipt:', error);
      showToast(`Error printing receipt: ${error.message}`, 'error');
    }
  };

  // When item count exceeds this, use compact format (shorter desc, smaller print font) so it fits on one page
  const RECEIPT_COMPACT_THRESHOLD = 12;

  // Generate consolidated receipt (single page). Uses compact layout when many items.
  const generateConsolidatedReceipt = async (orders, mainOrder) => {
    const orderDate = new Date(mainOrder.order_date);
    const dateStr = `${String(orderDate.getDate()).padStart(2, '0')}/${String(orderDate.getMonth() + 1).padStart(2, '0')}/${orderDate.getFullYear()} ${String(orderDate.getHours()).padStart(2, '0')}:${String(orderDate.getMinutes()).padStart(2, '0')}`;
    const estimatedCollectionDate = mainOrder.estimated_collection_date
      ? (() => {
          const estDate = new Date(mainOrder.estimated_collection_date);
          return `Est. Collection: ${String(estDate.getDate()).padStart(2, '0')}/${String(estDate.getMonth() + 1).padStart(2, '0')}/${estDate.getFullYear()} ${String(estDate.getHours()).padStart(2, '0')}:${String(estDate.getMinutes()).padStart(2, '0')}\n`;
        })()
      : '';

    const totalAmount = roundMoney(mainOrder.total_amount || orders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0));
    const paidAmount = roundMoney(mainOrder.paid_amount !== undefined && mainOrder.paid_amount !== null ? mainOrder.paid_amount : orders.reduce((sum, o) => sum + (parseFloat(o.paid_amount) || 0), 0));
    const balance = roundMoney(totalAmount - paidAmount);

    const itemsToShow = orders.length > 0 ? orders : (mainOrder.all_items || [mainOrder]);
    const useCompact = itemsToShow.length > RECEIPT_COMPACT_THRESHOLD;
    const totalReceiptItems = itemsToShow.reduce((sum, item) => sum + (parseFloat(item?.quantity) || 1), 0);
    const customerReceiptId = formatCustomerReceiptId(
      mainOrder.receipt_number,
      totalReceiptItems,
      mainOrder.branch_code
    );
    const branchLabel =
      mainOrder.branch_name ||
      (branch?.id === mainOrder.branch_id ? branch?.name : null) ||
      (mainOrder.branch_id ? `Branch ID ${mainOrder.branch_id}` : null) ||
      'Arusha';
    const branchLine = formatBranchReceiptLine(mainOrder);

    const headerText = useCompact
      ? `SUPACLEAN | ${branchLabel}\nReceipt: ${customerReceiptId} | ${dateStr}\n${estimatedCollectionDate}${mainOrder.customer_name} | ${mainOrder.customer_phone}\n`
      : `═══════════════════════════════════
   Laundry & Dry Cleaning
   ${branchLabel}, Tanzania
═══════════════════════════════════

Receipt No: ${customerReceiptId}
${branchLine}Date: ${dateStr}
${estimatedCollectionDate}
Customer: ${mainOrder.customer_name}
Phone: ${mainOrder.customer_phone}
───────────────────────────────────
`;
    const brandTitle = useCompact ? null : 'SUPACLEAN';

    const items = [];
    itemsToShow.forEach((orderItem) => {
      const itemName = orderItem.garment_type || orderItem.item_name || orderItem.service_name || 'Item';
      const quantity = orderItem.quantity || 1;
      const color = orderItem.color || '';
      const itemAmount = parseFloat(orderItem.total_amount) || 0;
      let itemDescription = itemName;
      if (color) itemDescription += ` (${color})`;
      items.push({
        qty: String(quantity),
        desc: itemDescription,
        amount: `TSh ${itemAmount.toLocaleString()}`
      });
    });

    const sep = useCompact ? '─'.repeat(32) : '───────────────────────────────────────────';
    let footerText = `${sep}\nTOTAL: TSh ${totalAmount.toLocaleString()}\n`;
    if (balance <= 0) {
      footerText += `PAID (${(mainOrder.payment_method || 'cash').toUpperCase()})\n`;
    } else if (paidAmount > 0) {
      footerText += `ADVANCE | Paid TSh ${paidAmount.toLocaleString()} | Due TSh ${balance.toLocaleString()}\n`;
    } else {
      footerText += `NOT PAID\n`;
    }
    footerText += useCompact ? `\nKeep for collection. Thank you!\n` : `\nPlease keep this receipt for collection.\nThank you for choosing SUPACLEAN!\n\n═══════════════════════════════════\n`;

    return { headerText, items, footerText, brandTitle };
  };

  // Print receipt text (single page). Uses smaller font when long. No extra/black page; Terms QR at end.
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
                body { font-family: 'Courier New', monospace; padding: ${receiptPadding}; margin: 0; background: white; width: ${receiptWidthCss}; max-width: ${receiptWidthCss}; box-sizing: border-box; font-size: ${receiptFontSize}; }
                pre, .receipt-items th, .receipt-items td { color: #000 !important; font-weight: 600; }
                .receipt-items .r-desc { color: #000 !important; font-weight: 600; }
                .receipt-footer { font-weight: bold; color: #000 !important; }
                .receipt-end p { font-weight: bold; color: #000 !important; }
                pre { margin: 0; padding: 0; white-space: pre; overflow: visible; }
                body.receipt-compact pre, body.receipt-compact .receipt-items { font-size: ${receiptCompactFontSize}; }
                .receipt-end { margin-top: 6px; page-break-inside: avoid; }
                * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              }
              @media screen {
                body { font-family: 'Courier New', monospace; padding: 20px; max-width: ${receiptWidthCss}; margin: 0 auto; background: #f5f5f5; }
              }
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
              function doPrint() { window.focus(); window.print(); }
              window.onafterprint = function() { setTimeout(function() { window.close(); }, 500); };
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

    const forceSameWindow = typeof process !== 'undefined' && process.env && process.env.REACT_APP_FORCE_RECEIPT_SAME_WINDOW === 'true';
    const isSmallScreen = typeof window !== 'undefined' && window.innerWidth <= 600;
    const sameWindowPrint = forceSameWindow || isSmallScreen;
    const runInPagePrint = () => {
      const printContainer = document.createElement('div');
      printContainer.id = 'receipt-print-container-collection';
      printContainer.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
      const inner = document.createElement('div');
      inner.style.cssText = `width:${receiptWidthCss};max-width:100%;min-height:80px;background:white;padding:${receiptPadding};font-family:'Courier New',monospace;font-size:${receiptFontSize};font-weight:600;color:#000;text-align:center;border-radius:8px`;
      inner.innerHTML = bodyContent + termsQrBlock;
      if (compact) {
        const pres = inner.querySelectorAll('pre');
        pres.forEach((p) => { p.style.fontSize = receiptCompactFontSize; p.style.lineHeight = '1.05'; });
      }
      printContainer.appendChild(inner);
      const printStyle = document.createElement('style');
      printStyle.textContent = `#receipt-print-container-collection .receipt-end p{font-weight:bold;color:#000}#receipt-print-container-collection .receipt-footer{font-weight:bold;color:#000}#receipt-print-container-collection .r-desc{color:#000;font-weight:600}@media print{@page{size:${receiptWidthCss} auto;margin:0}body *{visibility:hidden !important}#receipt-print-container-collection,#receipt-print-container-collection *{visibility:visible !important}#receipt-print-container-collection{position:absolute !important;left:0 !important;top:0 !important;right:auto !important;bottom:auto !important;background:white !important;padding:${receiptPadding} !important;width:${receiptWidthCss} !important;max-width:${receiptWidthCss} !important;min-height:1px !important}#receipt-print-container-collection>div{background:white !important;min-height:1px !important}}`;
      document.head.appendChild(printStyle);
      document.body.appendChild(printContainer);
      const cleanup = () => {
        if (document.body.contains(printContainer)) document.body.removeChild(printContainer);
        if (document.head.contains(printStyle)) document.head.removeChild(printStyle);
      };
      const runPrint = () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(() => {
              window.print();
              setTimeout(cleanup, 2000);
            }, 400);
          });
        });
      };
      if (sameWindowPrint) {
        showToast('Printing from this screen. Use default (built-in) printer.', 'info');
      }
      const img = inner.querySelector('img');
      if (img) {
        let done = false;
        const go = () => { if (!done) { done = true; runPrint(); } };
        img.onload = go;
        img.onerror = go;
        setTimeout(go, 1000);
      } else {
        setTimeout(runPrint, 400);
      }
    };

    try {
      if (sameWindowPrint) {
        runInPagePrint();
        return;
      }
      const printWindow = window.open('', '_blank', 'width=320,height=500,scrollbars=yes');
      if (printWindow) {
        printWindow.document.open();
        printWindow.document.write(printHTML);
        printWindow.document.close();
        showToast('Receipt print dialog opened. Select your thermal printer.', 'success');
      } else {
        showToast('Using same-window print (better for built-in printer).', 'info');
        runInPagePrint();
      }
    } catch (error) {
      console.error('Error printing receipt:', error);
      showToast('Trying same-window print...', 'info');
      runInPagePrint();
    }
  };

  const formatReceiptText = (order) => {
    const date = new Date(order.order_date);
    const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    
    const estimatedCollectionDate = order.estimated_collection_date 
      ? (() => {
          const estDate = new Date(order.estimated_collection_date);
          return `Est. Collection: ${String(estDate.getDate()).padStart(2, '0')}/${String(estDate.getMonth() + 1).padStart(2, '0')}/${estDate.getFullYear()} ${String(estDate.getHours()).padStart(2, '0')}:${String(estDate.getMinutes()).padStart(2, '0')}\n`;
        })()
      : '';
    
    return `
═══════════════════════════════════
         SUPACLEAN
   Laundry & Dry Cleaning
        Arusha, Tanzania
═══════════════════════════════════

Receipt No: ${formatReceiptForDisplay(order.receipt_number, allReceiptOrders.length > 0 ? allReceiptOrders : [order])}
Date: ${dateStr}
${estimatedCollectionDate}
Customer: ${order.customer_name}
Phone: ${order.customer_phone}
───────────────────────────────────
Service: ${order.service_name}
Garment Type: ${order.garment_type || 'N/A'}
Color: ${order.color || 'N/A'}
Quantity: ${order.quantity}
${order.weight_kg ? `Weight: ${order.weight_kg} kg` : ''}
───────────────────────────────────
Total Amount: TSh ${roundMoney(order.total_amount || 0).toLocaleString()}
Paid: TSh ${roundMoney(order.paid_amount || 0).toLocaleString()}
Status: ${(order.status || '').toUpperCase()}
───────────────────────────────────

${order.special_instructions ? `Notes: ${order.special_instructions}\n` : ''}
Please keep this receipt for collection.
Thank you for choosing SUPACLEAN!

═══════════════════════════════════
`;
  };

  const getBalanceDue = (order) => {
    const { balanceDue } = getReceiptTotals(order, allReceiptOrders);
    return balanceDue;
  };

  const isOverdue = (order) => {
    if (!order.estimated_collection_date) return false;
    return new Date(order.estimated_collection_date) < new Date();
  };

  return (
    <div className="collection-page-modern">
      <ToastContainer />
      {lastSyncedAt && (
        <div className="sync-cache-banner" role="status">
          Showing queue from last sync — {new Date(lastSyncedAt).toLocaleString()}
        </div>
      )}
      <div className="collection-header">
        <div>
          <h1>Collection</h1>
          <p className="subtitle">Verify receipt and mark order as collected</p>
        </div>
        <div className="header-actions">
          <button
            className={`btn-secondary ${showQueue ? 'active' : ''}`}
            onClick={() => setShowQueue(!showQueue)}
          >
            {showQueue ? '📋 Hide Queue' : '📋 Show Queue'}
          </button>
        </div>
      </div>

      {showQueue && (
        <div className="queue-dashboard">
          <div className="queue-header">
            <div>
              <h2>📦 Ready Orders Queue</h2>
              {queueOrders.filter(r => r.is_overdue || isOverdue(r)).length > 0 && (
                <span className="queue-overdue-count">
                  ⚠️ {queueOrders.filter(r => r.is_overdue || isOverdue(r)).length} Overdue
                </span>
              )}
            </div>
            <div className="queue-header-actions">
              <div className="queue-search-wrap">
                <input
                  type="text"
                  className="queue-search-input"
                  placeholder="Search by customer name or phone..."
                  value={queueSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                  aria-label="Search queue by customer name or phone"
                />
                {queueSearch && (
                  <button
                    type="button"
                    className="queue-search-clear"
                    onClick={() => setQueueSearch('')}
                    aria-label="Clear queue search"
                  >
                    ✕
                  </button>
                )}
              </div>
              <ListViewToggle view={listView} setView={setListView} />
              <button className="btn-small btn-secondary" onClick={loadQueue} disabled={queueLoading}>
                {queueLoading ? '⏳ Loading...' : '🔄 Refresh'}
              </button>
            </div>
          </div>
          {queueLoading && queueOrders.length === 0 ? (
            <Loader message="Loading queue…" fullPage={false} />
          ) : queueOrders.length === 0 ? (
            <div className="empty-state">No ready orders in queue</div>
          ) : listView === 'card' ? (
            <div className="queue-cards-grid">
              {queueOrders.map((queueOrder) => {
                const balance = getBalanceDue(queueOrder);
                const overdue = queueOrder.is_overdue || isOverdue(queueOrder);
                const itemCount = queueOrder.receipt_item_count || 1;
                const isSelected = queueOrder.receipt_number === order?.receipt_number;
                return (
                  <div
                    key={queueOrder.receipt_number || queueOrder.id}
                    className={`queue-list-card ${overdue ? 'overdue' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      setReceiptNumber(queueOrder.receipt_number);
                      setAllReceiptOrders(queueOrder.all_items && queueOrder.all_items.length > 0 ? queueOrder.all_items : [queueOrder]);
                      setOrder(queueOrder);
                      setShowOrderDetailsModal(true);
                      setShowQueue(false);
                    }}
                  >
                    <div className="queue-list-card-header">
                      <strong>{formatReceiptForDisplay(queueOrder.receipt_number, queueOrder.all_items || [])}</strong>
                      {overdue && <span className="overdue-indicator">⚠️ Overdue</span>}
                    </div>
                    <div className="queue-list-card-body">
                      <p><strong>{queueOrder.customer_name}</strong></p>
                      <p className="text-muted">{queueOrder.customer_phone}</p>
                      <p>{itemCount} item(s) · TSh {(queueOrder.total_amount ?? 0).toLocaleString()}</p>
                      <p>{balance > 0 ? <span className="balance-due">Balance TSh {balance.toLocaleString()}</span> : 'Paid'}</p>
                      {queueOrder.estimated_collection_date && (
                        <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          Est: {new Date(queueOrder.estimated_collection_date).toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="queue-table-wrapper">
              <table className="queue-table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Customer</th>
                    <th>Phone</th>
                    <th>Items</th>
                    <th>Service</th>
                    <th>Total</th>
                    <th>Balance</th>
                    <th>Est. Collection</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {queueOrders.map((queueOrder) => {
                    const balance = getBalanceDue(queueOrder);
                    const overdue = queueOrder.is_overdue || isOverdue(queueOrder);
                    const hoursOverdue = queueOrder.hours_overdue || 0;
                    const itemCount = queueOrder.receipt_item_count || 1;
                    let timeRemaining = null;
                    if (!overdue && queueOrder.estimated_collection_date) {
                      const estDate = new Date(queueOrder.estimated_collection_date);
                      const now = new Date();
                      const diffHours = Math.floor((estDate - now) / (1000 * 60 * 60));
                      if (diffHours <= 2 && diffHours > 0) {
                        timeRemaining = `${diffHours}h remaining`;
                      }
                    }
                    const isSelected = queueOrder.receipt_number === order?.receipt_number;
                    return (
                      <tr
                        key={queueOrder.receipt_number || queueOrder.id}
                        className={`queue-row ${overdue ? 'overdue' : ''} ${isSelected ? 'selected' : ''}`}
                        onClick={() => {
                          setReceiptNumber(queueOrder.receipt_number);
                          setAllReceiptOrders(queueOrder.all_items && queueOrder.all_items.length > 0 ? queueOrder.all_items : [queueOrder]);
                          setOrder(queueOrder);
                          setShowOrderDetailsModal(true);
                          setShowQueue(false);
                        }}
                      >
                        <td><strong>{formatReceiptForDisplay(queueOrder.receipt_number, queueOrder.all_items || [])}</strong></td>
                        <td>{queueOrder.customer_name}</td>
                        <td className="text-muted">{queueOrder.customer_phone}</td>
                        <td>{itemCount > 1 ? `${itemCount} items` : '1'}</td>
                        <td className="queue-service-cell">{queueOrder.service_name}</td>
                        <td>TSh {(queueOrder.total_amount ?? 0).toLocaleString()}</td>
                        <td className={balance > 0 ? 'queue-balance-cell' : ''}>
                          {balance > 0 ? `TSh ${balance.toLocaleString()}` : '—'}
                        </td>
                        <td className={overdue ? 'overdue-text' : 'text-muted'}>
                          {queueOrder.estimated_collection_date
                            ? new Date(queueOrder.estimated_collection_date).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                              })
                            : '—'}
                        </td>
                        <td>
                          {overdue && (
                            <span className="overdue-badge">
                              ⚠️ {hoursOverdue > 0 ? `${hoursOverdue}h overdue` : 'Overdue'}
                            </span>
                          )}
                          {!overdue && timeRemaining && (
                            <span className="time-remaining-badge">⏰ {timeRemaining}</span>
                          )}
                          {!overdue && !timeRemaining && '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="collection-container-modern">
        <div className="search-section-modern">
          <div className="search-toggle">
            <button
              type="button"
              className={!searchByPhone ? 'active' : ''}
              onClick={() => setSearchByPhone(false)}
            >
              🧾 Receipt Number
            </button>
            <button
              type="button"
              className={searchByPhone ? 'active' : ''}
              onClick={() => setSearchByPhone(true)}
            >
              📱 Phone/Name
            </button>
          </div>
          <form onSubmit={handleSearch}>
            <div className="search-box-modern" style={{ position: 'relative' }}>
              <input
                ref={searchInputRef}
                type="text"
                placeholder={searchByPhone ? "Enter customer phone number or name..." : "Enter Receipt Number (e.g., 5-21-01 (26))"}
                value={searchByPhone ? phoneNumber : receiptNumber}
                aria-label={searchByPhone ? "Search by customer phone or name" : "Receipt number"}
                title="Receipt or customer search (F2)"
                onChange={(e) => {
                  if (searchByPhone) {
                    setPhoneNumber(e.target.value);
                  } else {
                    // Case-insensitive receipt number - keep original case but allow any case
                    setReceiptNumber(e.target.value);
                  }
                }}
                onFocus={() => {
                  if (searchByPhone && autocompleteSuggestions.length > 0) {
                    setShowAutocomplete(true);
                  }
                }}
                className="receipt-input-modern"
              />
              <button type="submit" className="btn-primary btn-large" disabled={loading}>
                {loading ? '⏳ Searching...' : '🔍 Search'}
              </button>
              
              {/* Autocomplete Dropdown */}
              {searchByPhone && showAutocomplete && autocompleteSuggestions.length > 0 && (
                <div 
                  ref={autocompleteRef}
                  className="autocomplete-dropdown collection-customer-dropdown"
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: '120px',
                    marginTop: '4px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                    zIndex: 1000,
                    maxHeight: '280px',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    WebkitOverflowScrolling: 'touch',
                    overscrollBehavior: 'contain'
                  }}
                >
                  {autocompleteSuggestions.map((customer) => (
                    <div
                      key={customer.id}
                      role="option"
                      onClick={() => {
                        setPhoneNumber(customer.name);
                        setShowAutocomplete(false);
                        handleSelectCustomer(customer);
                      }}
                      style={{
                        padding: '12px 16px',
                        cursor: 'pointer',
                        borderBottom: '1px solid var(--border-color)',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--bg-hover)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ fontWeight: '600', color: 'var(--text-primary)', marginBottom: '4px' }}>
                        {customer.name}
                      </div>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                        📞 {customer.phone}
                      </div>
                      {customer.branch_name && (
                        <div style={{ fontSize: '11px', color: 'var(--primary-color)', marginTop: '4px', fontWeight: '500' }}>
                          📍 {customer.branch_name}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </form>

          {error && (
            <div className="error-message-modern">
              ⚠️ {error}
            </div>
          )}
        </div>

        {showCustomerResults && customerSearchResults.length > 0 && (
          <div className="customer-results-table" style={{ marginTop: '20px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)', padding: '16px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ marginBottom: '12px', fontSize: '16px' }}>Matching Customers ({customerSearchResults.length})</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                    <th style={{ padding: '8px', textAlign: 'left', fontWeight: '600' }}>Name</th>
                    <th style={{ padding: '8px', textAlign: 'left', fontWeight: '600' }}>Phone</th>
                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: '600' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {customerSearchResults.map((customer) => (
                    <tr 
                      key={customer.id} 
                      style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                      onClick={() => handleSelectCustomer(customer)}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '10px' }}>{customer.name}</td>
                      <td style={{ padding: '10px' }}>{customer.phone}</td>
                      <td style={{ padding: '10px', textAlign: 'center' }}>
                        <button 
                          className="btn-small btn-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectCustomer(customer);
                          }}
                        >
                          Select
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button 
              className="btn-secondary" 
              style={{ marginTop: '12px' }}
              onClick={() => setShowCustomerResults(false)}
            >
              Close
            </button>
          </div>
        )}


            {receiptSearchResults.length > 0 && (
              <div className="customer-receipts-table-wrap">
                <h3 className="receipts-table-title">{receiptSearchResults.length} matching receipts found. Select one below.</h3>
                <div className="customer-receipts-table-scroll">
                  <table className="customer-receipts-table">
                    <thead>
                      <tr>
                        <th>Receipt No</th>
                        <th>Customer</th>
                        <th>Phone</th>
                        <th>Order Date</th>
                        <th>Items</th>
                        <th>Total</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiptSearchResults.map((rg) => (
                        <tr key={rg.receipt_number} onClick={() => handleSelectReceiptFromList(rg)}>
                          <td><strong>{formatReceiptForDisplay(rg.receipt_number, [])}</strong></td>
                          <td>{rg.customer_name || '—'}</td>
                          <td>{rg.customer_phone || '—'}</td>
                          <td>{rg.order_date ? new Date(rg.order_date).toLocaleDateString() : '—'}</td>
                          <td>{rg.item_count}</td>
                          <td>TSh {(rg.total_amount || 0).toLocaleString()}</td>
                          <td><span className={`status-badge status-${rg.status}`}>{rg.status}</span></td>
                          <td><button type="button" className="btn-small btn-secondary" onClick={(e) => { e.stopPropagation(); handleSelectReceiptFromList(rg); }}>View</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
        <OrderDetailsModal
          open={showOrderDetailsModal && !!order}
          order={order}
          items={allReceiptOrders.length > 0 ? allReceiptOrders : (order ? [order] : [])}
          onClose={() => setShowOrderDetailsModal(false)}
          actions={
            order ? (
              <div className="collection-actions-modern">
                {order.status === 'ready' && (
                  <>
                    {(() => {
                      const { balanceDue } = getReceiptTotals(order, allReceiptOrders);
                      return balanceDue > 0 ? (
                        <>
                          <button
                            className="btn-primary btn-large"
                            onClick={() => { setShowOrderDetailsModal(false); handleReceivePayment(); }}
                            style={{ marginBottom: '10px' }}
                          >
                            Receive Payment
                          </button>
                          <button
                            className="btn-primary btn-large"
                            onClick={() => { setShowOrderDetailsModal(false); handleCollect(); }}
                            disabled={collecting}
                          >
                            {collecting ? 'Processing...' : 'Collect Order'}
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn-primary btn-large"
                          onClick={() => { setShowOrderDetailsModal(false); handleCollect(); }}
                          disabled={collecting}
                        >
                          {collecting ? 'Processing...' : 'Mark as Collected'}
                        </button>
                      );
                    })()}
                    <button className="btn-secondary" onClick={handlePrintReceipt}>
                      Reprint Receipt
                    </button>
                  </>
                )}
                {order.status !== 'ready' && order.status !== 'collected' && (() => {
                  const { balanceDue } = getReceiptTotals(order, allReceiptOrders);
                  return balanceDue > 0 ? (
                    <div className="receive-payment-early">
                      <button
                        className="btn-primary btn-large"
                        onClick={() => { setShowOrderDetailsModal(false); handleReceivePayment(); }}
                      >
                        Receive Payment
                      </button>
                      <small>Customer can pay now and collect items when ready.</small>
                    </div>
                  ) : null;
                })()}
                {order.status === 'collected' && (
                  <div className="collected-notice-modern">
                    This order was already collected on {order.collected_date ? new Date(order.collected_date).toLocaleString() : ''}
                    <button className="btn-secondary" onClick={handlePrintReceipt}>
                      Reprint Receipt
                    </button>
                  </div>
                )}
                {order.status !== 'ready' && order.status !== 'collected' && (
                  <div className="not-ready-notice-modern">
                    This order is not ready for collection yet. Status: {order.status}
                  </div>
                )}
              </div>
            ) : null
          }
        />
      {/* Payment Modal (for collection) */}
      {showPaymentModal && order && (() => {
        const { receiptTotal, receiptPaid, balanceDue } = getReceiptTotals(order, allReceiptOrders);
        return (
        <div className="modal-overlay" onClick={() => setShowPaymentModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>💵 Payment at Collection</h2>
              <button className="modal-close" onClick={() => setShowPaymentModal(false)}>×</button>
            </div>
            <form onSubmit={handlePaymentSubmit}>
              <div className="modal-body">
                <div className="payment-summary">
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
                  <label>Payment Amount * (balance due — can be paid in full or part)</label>
                  <input
                    type="number"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    placeholder={`Balance due: TSh ${balanceDue.toLocaleString()}`}
                    min="0"
                    step="1"
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
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowPaymentModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={collecting}>
                  {collecting ? '⏳ Processing...' : '✅ Collect & Record Payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
        );
      })()}

      {/* Receive Payment Modal (without collecting) — use anytime, including before collection date */}
      {showReceivePaymentModal && order && (() => {
        const { receiptTotal, receiptPaid, balanceDue } = getReceiptTotals(order, allReceiptOrders);
        return (
        <div className="modal-overlay" onClick={() => setShowReceivePaymentModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>💰 Receive Payment</h2>
              <p className="modal-hint">You can receive payment before the collection date. The customer can collect items later when ready.</p>
              <button className="modal-close" onClick={() => setShowReceivePaymentModal(false)}>×</button>
            </div>
            <form onSubmit={handleReceivePaymentSubmit}>
              <div className="modal-body">
                <div className="payment-summary">
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
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    placeholder={`Enter up to TSh ${balanceDue.toLocaleString()}`}
                    min="0"
                    step="1"
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
                  ℹ️ This will record the payment but will not mark the order as collected. The order status will remain unchanged.
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowReceivePaymentModal(false)}>
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

      {showCollectConfirmModal && order && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="collect-confirm-title" onClick={(e) => e.target === e.currentTarget && setShowCollectConfirmModal(false)}>
          <div className="modal-content" style={{ maxWidth: '400px' }}>
            <h2 id="collect-confirm-title">Confirm collection</h2>
            <div className="modal-body">
              <p>Collect receipt <strong>{formatReceiptForDisplay(order.receipt_number, allReceiptOrders.length > 0 ? allReceiptOrders : (order ? [order] : []))}</strong> ({order.receipt_item_count || allReceiptOrders.length || 1} {order.receipt_item_count === 1 || (allReceiptOrders.length || 1) === 1 ? 'line' : 'lines'})?</p>
              {pendingCollectPaymentData?.payment_amount > 0 && (
                <p>Payment of TSh {Number(pendingCollectPaymentData.payment_amount).toLocaleString()} will be recorded.</p>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => { setShowCollectConfirmModal(false); setPendingCollectPaymentData(null); }}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={confirmCollectProceed} disabled={collecting}>
                {collecting ? '⏳ Processing...' : '✅ Collect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Collection;
