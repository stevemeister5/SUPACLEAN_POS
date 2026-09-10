import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getServices, getItems, searchCustomers, createCustomer, createOrderBatch, getCustomerOrders, getSettings, sendReceiptSms } from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import { receiptWidthCss, receiptPadding, receiptFontSize, receiptCompactFontSize, termsQrSize, receiptBrandMargin, receiptBrandFontSize } from '../utils/receiptPrintConfig';
import { formatCustomerReceiptId, formatBranchReceiptLine } from '../utils/receiptId';
import { playSuccessSound } from '../utils/sound';
import { loadBrandSettings } from '../utils/brandSettings';
import './NewOrder.css';

// Color Input Component - Defined outside to prevent recreation on each render
// Uses local state to prevent cursor jumping
const ColorInput = React.memo(({ value: propValue, onChange, itemId }) => {
  const [localValue, setLocalValue] = useState(propValue || '');
  const textareaRef = useRef(null);
  const updateTimeoutRef = useRef(null);
  const isFocusedRef = useRef(false);
  
  // Sync local value when prop changes (only if not focused and different)
  useEffect(() => {
    if (!isFocusedRef.current && propValue !== localValue) {
      setLocalValue(propValue || '');
    }
  }, [propValue, localValue]);
  
  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, []);
  
  // Handle change - update local state immediately, debounce parent update
  const handleChange = (e) => {
    const newValue = e.target.value;
    
    // Update local state immediately (no re-render from parent affects cursor)
    setLocalValue(newValue);
    
    // Clear any pending update
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
    }
    
    // Debounce parent update to reduce re-renders
    updateTimeoutRef.current = setTimeout(() => {
      onChange(newValue);
    }, 150);
  };
  
  // Update parent immediately on blur
  const handleBlur = () => {
    isFocusedRef.current = false;
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
      updateTimeoutRef.current = null;
    }
    if (localValue !== propValue) {
      onChange(localValue);
    }
  };
  
  const handleFocus = () => {
    isFocusedRef.current = true;
  };
  
  return (
    <textarea
      ref={textareaRef}
      value={localValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onFocus={handleFocus}
      placeholder="Enter color description (e.g., Blue striped shirt, Red and white checked fabric, etc.)"
      className="color-description-input"
      rows={2}
      maxLength={200}
    />
  );
});

const RECENT_STORAGE_KEY = 'neworder_recent';
const RECENT_MAX = 10;
const toLocalDateTimeInput = (date) => {
  const d = new Date(date);
  d.setSeconds(0, 0);
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
};
const parseDateTimeInput = (rawValue) => {
  const value = String(rawValue || '').trim();
  if (!value) return null;

  // Native datetime-local format: YYYY-MM-DDTHH:mm
  const isoLocalMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})$/);
  if (isoLocalMatch) {
    const [, y, m, d, hh, mm] = isoLocalMatch;
    return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), 0, 0);
  }

  // Localized fallback: DD/MM/YYYY HH:mm
  const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})$/);
  if (slashMatch) {
    const [, d, m, y, hh, mm] = slashMatch;
    return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), 0, 0);
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return null;
};

function getRecentFromStorage() {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(type, id) {
  const list = getRecentFromStorage();
  const entry = { t: type === 'service' ? 's' : 'i', id: Number(id) };
  const filtered = list.filter((e) => !(e.t === entry.t && e.id === entry.id));
  const next = [entry, ...filtered].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch (_) {}
}

const NewOrder = () => {
  const { showToast, ToastContainer } = useToast();
  const { selectedBranchId, branch, user } = useAuth();
  // For non-admin: use branch from auth. For admin: use selectedBranchId (branch switcher) or fallback to user's branch.
  const effectiveBranchId = user?.role === 'admin' ? selectedBranchId : (branch?.id ?? selectedBranchId);
  const [services, setServices] = useState([]);
  const [items, setItems] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerHistory, setCustomerHistory] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchByPhone, setSearchByPhone] = useState(true);
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [orderItems, setOrderItems] = useState([]);
  const [defaultDeliveryType, setDefaultDeliveryType] = useState('standard');
  // Service type: regular (price list) | wash_only | dry_only | press_only | express (2x, same-day)
  const [selectedServiceType, setSelectedServiceType] = useState('regular');
  const [orderData, setOrderData] = useState({
    payment_status: 'not_paid',
    paid_amount: '',
    payment_method: 'cash'
  });
  const [estimatedCollectionDate, setEstimatedCollectionDate] = useState('');
  const [expressSettings, setExpressSettings] = useState({});
  const [newCustomer, setNewCustomer] = useState({
    name: '',
    phone: '',
    email: '',
    address: ''
  });
  const [totalAmount, setTotalAmount] = useState(0);
  const [receiptDiscountType, setReceiptDiscountType] = useState('amount');
  const [receiptDiscountValue, setReceiptDiscountValue] = useState('');
  const [orderDateTime, setOrderDateTime] = useState(() => toLocalDateTimeInput(new Date()));
  const [manualReceiptNumber, setManualReceiptNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [showConfirmOrderModal, setShowConfirmOrderModal] = useState(false);
  const [itemSearchTerm, setItemSearchTerm] = useState('');
  const searchInputRef = useRef(null);
  const itemSearchInputRef = useRef(null);
  const isSubmittingRef = useRef(false);

  // Define all callbacks before using them in useEffect hooks
  const loadServices = useCallback(async () => {
    try {
      const res = await getServices();
      setServices(res.data || []);
    } catch (error) {
      console.error('Error loading services:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Network Error';
      if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Network Error')) {
        showToast('Cannot connect to server. Please ensure the server is running.', 'error');
      } else {
        showToast('Error loading services: ' + errorMsg, 'error');
      }
      setServices([]); // Set empty array on error
    }
  }, [showToast]);

  const loadItems = useCallback(async () => {
    try {
      const res = await getItems({});
      const itemsList = res.data || [];
      console.log('Loaded items:', itemsList.length);
      setItems(itemsList);
      // If no items, show a message
      if (itemsList.length === 0) {
        console.warn('No items found. Please add items in the Price List page.');
      }
    } catch (error) {
      console.error('Error loading items:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Network Error';
      // Don't show error toast for items if table doesn't exist yet
      if (!errorMsg.includes('no such table') && !errorMsg.includes('does not exist')) {
        if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Network Error')) {
          showToast('Cannot connect to server. Please ensure the server is running.', 'error');
        }
      }
      setItems([]);
    }
  }, [showToast]);

  const loadExpressSettings = useCallback(async () => {
    try {
      const res = await getSettings();
      setExpressSettings(res.data);
    } catch (error) {
      console.error('Error loading express settings:', error);
    }
  }, []);

  const loadCustomers = useCallback(async (term) => {
    if (!term || !term.trim()) {
      setCustomers([]);
      setShowCustomerDropdown(false);
      return;
    }
    
    try {
      const res = await searchCustomers(term.trim());
      const customerList = res.data || [];
      console.log('Customer search results:', customerList.length, 'customers found for term:', term);
      setCustomers(customerList);
      // Show dropdown if we have results
      if (customerList.length > 0) {
        setShowCustomerDropdown(true);
      } else {
        // Keep dropdown open even with no results to show "no results" state
        setShowCustomerDropdown(true);
      }
    } catch (error) {
      console.error('Error loading customers:', error);
      console.error('Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
      });
      // Show error toast for debugging
      if (error.response?.status === 401) {
        showToast('Session expired. Please log in again.', 'error');
      } else if (error.message?.includes('Network Error') || error.message?.includes('ECONNREFUSED')) {
        showToast('Cannot connect to server on port 5000. Please ensure the server is running.', 'error');
      }
      setCustomers([]);
      setShowCustomerDropdown(false);
    }
  }, [showToast]);

  const loadCustomerHistory = useCallback(async () => {
    if (!selectedCustomer) return;
    try {
      const res = await getCustomerOrders(selectedCustomer.id);
      setCustomerHistory((res.data || []).slice(0, 3));
    } catch (error) {
      console.error('Error loading customer history:', error);
      setCustomerHistory([]);
    }
  }, [selectedCustomer]);

  // Service type multiplier: regular=1, wash_only/dry_only/press_only=0.5, express=2
  const getServiceTypeMultiplier = useCallback((type) => {
    switch (type) {
      case 'wash_only': case 'dry_only': case 'press_only': return 0.5;
      case 'express': return 2;
      default: return 1;
    }
  }, []);

  const calculateLineTotal = useCallback((item, service) => {
    const manualLineTotal = parseFloat(item.manual_line_total);
    if (item.manual_price_enabled && !Number.isNaN(manualLineTotal) && manualLineTotal >= 0) {
      return manualLineTotal;
    }

    let itemBaseTotal = 0;
    if (item.item_id && item.price !== undefined) {
      itemBaseTotal = parseFloat(item.price || 0) * (item.quantity || 1);
    } else if (service) {
      itemBaseTotal = (service.base_price || 0) * (item.quantity || 1);
      if (service.price_per_item > 0 && item.quantity) {
        itemBaseTotal += service.price_per_item * item.quantity;
      }
      if (service.price_per_kg > 0 && item.weight_kg) {
        itemBaseTotal += service.price_per_kg * parseFloat(item.weight_kg);
      }
    }

    const itemServiceType = item.service_type || 'regular';
    const serviceMultiplier = getServiceTypeMultiplier(itemServiceType);
    const useDeliverySurcharge = itemServiceType !== 'express';
    let itemTotal = itemBaseTotal * serviceMultiplier;
    if (useDeliverySurcharge && item.delivery_type !== 'standard' && item.express_surcharge_multiplier > 0) {
      itemTotal = itemTotal * item.express_surcharge_multiplier;
    }
    return itemTotal;
  }, [getServiceTypeMultiplier]);

  const roundMoney = useCallback((value) => {
    const n = Number(value) || 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }, []);

  const calculateTotal = useCallback(() => {
    let total = 0;
    orderItems.forEach(item => {
      const service = services.find(s => s.id === item.service_id);
      total += calculateLineTotal(item, service);
    });
    setTotalAmount(total);
  }, [orderItems, services, calculateLineTotal]);

  const discountAmount = useMemo(() => {
    const raw = parseFloat(receiptDiscountValue);
    if (Number.isNaN(raw) || raw <= 0) return 0;
    if (receiptDiscountType === 'percent') {
      return Math.min(totalAmount, (totalAmount * raw) / 100);
    }
    return Math.min(totalAmount, raw);
  }, [receiptDiscountType, receiptDiscountValue, totalAmount]);

  const payableTotal = useMemo(() => Math.max(0, totalAmount - discountAmount), [totalAmount, discountAmount]);

  const handleReset = useCallback(() => {
    setSelectedCustomer(null);
    setOrderItems([]);
    setDefaultDeliveryType('standard');
    setSelectedServiceType('regular');
    // Reset estimated collection date to default (72 hours from now)
    const now = new Date();
    const defaultDate = new Date(now);
    defaultDate.setDate(defaultDate.getDate() + 3); // 72 hours
    defaultDate.setHours(now.getHours(), now.getMinutes(), 0, 0);
    setEstimatedCollectionDate(defaultDate.toISOString().slice(0, 16));
    setOrderData({
      payment_status: 'not_paid',
      paid_amount: '',
      payment_method: 'cash'
    });
    setTotalAmount(0);
    setReceiptDiscountType('amount');
    setReceiptDiscountValue('');
    setOrderDateTime(toLocalDateTimeInput(new Date()));
    setManualReceiptNumber('');
    setSearchTerm('');
    setItemSearchTerm('');
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, []);

  // Keyboard shortcuts: Ctrl+N reset, F2 or Ctrl+F focus item search
  useEffect(() => {
    const handleKeyPress = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n' && !e.target.tagName.match(/INPUT|TEXTAREA|SELECT/)) {
        e.preventDefault();
        handleReset();
      }
      if (e.key === 'Escape' && showNewCustomer) {
        setShowNewCustomer(false);
      }
      if (e.key === 'F2' && !e.target.tagName.match(/INPUT|TEXTAREA|SELECT/)) {
        e.preventDefault();
        itemSearchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [showNewCustomer, handleReset]);

  useEffect(() => {
    loadServices();
    loadItems();
    loadExpressSettings();
    // Set default estimated collection date (72 hours from now unless cashier specifies otherwise)
    const now = new Date();
    const defaultDate = new Date(now);
    defaultDate.setDate(defaultDate.getDate() + 3); // 72 hours
    defaultDate.setHours(now.getHours(), now.getMinutes(), 0, 0);
    setEstimatedCollectionDate(defaultDate.toISOString().slice(0, 16)); // Format: YYYY-MM-DDTHH:mm
  }, [loadServices, loadItems, loadExpressSettings]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchTerm && searchTerm.trim()) {
        loadCustomers(searchTerm.trim());
      } else {
        setCustomers([]);
        setShowCustomerDropdown(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [searchTerm, loadCustomers]);

  // When search returns exactly one customer, auto-select so user can proceed to add items and pay
  useEffect(() => {
    if (customers.length === 1 && !selectedCustomer && searchTerm && searchTerm.trim()) {
      const customer = customers[0];
      setSelectedCustomer(customer);
      setSearchTerm(searchByPhone ? (customer.phone || customer.name) : (customer.name || customer.phone));
      setShowCustomerDropdown(false);
    }
  }, [customers, searchTerm, searchByPhone, selectedCustomer]);

  useEffect(() => {
    // Close dropdown when customer is selected
    if (selectedCustomer) {
      setShowCustomerDropdown(false);
    }
  }, [selectedCustomer]);

  useEffect(() => {
    if (selectedCustomer) {
      loadCustomerHistory();
      setShowCustomerDropdown(false);
    } else {
      setCustomerHistory([]);
    }
  }, [selectedCustomer, loadCustomerHistory]);

  useEffect(() => {
    // Close dropdown when clicking outside
    const handleClickOutside = (event) => {
      if (showCustomerDropdown && !event.target.closest('.customer-search-dropdown-wrapper')) {
        setShowCustomerDropdown(false);
      }
    };

    if (showCustomerDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showCustomerDropdown]);

  useEffect(() => {
    calculateTotal();
  }, [calculateTotal, expressSettings, orderData.payment_status]);

  useEffect(() => {
    // Update paid amount when payment status changes
    if (orderData.payment_status === 'paid_full') {
      setOrderData(prev => ({ ...prev, paid_amount: payableTotal.toFixed(2) }));
    } else if (orderData.payment_status === 'not_paid') {
      setOrderData(prev => ({ ...prev, paid_amount: '0' }));
    }
    // For advance, keep current value or set to 0
  }, [orderData.payment_status, payableTotal]);


  useEffect(() => {
    if (searchInputRef.current && !showNewCustomer) {
      searchInputRef.current.focus();
    }
  }, [showNewCustomer]);

  // Focus customer search on initial mount so cashier can type immediately
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInputRef.current && !showNewCustomer) searchInputRef.current.focus();
    }, 100);
    return () => clearTimeout(t);
  }, []);

  const filteredItems = useMemo(() => {
    const q = (itemSearchTerm || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => {
      const n = (i.name || '').toLowerCase();
      const c = (i.category || '').toLowerCase();
      return n.includes(q) || c.includes(q);
    });
  }, [items, itemSearchTerm]);
  const filteredServices = useMemo(() => {
    const q = (itemSearchTerm || '').trim().toLowerCase();
    if (!q) return services;
    return services.filter((s) => (s.name || '').toLowerCase().includes(q));
  }, [services, itemSearchTerm]);

  const handleServiceClick = (service) => {
    if (loading || isSubmittingRef.current) return;
    setOrderItems((prev) => {
      const existingItemIndex = prev.findIndex(
        (item) =>
          item.service_id === service.id &&
          item.delivery_type === defaultDeliveryType &&
          (!service.price_per_kg || item.weight_kg === '' || (!item.weight_kg && !(service.price_per_kg > 0)))
      );

      if (existingItemIndex >= 0) {
        const updatedItems = [...prev];
        updatedItems[existingItemIndex] = {
          ...updatedItems[existingItemIndex],
          quantity: updatedItems[existingItemIndex].quantity + 1,
        };
        showToast(`${service.name} quantity increased`, 'success');
        return updatedItems;
      }

      const deliveryType = selectedServiceType === 'express' ? 'same_day' : defaultDeliveryType;
      let expressMultiplier = 0;
      if (selectedServiceType !== 'express' && deliveryType === 'same_day') {
        expressMultiplier = parseFloat(expressSettings.express_same_day_multiplier?.value || 2);
      } else if (selectedServiceType !== 'express' && deliveryType === 'next_day') {
        expressMultiplier = parseFloat(expressSettings.express_next_day_multiplier?.value || 3);
      }

      const newItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        service_id: service.id,
        service_name: service.name,
        service_type: selectedServiceType,
        quantity: 1,
        weight_kg: service.price_per_kg > 0 ? '' : null,
        color: '',
        special_instructions: '',
        delivery_type: deliveryType,
        express_surcharge_multiplier: expressMultiplier,
        manual_line_total: '',
        manual_price_enabled: false,
      };

      pushRecent('service', service.id);
      showToast(`${service.name} added to order`, 'success');
      return [...prev, newItem];
    });
  };

  const handleUpdateItem = useCallback((itemId, updates) => {
    setOrderItems(prevItems => prevItems.map(item => {
      if (item.id === itemId) {
        const updated = { ...item, ...updates };
        if (updates.service_type === 'express') {
          updated.delivery_type = 'same_day';
          updated.express_surcharge_multiplier = 0;
        }
        // Recalculate express multiplier if delivery type changed
        if (updates.delivery_type) {
          const serviceType = updated.service_type || 'regular';
          if (serviceType === 'express') {
            updated.express_surcharge_multiplier = 0;
          } else if (updates.delivery_type === 'same_day') {
            updated.express_surcharge_multiplier = parseFloat(expressSettings.express_same_day_multiplier?.value || 2);
          } else if (updates.delivery_type === 'next_day') {
            updated.express_surcharge_multiplier = parseFloat(expressSettings.express_next_day_multiplier?.value || 3);
          } else {
            updated.express_surcharge_multiplier = 0;
          }
        }
        return updated;
      }
      return item;
    }));
  }, [expressSettings]);

  const handleRemoveItem = (itemId) => {
    setOrderItems(orderItems.filter(item => item.id !== itemId));
    showToast('Item removed', 'success');
  };

  const handleCreateCustomer = async (e) => {
    e.preventDefault();
    try {
      const res = await createCustomer(newCustomer);
      setSelectedCustomer(res.data);
      setShowNewCustomer(false);
      setNewCustomer({ name: '', phone: '', email: '', address: '' });
      loadCustomers();
      showToast(
        res.data.existing
          ? (res.data.message || 'Customer with this phone already exists. Using existing customer for your order.')
          : 'Customer created successfully',
        'success'
      );
    } catch (error) {
      showToast('Error creating customer: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  const handleSubmitOrder = async (e) => {
    e.preventDefault();
    if (!selectedCustomer) {
      showToast('Please select a customer', 'warning');
      return;
    }
    if (orderItems.length === 0) {
      showToast('Please add at least one item', 'warning');
      return;
    }
    if (orderData.payment_status === 'advance') {
      const paid = parseFloat(orderData.paid_amount) || 0;
      if (paid <= 0) {
        showToast('Please enter advance payment amount', 'warning');
        return;
      }
      if (paid > payableTotal) {
        showToast('Advance payment cannot exceed amount due', 'warning');
        return;
      }
    }
    const selectedOrderDate = parseDateTimeInput(orderDateTime);
    if (!selectedOrderDate || Number.isNaN(selectedOrderDate.getTime())) {
      showToast('Please select a valid receipt date and time', 'warning');
      return;
    }
    const todayLocal = toLocalDateTimeInput(new Date()).slice(0, 10);
    const selectedLocal = toLocalDateTimeInput(selectedOrderDate).slice(0, 10);
    const isBackdated = selectedLocal < todayLocal;
    if (isBackdated && !(manualReceiptNumber || '').trim()) {
      showToast('Backdated orders require a manual receipt ID', 'warning');
      return;
    }
    setShowConfirmOrderModal(true);
  };

  const handleConfirmOrderSubmit = async () => {
    if (isSubmittingRef.current || loading) return;
    isSubmittingRef.current = true;
    setShowConfirmOrderModal(false);
    setLoading(true);
    try {
      // Calculate payment amount based on payment status
      let paidAmount = 0;
      if (orderData.payment_status === 'paid_full') {
        paidAmount = payableTotal;
      } else if (orderData.payment_status === 'advance') {
        paidAmount = parseFloat(orderData.paid_amount) || 0;
      } else {
        paidAmount = 0; // not_paid
      }

      const selectedOrderDate = parseDateTimeInput(orderDateTime);
      if (!selectedOrderDate || Number.isNaN(selectedOrderDate.getTime())) {
        throw new Error('Invalid receipt date and time selected.');
      }
      const todayLocal = toLocalDateTimeInput(new Date()).slice(0, 10);
      const selectedLocal = toLocalDateTimeInput(selectedOrderDate).slice(0, 10);
      const isBackdated = selectedLocal < todayLocal;
      const trimmedManualReceipt = (manualReceiptNumber || '').trim();

      if (isBackdated && !trimmedManualReceipt) {
        throw new Error('Manual receipt ID is required for backdated orders.');
      }

      // Allocate receipt number and insert all lines in one server request
      const preDiscountLineTotals = orderItems.map((item) => {
        const service = services.find((s) => s.id === item.service_id);
        return Math.max(0, calculateLineTotal(item, service));
      });
      const preDiscountTotal = preDiscountLineTotals.reduce((sum, n) => sum + n, 0);
      const lineTotals = [...preDiscountLineTotals];
      if (discountAmount > 0 && preDiscountTotal > 0) {
        let allocated = 0;
        for (let idx = 0; idx < lineTotals.length; idx++) {
          if (idx === lineTotals.length - 1) {
            lineTotals[idx] = roundMoney(Math.max(0, payableTotal - allocated));
          } else {
            const ratio = preDiscountLineTotals[idx] / preDiscountTotal;
            const discounted = roundMoney(Math.max(0, preDiscountLineTotals[idx] - (discountAmount * ratio)));
            lineTotals[idx] = discounted;
            allocated += discounted;
          }
        }
      }
      const batchItems = orderItems.map((item, i) => {
        const itemTotal = lineTotals[i];
        const itemPayment =
          orderItems.length > 1
            ? (payableTotal > 0 ? paidAmount * (itemTotal / payableTotal) : 0)
            : paidAmount;
        return {
          item_id: item.item_id || null,
          service_id: item.service_id || (services[0]?.id || 1),
          quantity: parseInt(item.quantity, 10),
          weight_kg: item.weight_kg ? parseFloat(item.weight_kg) : null,
          color: item.color || null,
          garment_type: item.item_name || item.service_name || null,
          special_instructions: item.special_instructions || null,
          delivery_type: item.delivery_type || 'standard',
          express_surcharge_multiplier: item.express_surcharge_multiplier || 0,
          total_amount: itemTotal,
          paid_amount: itemPayment,
          payment_status: orderData.payment_status,
          payment_method: orderData.payment_method,
        };
      });

      const batchRes = await createOrderBatch({
        customer_id: selectedCustomer.id,
        items: batchItems,
        order_date: selectedOrderDate.toISOString(),
        estimated_collection_date: estimatedCollectionDate ? new Date(estimatedCollectionDate).toISOString() : null,
        payment_status: orderData.payment_status,
        payment_method: orderData.payment_method,
        created_by: 'Cashier',
        receipt_number: trimmedManualReceipt || undefined,
        ...(effectiveBranchId ? { branch_id: effectiveBranchId } : {}),
      });

      const receipts = batchRes.data?.items || [];

      if (receipts.length > 0) {
        const receiptNumberForSms = batchRes.data?.receipt_number || receipts[0].order.receipt_number;
        // Receipt SMS is built on the server from the receipt number — do not tie it to print success.
        const queueReceiptSms = () => {
          sendReceiptSms(receiptNumberForSms).catch((err) => {
            const msg = err?.response?.data?.error || err?.message || 'SMS failed';
            console.warn('Receipt SMS not sent:', msg);
            showToast(`Order saved. SMS notification could not be sent: ${msg}`, 'warning');
          });
        };
        // Always use consolidated receipt format for consistency (single or multiple items)
        try {
          const brand = await loadBrandSettings().catch(() => null);
          const combinedReceipt = await combineReceipts(receipts, selectedCustomer, payableTotal, orderData, discountAmount, brand);
          
          if (!combinedReceipt || !combinedReceipt.text || String(combinedReceipt.text).trim().length === 0) {
            console.error('Receipt text is empty:', combinedReceipt);
            showToast(`Order created! Receipt: ${receiptNumberForSms}. Receipt content is empty - please print from Orders page.`, 'warning');
            queueReceiptSms();
          } else {
            console.log('Printing receipt, length:', combinedReceipt.text.length);
            const receiptPayload = combinedReceipt.items
              ? { headerText: combinedReceipt.headerText, items: combinedReceipt.items, footerText: combinedReceipt.footerText, brandTitle: combinedReceipt.brandTitle || null }
              : combinedReceipt.text;
            await printReceipt(receiptPayload);
            showToast(`Order created! Receipt: ${receiptNumberForSms}`, 'success');
            playSuccessSound();
            queueReceiptSms();
          }
        } catch (printError) {
          console.error('Error printing receipt:', printError);
          showToast(`Order created! Receipt: ${receiptNumberForSms}. Use Print button in Orders page if receipt didn't print.`, 'warning');
          queueReceiptSms();
        }
      } else {
        showToast('Order creation completed but no receipts were generated.', 'warning');
      }

      handleReset();
    } catch (error) {
      // More detailed error logging
      console.error('Order creation error:', error);
      const errorMessage = error.response?.data?.error || error.message || 'Network Error';
      const detailedError = error.code === 'ECONNREFUSED' 
        ? 'Cannot connect to server. Please ensure the server is running on port 5000.'
        : error.code === 'ERR_NETWORK'
        ? 'Network error. Please check your connection and ensure the server is running.'
        : errorMessage;
      showToast('Error creating order: ' + detailedError, 'error');
    } finally {
      setLoading(false);
      isSubmittingRef.current = false;
    }
  };


  const RECEIPT_COMPACT_THRESHOLD = 12;

  const combineReceipts = async (receipts, customer, total, paymentData, discount = 0, brand = null) => {
    const businessName = (brand && brand.business_name) || 'SUPACLEAN';
    const tagline = (brand && brand.business_tagline) || 'Laundry & Dry Cleaning';
    const footerLine = (brand && brand.receipt_footer) || 'Thank you for choosing SUPACLEAN!';

    const now = receipts[0]?.order?.order_date ? new Date(receipts[0].order.order_date) : new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const calculatedTotal = receipts.reduce((sum, r) => sum + (parseFloat(r.order.total_amount) || 0), 0);
    const finalTotal = calculatedTotal > 0 ? calculatedTotal : total;
    const estimatedCollectionDate = receipts[0]?.order?.estimated_collection_date
      ? (() => {
          const estDate = new Date(receipts[0].order.estimated_collection_date);
          return `Est. Collection: ${String(estDate.getDate()).padStart(2, '0')}/${String(estDate.getMonth() + 1).padStart(2, '0')}/${estDate.getFullYear()} ${String(estDate.getHours()).padStart(2, '0')}:${String(estDate.getMinutes()).padStart(2, '0')}\n`;
        })()
      : '';

    const useCompact = receipts.length > RECEIPT_COMPACT_THRESHOLD;
    const totalReceiptItems = receipts.reduce((sum, r) => sum + (parseFloat(r?.order?.quantity) || 1), 0);
    const firstOrder = receipts[0]?.order;
    const customerReceiptId = formatCustomerReceiptId(
      firstOrder?.receipt_number,
      totalReceiptItems,
      firstOrder?.branch_code || branch?.code
    );
    const branchLabel =
      firstOrder?.branch_name ||
      (branch?.id === firstOrder?.branch_id ? branch?.name : null) ||
      (firstOrder?.branch_id ? `Branch ID ${firstOrder.branch_id}` : null) ||
      'Arusha';
    const branchLine = formatBranchReceiptLine(
      firstOrder || {
        branch_name: branch?.name,
        branch_id: effectiveBranchId,
        branch_code: branch?.code,
      }
    );

    const headerText = useCompact
      ? `${businessName} | ${branchLabel}\nReceipt: ${customerReceiptId} | ${dateStr}\n${estimatedCollectionDate}${customer.name} | ${customer.phone}\n`
      : `
═══════════════════════════════════
   ${tagline}
   ${branchLabel}, Tanzania
═══════════════════════════════════

Receipt No: ${customerReceiptId}
${branchLine}Date: ${dateStr}
${estimatedCollectionDate}
Customer: ${customer.name}
Phone: ${customer.phone}
───────────────────────────────────
`;
    const brandTitle = useCompact ? null : businessName;

    const items = [];
    receipts.forEach((r) => {
      const itemName = r.order.garment_type || r.service.name || 'Item';
      const quantity = r.order.quantity || 1;
      const color = r.order.color || '';
      const itemAmount = parseFloat(r.order.total_amount) || 0;
      let itemDescription = itemName;
      if (color) itemDescription += ` (${color})`;
      items.push({
        qty: String(quantity),
        desc: itemDescription,
        amount: `TSh ${itemAmount.toLocaleString()}`
      });
    });

    const sep = useCompact ? '─'.repeat(32) : '───────────────────────────────────────────';
    let footerText = `${sep}\n`;
    if ((Number(discount) || 0) > 0) {
      footerText += `DISCOUNT: -TSh ${Number(discount).toLocaleString()}\n`;
    }
    footerText += `TOTAL: TSh ${finalTotal.toLocaleString()}\n`;
    if (paymentData.payment_status === 'not_paid') {
      footerText += `NOT PAID\n`;
    } else if (paymentData.payment_status === 'paid_full') {
      footerText += `PAID (${paymentData.payment_method.toUpperCase()})\n`;
    } else {
      const paid = parseFloat(paymentData.paid_amount) || 0;
      footerText += `ADVANCE | Paid TSh ${paid.toLocaleString()} | Due TSh ${(finalTotal - paid).toLocaleString()}\n`;
    }
    footerText += useCompact
      ? `\nKeep for collection. Thank you!\n`
      : `\nPlease keep this receipt for collection.\n${footerLine}\n\n═══════════════════════════════════\n`;

    const text = (brandTitle ? `\n         ${brandTitle}\n` : '') + headerText.trimStart() + items.map((i) => `${i.qty}  ${i.desc}  ${i.amount}`).join('\n') + '\n' + footerText;
    return { text, headerText, items, footerText, brandTitle };
  };

  // Accepts either receiptText (string) or { headerText, items, footerText, brandTitle } for centered layout with table (desc wraps, amount visible).
  const printReceipt = async (receiptTextOrData) => {
    const isStructured = receiptTextOrData && typeof receiptTextOrData === 'object' && Array.isArray(receiptTextOrData.items);
    const receiptText = isStructured ? null : (receiptTextOrData && typeof receiptTextOrData === 'string' ? receiptTextOrData : '');
    if (!isStructured && (!receiptText || !receiptText.trim())) {
      console.error('Invalid receipt text provided:', receiptTextOrData);
      showToast('Error: Invalid receipt data. Cannot print.', 'error');
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
            <title>Receipt - ${isStructured && receiptTextOrData.brandTitle ? receiptTextOrData.brandTitle : 'Receipt'}</title>
            <meta charset="UTF-8">
            <style>
              @media screen { body { font-family: 'Courier New', monospace; padding: 20px; max-width: ${receiptWidthCss}; margin: 0 auto; background: #f5f5f5; } }
              @media print {
                @page { size: ${receiptWidthCss} auto; margin: 0; }
                html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; color: #000 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                .receipt-sheet { width: ${receiptWidthCss}; max-width: ${receiptWidthCss}; height: auto !important; min-height: 0 !important; overflow: visible !important; color: #000 !important; }
                body { font-family: 'Courier New', monospace; padding: ${receiptPadding}; margin: 0; background: white; font-weight: 600; width: ${receiptWidthCss}; max-width: ${receiptWidthCss}; box-sizing: border-box; font-size: ${receiptFontSize}; }
                pre, .receipt-items, .receipt-items th, .receipt-items td { color: #000 !important; font-weight: 600; }
                .receipt-items .r-desc { color: #000 !important; font-weight: 600; }
                .receipt-footer { font-weight: bold; color: #000 !important; }
                .receipt-end p { font-weight: bold; color: #000 !important; }
                pre { margin: 0; padding: 0; white-space: pre; overflow: visible; }
                body.receipt-compact pre, body.receipt-compact .receipt-items { font-size: ${receiptCompactFontSize}; }
                .receipt-end { margin-top: 6px; page-break-inside: avoid; }
                * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              }
              .receipt-sheet { text-align: center; margin: 0 auto; max-width: ${receiptWidthCss}; color: #000; font-weight: 600; }
              .receipt-brand { font-weight: bold; text-align: center; margin: ${receiptBrandMargin}; font-size: ${receiptBrandFontSize}; color: #000; }
              body:not(.receipt-compact) pre, body:not(.receipt-compact) .receipt-items { font-size: ${receiptFontSize}; line-height: 1.15; }
              body.receipt-compact pre, body.receipt-compact .receipt-items { font-size: ${receiptCompactFontSize}; line-height: 1.05; }
              pre { margin: 0; color: #000; white-space: pre; font-weight: 600; }
              .receipt-items th, .receipt-items td { color: #000; font-weight: 600; }
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

    const forceSameWindow = typeof process !== 'undefined' && process.env && process.env.REACT_APP_FORCE_RECEIPT_SAME_WINDOW === 'true';
    const isSmallScreen = typeof window !== 'undefined' && window.innerWidth <= 600;
    const sameWindowPrint = forceSameWindow || isSmallScreen;
    const runInPagePrint = () => {
      const printContainer = document.createElement('div');
      printContainer.id = 'receipt-print-container';
      printContainer.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
      const inner = document.createElement('div');
      inner.style.cssText = `width:${receiptWidthCss};max-width:100%;min-height:80px;background:white;padding:${receiptPadding};font-family:'Courier New',monospace;font-size:${receiptFontSize};font-weight:600;color:#000;text-align:center;border-radius:8px`;
      const fallbackBody = isStructured
        ? (receiptTextOrData.brandTitle ? `<div class="receipt-brand" style="font-weight:bold;text-align:center;margin:${receiptBrandMargin};color:#000">${escape(receiptTextOrData.brandTitle)}</div>` : '') + `<pre class="receipt-header" style="margin:0;text-align:center;color:#000;font-weight:600">${escape(receiptTextOrData.headerText)}</pre><table class="receipt-items" style="width:100%;margin:4px 0;font-size:${receiptFontSize};border-collapse:collapse;color:#000;font-weight:600"><thead><tr><th style="text-align:center">Qty</th><th style="text-align:left">Item</th><th style="text-align:right">TSh</th></tr></thead><tbody>${receiptTextOrData.items.map((r) => `<tr><td style="text-align:center">${escape(r.qty)}</td><td class="r-desc" style="text-align:left;word-wrap:break-word;word-break:break-word;color:#000;font-weight:600">${escape(r.desc)}</td><td style="text-align:right;white-space:nowrap">${escape(r.amount)}</td></tr>`).join('')}</tbody></table><pre class="receipt-footer" style="margin:0;text-align:center;color:#000;font-weight:bold">${escape(receiptTextOrData.footerText)}</pre>`
        : `<pre style="white-space:pre-wrap;word-wrap:break-word;margin:0;color:#000;font-weight:600">${escape(receiptText)}</pre>`;
      inner.innerHTML = fallbackBody + termsQrBlock;
      if (compact) {
        const pre = inner.querySelector('pre');
        if (pre) { pre.style.fontSize = receiptCompactFontSize; pre.style.lineHeight = '1.05'; }
      }
      printContainer.appendChild(inner);
      const printStyle = document.createElement('style');
      printStyle.textContent = `#receipt-print-container .receipt-end p{font-weight:bold;color:#000}#receipt-print-container .receipt-footer{font-weight:bold;color:#000}#receipt-print-container .r-desc{color:#000;font-weight:600}@media print{@page{size:${receiptWidthCss} auto;margin:0}body *{visibility:hidden !important}#receipt-print-container,#receipt-print-container *{visibility:visible !important}#receipt-print-container{position:absolute !important;left:0 !important;top:0 !important;right:auto !important;bottom:auto !important;background:white !important;padding:${receiptPadding} !important;width:${receiptWidthCss} !important;max-width:${receiptWidthCss} !important;min-height:1px !important}#receipt-print-container>div{background:white !important;min-height:1px !important}}`;
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
      let printWindow = null;
      try {
        printWindow = window.open('', '_blank', 'width=320,height=500,scrollbars=yes');
      } catch (e) {
        console.error('Error opening print window:', e);
      }
      if (!printWindow || printWindow.closed || typeof printWindow.closed === 'undefined') {
        showToast('Using same-window print (better for built-in printer).', 'info');
        runInPagePrint();
        return;
      }
      printWindow.document.open();
      printWindow.document.write(printHTML);
      printWindow.document.close();
      showToast('Receipt print dialog opened. Select your thermal printer if needed.', 'success');
    } catch (e) {
      console.error('Error printing:', e);
      showToast('Print failed. Trying same-window print...', 'info');
      runInPagePrint();
    }
  };

  const getServiceIcon = (serviceName) => {
    if (serviceName.includes('Wash')) return '🧺';
    if (serviceName.includes('Press')) return '👔';
    if (serviceName.includes('Express')) return '⚡';
    if (serviceName.includes('Suit')) return '👔';
    if (serviceName.includes('Shirt')) return '👕';
    if (serviceName.includes('Trouser')) return '👖';
    if (serviceName.includes('Coat')) return '🧥';
    if (serviceName.includes('Dress')) return '👗';
    if (serviceName.includes('Skirt')) return '👗';
    if (serviceName.includes('Bed')) return '🛏️';
    if (serviceName.includes('Curtain')) return '🪟';
    if (serviceName.includes('Carpet')) return '🏺';
    return '👕';
  };

  const getItemIcon = (itemName, category) => {
    const name = (itemName || '').toLowerCase();
    const cat = (category || '').toLowerCase();
    
    // Category-based icons
    if (cat.includes('gent') || cat.includes('men')) return '👔';
    if (cat.includes('ladi') || cat.includes('women')) return '👗';
    
    // Item name-based icons
    if (name.includes('shirt') || name.includes('tshirt') || name.includes('t-shirt')) return '👕';
    if (name.includes('trouser') || name.includes('pant')) return '👖';
    if (name.includes('suit')) return '👔';
    if (name.includes('dress')) return '👗';
    if (name.includes('skirt')) return '👗';
    if (name.includes('coat') || name.includes('jacket')) return '🧥';
    if (name.includes('blanket') || name.includes('bed')) return '🛏️';
    if (name.includes('curtain')) return '🪟';
    if (name.includes('carpet') || name.includes('rug')) return '🏺';
    if (name.includes('towel')) return '🧼';
    if (name.includes('sheet')) return '🛏️';
    
    return '👕'; // Default icon
  };

  const handleItemClick = (item) => {
    if (loading || isSubmittingRef.current) return;
    setOrderItems((prev) => {
      const existingItemIndex = prev.findIndex(
        (orderItem) =>
          orderItem.item_id === item.id && orderItem.delivery_type === defaultDeliveryType
      );

      if (existingItemIndex >= 0) {
        const updatedItems = [...prev];
        updatedItems[existingItemIndex] = {
          ...updatedItems[existingItemIndex],
          quantity: updatedItems[existingItemIndex].quantity + 1,
        };
        showToast(`${item.name} quantity increased`, 'success');
        return updatedItems;
      }

      // Point price-list lines at the item's own service counterpart (same name)
      // so service linkage, receipts, and service-based reports carry the real
      // item — falls back to a "regular"-named delivery service, then first.
      const defaultService =
        services.find((s) => (s.name || '').toLowerCase() === (item.name || '').toLowerCase()) ||
        services.find((s) => (s.name || '').toLowerCase().includes('regular')) ||
        services[0];
      const deliveryType = selectedServiceType === 'express' ? 'same_day' : defaultDeliveryType;
      let expressMultiplier = 0;
      if (selectedServiceType !== 'express' && deliveryType === 'same_day') {
        expressMultiplier = parseFloat(expressSettings.express_same_day_multiplier?.value || 2);
      } else if (selectedServiceType !== 'express' && deliveryType === 'next_day') {
        expressMultiplier = parseFloat(expressSettings.express_next_day_multiplier?.value || 3);
      }

      const newItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        item_id: item.id,
        item_name: item.name,
        service_id: defaultService?.id || null,
        service_name: defaultService?.name || 'Standard Service',
        service_type: selectedServiceType,
        quantity: 1,
        weight_kg: null,
        color: '',
        special_instructions: '',
        delivery_type: deliveryType,
        express_surcharge_multiplier: expressMultiplier,
        price: parseFloat(item.price || item.base_price || 0),
        manual_line_total: '',
        manual_price_enabled: false,
      };

      pushRecent('item', item.id);
      showToast(`${item.name} added to order`, 'success');
      return [...prev, newItem];
    });
  };

  const recentList = useMemo(() => {
    const raw = getRecentFromStorage();
    return raw
      .map((e) => {
        if (e.t === 's') {
          const s = services.find((sv) => sv.id === e.id);
          return s ? { type: 'service', data: s } : null;
        }
        const i = items.find((it) => it.id === e.id);
        return i ? { type: 'item', data: i } : null;
      })
      .filter(Boolean);
  }, [services, items, orderItems.length]); // re-read when cart changes so Recent updates after add

  return (
    <div className="new-order-modern">
      <ToastContainer />
      <div className="order-header-modern">
        <div>
          <h1>New Order</h1>
          <p className="subtitle">Create a new laundry order</p>
        </div>
        <div className="header-actions">
          <button onClick={handleReset} className="dk-btn dk-btn--secondary dk-btn--md" type="button">
            🔄 Reset (Ctrl+N)
          </button>
        </div>
      </div>

      <div className="order-layout">
        <div className="order-left-panel">
          <div className="panel-section">
            <h2 className="section-title">
              <span>👤</span> Customer
            </h2>
            {!showNewCustomer ? (
              <div className="customer-selection-modern">
                <div className="customer-search-dropdown-wrapper">
                  <div className="search-toggle-compact">
                    <button
                      type="button"
                      className={searchByPhone ? 'active' : ''}
                      onClick={() => setSearchByPhone(true)}
                      title="Search by phone"
                    >
                      📱
                    </button>
                    <button
                      type="button"
                      className={!searchByPhone ? 'active' : ''}
                      onClick={() => setSearchByPhone(false)}
                      title="Search by name"
                    >
                      👤
                    </button>
                  </div>
                  <div className="search-input-wrapper">
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder={selectedCustomer ? selectedCustomer.name : (searchByPhone ? "Phone number..." : "Customer name...")}
                      value={selectedCustomer && !searchTerm ? selectedCustomer.name : searchTerm}
                      aria-label={searchByPhone ? "Search customer by phone" : "Search customer by name"}
                      onChange={(e) => {
                        const value = e.target.value;
                        setSearchTerm(value);
                        // Clear selected customer when user starts typing
                        if (selectedCustomer) {
                          setSelectedCustomer(null);
                        }
                        // Show dropdown immediately when typing
                        if (value.trim()) {
                          setShowCustomerDropdown(true);
                        } else {
                          setShowCustomerDropdown(false);
                        }
                      }}
                      onFocus={() => {
                        // If we have a search term and customers, show dropdown
                        if (searchTerm && searchTerm.trim()) {
                          setShowCustomerDropdown(true);
                        }
                      }}
                      className="search-input-compact"
                    />
                    {selectedCustomer && (
                      <button
                        type="button"
                        className="clear-customer-btn"
                        onClick={() => {
                          setSelectedCustomer(null);
                          setSearchTerm('');
                          setShowCustomerDropdown(false);
                          if (searchInputRef.current) {
                            searchInputRef.current.focus();
                          }
                        }}
                        title="Clear selection"
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {showCustomerDropdown && !selectedCustomer && searchTerm && searchTerm.trim() && (
                    <div className="customer-dropdown-list" role="listbox">
                      {customers.length > 0 ? (
                        customers.map(customer => (
                          <div
                            key={customer.id}
                            className="customer-dropdown-item"
                            role="option"
                            aria-selected={selectedCustomer?.id === customer.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setSelectedCustomer(customer);
                              setSearchTerm(searchByPhone ? (customer.phone || customer.name) : (customer.name || customer.phone));
                              setShowCustomerDropdown(false);
                            }}
                          >
                            <div className="customer-avatar-mini">
                              {(customer.name || '?').charAt(0).toUpperCase()}
                            </div>
                            <div className="customer-dropdown-details">
                              <strong>{customer.name}</strong>
                              <span>{customer.phone}</span>
                              {customer.branch_name && (
                                <span className="customer-dropdown-branch">Home: {customer.branch_code || customer.branch_name}</span>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="customer-dropdown-item" style={{ cursor: 'default', opacity: 0.6 }}>
                          <div className="customer-dropdown-details">
                            <span>No customers found matching "{searchTerm}"</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {selectedCustomer && (
                  <div className="selected-customer-compact">
                    <div className="customer-info-compact">
                      <div className="avatar-medium">
                        {(selectedCustomer.name || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="customer-info-text">
                        <strong>{selectedCustomer.name}</strong>
                        <span>{selectedCustomer.phone}</span>
                        {customerHistory.length > 0 && (
                          <div className="customer-history-compact">
                            <small>Last order: {customerHistory[0]?.service_name}</small>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {!selectedCustomer && (
                  <button
                    type="button"
                    className="btn-secondary btn-full btn-compact"
                    onClick={() => setShowNewCustomer(true)}
                  >
                    + Add New Customer
                  </button>
                )}
              </div>
            ) : (
              <div className="new-customer-form-modern">
                <h3>New Customer</h3>
                <div className="form-grid">
                  <input
                    type="text"
                    placeholder="Full Name *"
                    value={newCustomer.name}
                    onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })}
                    required
                    autoFocus
                  />
                  <input
                    type="tel"
                    placeholder="Phone Number *"
                    value={newCustomer.phone}
                    onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                    required
                  />
                  <input
                    type="email"
                    placeholder="Email (optional)"
                    value={newCustomer.email}
                    onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                  />
                  <input
                    type="text"
                    placeholder="Address (optional)"
                    value={newCustomer.address}
                    onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })}
                  />
                </div>
                <div className="form-actions-inline">
                  <button type="button" onClick={handleCreateCustomer} className="btn-primary">
                    Create Customer
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setShowNewCustomer(false)}
                  >
                    Cancel (Esc)
                  </button>
                </div>
              </div>
            )}
          </div>

          <div
            className="panel-section panel-section-items"
            role="region"
            aria-label="Items and services"
          >
            <div className="items-header-sticky">
              <h2 className="section-title section-title-no-sticky items-panel-title">
                <span aria-hidden>🧺</span> {items.length > 0 ? 'Items & Services' : 'Services'}
              </h2>
              <div className="items-panel-service-row">
                <label className="items-panel-label">Default service type (for new lines)</label>
                <div className="delivery-options service-type-options" role="group" aria-label="Service type">
                  {[
                    { id: 'regular', label: 'Regular', icon: '📦', title: 'Price list rates (default)' },
                    { id: 'wash_only', label: 'Wash only', icon: '🧴', title: 'Half price' },
                    { id: 'dry_only', label: 'Dry only', icon: '🌀', title: 'Half price' },
                    { id: 'press_only', label: 'Press only', icon: '👔', title: 'Half price' },
                    { id: 'express', label: 'Express', icon: '⚡', title: 'Same-day, double price' }
                  ].map(({ id, label, icon, title }) => (
                    <button
                      key={id}
                      type="button"
                      className={`delivery-option-btn service-type-btn ${selectedServiceType === id ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedServiceType(id);
                        setDefaultDeliveryType(id === 'express' ? 'same_day' : 'standard');
                      }}
                      title={title}
                      aria-pressed={selectedServiceType === id}
                    >
                      <span aria-hidden>{icon}</span>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                {selectedServiceType === 'express' && (
                  <p className="express-notice" role="status">New lines default to Express: same-day delivery, price ×2</p>
                )}
                <p className="items-panel-hint">Each line can be changed independently in the order summary (service type and amount).</p>
              </div>
              <div className="items-search-row">
                <input
                  ref={itemSearchInputRef}
                  type="text"
                  placeholder="Search items & services..."
                  value={itemSearchTerm}
                  onChange={(e) => setItemSearchTerm(e.target.value)}
                  className="items-search-input"
                  aria-label="Quick search items and services"
                  title="Search items and services (F2)"
                />
                {itemSearchTerm.trim() && (
                  <button
                    type="button"
                    className="items-search-clear"
                    onClick={() => { setItemSearchTerm(''); itemSearchInputRef.current?.focus(); }}
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div
              className="items-scroll-wrap"
              role="region"
              aria-label="Items and services list"
            >
            {recentList.length > 0 && (
              <div className="recent-items-strip">
                <span className="recent-items-label">Recent:</span>
                <div className="recent-items-chips">
                  {recentList.map((r) => (
                    r.type === 'service' ? (
                      <button
                        key={`s-${r.data.id}`}
                        type="button"
                        className="recent-chip"
                        onClick={() => handleServiceClick(r.data)}
                        title={r.data.name}
                      >
                        {getServiceIcon(r.data.name)} <span>{r.data.name.length > 20 ? r.data.name.slice(0, 18) + '…' : r.data.name}</span>
                      </button>
                    ) : (
                      <button
                        key={`i-${r.data.id}`}
                        type="button"
                        className="recent-chip"
                        onClick={() => handleItemClick(r.data)}
                        title={r.data.name}
                      >
                        {getItemIcon(r.data.name, r.data.category)} <span>{r.data.name.length > 20 ? r.data.name.slice(0, 18) + '…' : r.data.name}</span>
                      </button>
                    )
                  ))}
                </div>
              </div>
            )}
            {/* Show Items if available, otherwise show Services */}
            {items.length > 0 ? (
              <>
                <div className="items-section">
                  <h3 className="items-list-subtitle">
                    <span aria-hidden>📋</span> Items{itemSearchTerm.trim() ? ` · ${filteredItems.length} match` : ''}
                  </h3>
                  <ul className="items-services-list" aria-label="Items from price list">
                    {filteredItems.length === 0 ? (
                      <li className="items-search-empty-row">
                        <span>{itemSearchTerm.trim() ? `No items match "${itemSearchTerm.trim()}"` : 'No items in price list.'}</span>
                      </li>
                    ) : (
                      filteredItems.map(item => {
                        const itemInCart = orderItems.find(orderItem => orderItem.item_id === item.id);
                        const itemCount = itemInCart ? itemInCart.quantity : 0;
                        return (
                          <li
                            key={`item-${item.id}`}
                            className={`items-services-list-row ${itemCount > 0 ? 'in-cart' : ''}`}
                            onClick={() => handleItemClick(item)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleItemClick(item); } }}
                          >
                            <span className="list-row-icon" aria-hidden>{getItemIcon(item.name, item.category)}</span>
                            <span className="list-row-name">{item.name}{item.category ? ` · ${String(item.category).toLowerCase()}` : ''}</span>
                            <span className="list-row-price">TSh {parseFloat(item.price || item.base_price || 0).toLocaleString()}</span>
                            {itemCount > 0 && <span className="list-row-qty">{itemCount}</span>}
                          </li>
                        );
                      })
                    )}
                  </ul>
                </div>
                
                {services.length > 0 && (
                  <div className="items-section items-section-services">
                    <h3 className="items-list-subtitle">
                      <span aria-hidden>🧺</span> Services{itemSearchTerm.trim() ? ` · ${filteredServices.length} match` : ''}
                    </h3>
                    <ul className="items-services-list" aria-label="Services">
                      {filteredServices.length === 0 ? (
                        <li className="items-search-empty-row"><span>No services match "{itemSearchTerm.trim()}"</span></li>
                      ) : (
                        filteredServices.map(service => {
                          const itemInCart = orderItems.find(item => item.service_id === service.id);
                          const itemCount = itemInCart ? itemInCart.quantity : 0;
                          const extra = [service.price_per_kg > 0 && `+${service.price_per_kg.toLocaleString()}/kg`, service.price_per_item > 0 && `+${service.price_per_item.toLocaleString()}/item`].filter(Boolean).join(' ');
                          return (
                            <li
                              key={`service-${service.id}`}
                              className={`items-services-list-row ${itemCount > 0 ? 'in-cart' : ''}`}
                              onClick={() => handleServiceClick(service)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleServiceClick(service); } }}
                            >
                              <span className="list-row-icon" aria-hidden>{getServiceIcon(service.name)}</span>
                              <span className="list-row-name">{service.name}{extra ? ` · ${extra}` : ''}</span>
                              <span className="list-row-price">TSh {service.base_price.toLocaleString()}</span>
                              {itemCount > 0 && <span className="list-row-qty">{itemCount}</span>}
                            </li>
                          );
                        })
                      )}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <>
              <h3 className="items-list-subtitle"><span aria-hidden>🧺</span> Services{itemSearchTerm.trim() ? ` · ${filteredServices.length} match` : ''}</h3>
              <ul className="items-services-list" aria-label="Services">
                {filteredServices.length === 0 ? (
                  <li className="items-search-empty-row">
                    <span>{itemSearchTerm.trim() ? `No services match "${itemSearchTerm.trim()}"` : 'No services available.'}</span>
                  </li>
                ) : (
                  filteredServices.map(service => {
                    const itemInCart = orderItems.find(item => item.service_id === service.id);
                    const itemCount = itemInCart ? itemInCart.quantity : 0;
                    const extra = [service.price_per_kg > 0 && `+${service.price_per_kg.toLocaleString()}/kg`, service.price_per_item > 0 && `+${service.price_per_item.toLocaleString()}/item`].filter(Boolean).join(' ');
                    return (
                      <li
                        key={service.id}
                        className={`items-services-list-row ${itemCount > 0 ? 'in-cart' : ''}`}
                        onClick={() => handleServiceClick(service)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleServiceClick(service); } }}
                      >
                        <span className="list-row-icon" aria-hidden>{getServiceIcon(service.name)}</span>
                        <span className="list-row-name">{service.name}{extra ? ` · ${extra}` : ''}</span>
                        <span className="list-row-price">TSh {service.base_price.toLocaleString()}</span>
                        {itemCount > 0 && <span className="list-row-qty">{itemCount}</span>}
                      </li>
                    );
                  })
                )}
              </ul>
              </>
            )}
            </div>
          </div>
        </div>

        <div className="order-right-panel">
          <div className="order-summary-card">
            <h2 className="section-title">Order Summary</h2>
            
            {orderItems.length > 0 ? (
              <>
                <div className="order-items-list">
                  {orderItems.map((item, index) => {
                    // Find service for this item (if it has a service_id)
                    const service = item.service_id ? services.find(s => s.id === item.service_id) : null;
                    
                    const itemFinalTotal = calculateLineTotal(item, service);
                    
                    return (
                      <div key={item.id} className="order-item-card">
                        <div className="item-info">
                          <div className="item-header">
                            <strong>{item.item_name || item.service_name}</strong>
                            {item.manual_price_enabled && (
                              <span className="express-badge-small" title="Manual line price override is active">
                                Manual Price Active
                              </span>
                            )}
                            {item.delivery_type !== 'standard' && (
                              <span className="express-badge-small">
                                {item.delivery_type === 'same_day' ? '⚡' : '🚀'}
                              </span>
                            )}
                          </div>
                          
                          <div className="color-edit-section">
                            <label className="color-label">Color Description:</label>
                            <ColorInput 
                              value={item.color || ''} 
                              onChange={(color) => handleUpdateItem(item.id, { color })}
                              itemId={item.id}
                            />
                          </div>

                          <div className="item-controls">
                            <div className="form-group-modern" style={{ marginBottom: 8 }}>
                              <label style={{ fontSize: 12, marginBottom: 4 }}>Service for this line</label>
                              <select
                                value={item.service_type || 'regular'}
                                onChange={(e) => handleUpdateItem(item.id, { service_type: e.target.value })}
                              >
                                <option value="regular">Regular</option>
                                <option value="wash_only">Wash only</option>
                                <option value="dry_only">Dry only</option>
                                <option value="press_only">Press only</option>
                                <option value="express">Express</option>
                              </select>
                            </div>

                            <div className="qty-control-inline">
                              <button
                                type="button"
                                className="qty-btn-small"
                                onClick={() => handleUpdateItem(item.id, { quantity: Math.max(1, item.quantity - 1) })}
                              >
                                −
                              </button>
                              <span className="qty-display">{item.quantity}</span>
                              <button
                                type="button"
                                className="qty-btn-small"
                                onClick={() => handleUpdateItem(item.id, { quantity: item.quantity + 1 })}
                              >
                                +
                              </button>
                            </div>
                            {service?.price_per_kg > 0 && (
                              <div className="weight-control">
                                <input
                                  type="number"
                                  step="0.1"
                                  min="0"
                                  placeholder="kg"
                                  value={item.weight_kg || ''}
                                  onChange={(e) => handleUpdateItem(item.id, { weight_kg: e.target.value })}
                                  className="weight-input-small"
                                />
                              </div>
                            )}
                            <div className="weight-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <button
                                type="button"
                                className={`btn-secondary ${item.manual_price_enabled ? 'active' : ''}`}
                                onClick={() =>
                                  handleUpdateItem(item.id, {
                                    manual_price_enabled: !item.manual_price_enabled,
                                    ...(item.manual_price_enabled ? { manual_line_total: '' } : {})
                                  })
                                }
                                title="Set manual line price for tailoring/extra charges"
                              >
                                {item.manual_price_enabled ? 'Use Auto Price' : 'Set Manual Price'}
                              </button>
                              {item.manual_price_enabled && (
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  placeholder="Manual line price (TSh)"
                                  value={item.manual_line_total || ''}
                                  onChange={(e) => handleUpdateItem(item.id, { manual_line_total: e.target.value })}
                                  className="weight-input-small"
                                />
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="item-price-actions">
                          <div className="item-price">TSh {itemFinalTotal.toLocaleString()}</div>
                          <button
                            type="button"
                            className="remove-item-btn"
                            onClick={() => handleRemoveItem(item.id)}
                            title="Remove item"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="payment-section-modern">
                  <div className="total-display-modern">
                    <div className="total-line">
                      <span>Subtotal:</span>
                      <span>TSh {totalAmount.toLocaleString()}</span>
                    </div>
                    <div className="total-line">
                      <span>Receipt Discount:</span>
                      <span>- TSh {discountAmount.toLocaleString()}</span>
                    </div>
                    <div className="total-line total-amount">
                      <span>Total Amount:</span>
                      <strong>TSh {payableTotal.toLocaleString()}</strong>
                    </div>
                  </div>

                  <div className="payment-inputs">
                    <div className="form-group-modern">
                      <label>Receipt Discount (Apply at end)</label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <select
                          value={receiptDiscountType}
                          onChange={(e) => setReceiptDiscountType(e.target.value)}
                          style={{ maxWidth: 140 }}
                        >
                          <option value="amount">Amount (TSh)</option>
                          <option value="percent">Percent (%)</option>
                        </select>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={receiptDiscountValue}
                          onChange={(e) => setReceiptDiscountValue(e.target.value)}
                          placeholder={receiptDiscountType === 'percent' ? 'e.g. 10' : 'e.g. 1500'}
                        />
                      </div>
                    </div>

                    <div className="form-group-modern">
                      <label>Payment Status</label>
                      <div className="payment-status-options">
                        <button
                          type="button"
                          className={`payment-status-btn ${orderData.payment_status === 'not_paid' ? 'active' : ''}`}
                          onClick={() => setOrderData({ ...orderData, payment_status: 'not_paid', paid_amount: '0' })}
                        >
                          💳 NOT PAID
                          <small>(Pay on Delivery)</small>
                        </button>
                        <button
                          type="button"
                          className={`payment-status-btn ${orderData.payment_status === 'advance' ? 'active' : ''}`}
                          onClick={() => setOrderData({ ...orderData, payment_status: 'advance', paid_amount: '' })}
                        >
                          💰 ADVANCE
                          <small>(Partial Payment)</small>
                        </button>
                        <button
                          type="button"
                          className={`payment-status-btn ${orderData.payment_status === 'paid_full' ? 'active' : ''}`}
                          onClick={() => setOrderData({ ...orderData, payment_status: 'paid_full', paid_amount: payableTotal.toFixed(2) })}
                        >
                          ✅ PAID FULL
                          <small>(Fully Paid)</small>
                        </button>
                      </div>
                    </div>

                    {orderData.payment_status === 'advance' && (
                      <div className="form-group-modern">
                        <label>Advance Payment Amount</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max={payableTotal}
                          value={orderData.paid_amount}
                          onChange={(e) => setOrderData({ ...orderData, paid_amount: e.target.value })}
                          placeholder="Enter amount..."
                        />
                        {orderData.paid_amount && (
                          <div className="balance-display">
                            Balance Due: TSh {(payableTotal - (parseFloat(orderData.paid_amount) || 0)).toLocaleString()}
                          </div>
                        )}
                      </div>
                    )}

                    {orderData.payment_status !== 'not_paid' && (
                      <div className="form-group-modern">
                        <label>Payment Method</label>
                        <div className="payment-methods">
                          {['cash', 'card', 'mobile_money', 'bank_transfer'].map(method => (
                            <button
                              key={method}
                              type="button"
                              className={`payment-method-btn ${orderData.payment_method === method ? 'active' : ''}`}
                              onClick={() => setOrderData({ ...orderData, payment_method: method })}
                            >
                              {method === 'cash' ? '💵 Cash' : method === 'card' ? '💳 Card' : method === 'mobile_money' ? '📱 Mobile Money' : '🏦 Bank Transfer'}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="form-group-modern">
                      <label>Receipt Date & Time</label>
                      <input
                        type="datetime-local"
                        value={orderDateTime || ''}
                        onChange={(e) => setOrderDateTime(e.target.value)}
                        className="datetime-input"
                      />
                      <small className="form-hint">
                        Use this when recording orders from a previous day.
                      </small>
                    </div>

                    <div className="form-group-modern">
                      <label>Manual Receipt ID (Optional)</label>
                      <input
                        type="text"
                        value={manualReceiptNumber}
                        onChange={(e) => setManualReceiptNumber(e.target.value)}
                        placeholder="e.g. 145-19-03 (26)"
                      />
                      <small className="form-hint">
                        Required for backdated entries. Leave blank for automatic ID on today&apos;s orders.
                      </small>
                    </div>

                    <div className="form-group-modern">
                      <label>Estimated Collection Date & Time</label>
                      <input
                        type="datetime-local"
                        value={estimatedCollectionDate || ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val) {
                            setEstimatedCollectionDate(val);
                          }
                        }}
                        min={toLocalDateTimeInput(new Date())}
                        className="datetime-input"
                      />
                      <small className="form-hint">
                        Default: 72 hours from order time. Change if the cashier specifies a different collection time.
                      </small>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-primary btn-large btn-full"
                    onClick={handleSubmitOrder}
                    disabled={!selectedCustomer || orderItems.length === 0 || loading}
                  >
                    {loading ? '⏳ Processing...' : '✅ Complete Order & Print Receipt'}
                  </button>
                </div>
              </>
            ) : (
              <div className="empty-order-state">
                <div className="empty-icon">🛒</div>
                <p>Click service icons to add items</p>
                <small>Items will be added to cart automatically</small>
              </div>
            )}
          </div>
        </div>
      </div>

      {showConfirmOrderModal && (
        <div className="confirm-order-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-order-title">
          <div className="confirm-order-modal">
            <h2 id="confirm-order-title">Review & confirm order</h2>
            <div className="confirm-order-summary">
              <p><strong>Customer:</strong> {selectedCustomer?.name}</p>
              <p><strong>Items:</strong> {orderItems.length} line{orderItems.length !== 1 ? 's' : ''}</p>
              <p><strong>Total:</strong> TSh {payableTotal.toLocaleString()}</p>
              <p><strong>Payment:</strong> {orderData.payment_status === 'not_paid' ? 'Not paid' : orderData.payment_status === 'advance' ? `Advance TSh ${(parseFloat(orderData.paid_amount) || 0).toLocaleString()}` : 'Paid in full'} ({String(orderData.payment_method || 'cash').replace('_', ' ')})</p>
            </div>
            <div className="confirm-order-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowConfirmOrderModal(false)}>Cancel</button>
              <button type="button" className="btn-primary btn-large" onClick={handleConfirmOrderSubmit} disabled={loading}>
                {loading ? '⏳ Processing...' : 'Confirm & complete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NewOrder;
