import React, { useState, useEffect, useCallback } from 'react';
import { 
  getItems, updateItem, createItem, 
  getServices, getSettings, updateSetting,
  getBranches, setBranchItemPrice, deleteBranchItemPrice, getBranchItemPrice
} from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import Loader from '../components/Loader';
import './PriceList.css';

const PriceList = () => {
  const { showToast, ToastContainer } = useToast();
  const { isAdmin, user } = useAuth();
  const [items, setItems] = useState([]);
  const [services, setServices] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [activeTab, setActiveTab] = useState('items'); // 'items', 'services', or 'express'
  const [selectedCategory, setSelectedCategory] = useState('all'); // 'all', 'gents', 'ladies', 'general'
  const [expressSettings, setExpressSettings] = useState({});
  const [editingSettings, setEditingSettings] = useState({});
  const [editingItem, setEditingItem] = useState(null);
  const [editingBranchPrice, setEditingBranchPrice] = useState(null); // { itemId, branchId, price }
  const [lastSyncedAt, setLastSyncedAt] = useState(null); // When showing cached data (offline)
  const [newItem, setNewItem] = useState({
    name: '',
    description: '',
    category: 'general',
    base_price: '',
    service_type: 'Wash, Press & Hanged',
    is_active: true
  });

  // Single initial load: fetch items, services, settings, branches in parallel (faster)
  useEffect(() => {
    let cancelled = false;
    const params = selectedCategory !== 'all' ? { category: selectedCategory } : {};
    setLoading(true);
    const promises = [
      getItems(params),
      getServices(true),
      getSettings(),
      isAdmin ? getBranches() : Promise.resolve({ data: [] })
    ];
    Promise.all(promises)
      .then(([itemsRes, servicesRes, settingsRes, branchesRes]) => {
        if (cancelled) return;
        setItems((itemsRes.data || []));
        setServices(servicesRes.data || []);
        setExpressSettings(settingsRes.data || {});
        setEditingSettings(settingsRes.data || {});
        setBranches(branchesRes.data || []);
        const synced = itemsRes.syncedAt || servicesRes.syncedAt || settingsRes.syncedAt;
        if (itemsRes.fromCache || servicesRes.fromCache || settingsRes.fromCache) setLastSyncedAt(synced || null);
        else setLastSyncedAt(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Error loading price list:', err);
        const errorMsg = err.response?.data?.error || err.message || 'Network Error';
        if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Network Error')) {
          showToast('Cannot connect to server. Please ensure the server is running.', 'error');
        } else {
          showToast('Error loading price list: ' + errorMsg, 'error');
        }
        setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [isAdmin, selectedCategory]);

  const loadItems = useCallback(async () => {
    try {
      const params = selectedCategory !== 'all' ? { category: selectedCategory } : {};
      const res = await getItems(params);
      setItems(res.data || []);
      if (res.fromCache && res.syncedAt) setLastSyncedAt(res.syncedAt); else setLastSyncedAt(null);
    } catch (error) {
      console.error('Error loading items:', error);
      showToast('Error loading items: ' + (error.response?.data?.error || error.message), 'error');
    }
  }, [selectedCategory, showToast]);

  const loadExpressSettings = useCallback(async () => {
    try {
      const res = await getSettings();
      setExpressSettings(res.data || {});
      setEditingSettings(res.data || {});
      if (res.fromCache && res.syncedAt) setLastSyncedAt(res.syncedAt); else setLastSyncedAt(null);
    } catch (error) {
      showToast('Error loading express settings', 'error');
    }
  }, [showToast]);

  const handleEdit = (item) => {
    if (!isAdmin) {
      showToast('Only administrators can edit prices', 'error');
      return;
    }
    setEditingId(item.id);
    setEditingItem({ ...item });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingItem(null);
    setEditingBranchPrice(null);
  };

  const handleSave = async (id) => {
    try {
      const itemData = {
        ...editingItem,
        is_active: editingItem.is_active === 1 || editingItem.is_active === true ? 1 : 0
      };
      await updateItem(id, itemData);
      showToast('Item updated successfully', 'success');
      setEditingId(null);
      setEditingItem(null);
      loadItems();
    } catch (error) {
      showToast('Error updating item: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`Are you sure you want to ${item.is_active ? 'deactivate' : 'activate'} "${item.name}"?`)) {
      return;
    }

    try {
      await updateItem(item.id, { ...item, is_active: !item.is_active });
      showToast(`Item ${item.is_active ? 'deactivated' : 'activated'} successfully`, 'success');
      loadItems();
    } catch (error) {
      showToast('Error updating item', 'error');
    }
  };

  const handleAddItem = async (e) => {
    e.preventDefault();
    try {
      const itemData = {
        name: newItem.name,
        description: newItem.description || null,
        category: newItem.category,
        base_price: parseFloat(newItem.base_price),
        service_type: newItem.service_type,
        is_active: newItem.is_active ? 1 : 0
      };

      await createItem(itemData);
      showToast('Item created successfully', 'success');
      setShowAddForm(false);
      setNewItem({
        name: '',
        description: '',
        category: 'general',
        base_price: '',
        service_type: 'Wash, Press & Hanged',
        is_active: true
      });
      loadItems();
    } catch (error) {
      showToast('Error creating item: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  const handleEditBranchPrice = async (itemId, branchId) => {
    try {
      const res = await getBranchItemPrice(itemId, branchId);
      setEditingBranchPrice({
        itemId,
        branchId,
        price: res.data.price || res.data.is_custom ? res.data.price : null,
        isCustom: res.data.is_custom || false
      });
    } catch (error) {
      // If no branch price exists, use base price
      const item = items.find(i => i.id === itemId);
      setEditingBranchPrice({
        itemId,
        branchId,
        price: item?.base_price || item?.price || '',
        isCustom: false
      });
    }
  };

  const handleSaveBranchPrice = async () => {
    try {
      await setBranchItemPrice(
        editingBranchPrice.itemId,
        editingBranchPrice.branchId,
        parseFloat(editingBranchPrice.price)
      );
      showToast('Branch price updated successfully', 'success');
      setEditingBranchPrice(null);
      loadItems();
    } catch (error) {
      showToast('Error updating branch price: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  const handleDeleteBranchPrice = async (itemId, branchId) => {
    if (!window.confirm('Delete branch-specific price? Item will use base price.')) {
      return;
    }
    try {
      await deleteBranchItemPrice(itemId, branchId);
      showToast('Branch price deleted. Item will use base price.', 'success');
      loadItems();
    } catch (error) {
      showToast('Error deleting branch price', 'error');
    }
  };

  const getItemIcon = (category, name) => {
    if (category === 'gents') return '👔';
    if (category === 'ladies') return '👗';
    if (name?.toLowerCase().includes('towel') || name?.toLowerCase().includes('bed')) return '🛏️';
    if (name?.toLowerCase().includes('curtain')) return '🪟';
    return '👕';
  };

  const getCategoryLabel = (category) => {
    const labels = {
      'gents': 'Gents',
      'ladies': 'Ladies',
      'general': 'General'
    };
    return labels[category] || category;
  };

  // Group items by category
  const groupedItems = items.reduce((acc, item) => {
    const category = item.category || 'general';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(item);
    return acc;
  }, {});

  if (loading) {
    return <Loader message="Loading price list…" fullPage />;
  }

  const handleSaveSettings = async () => {
    try {
      for (const [key, value] of Object.entries(editingSettings)) {
        await updateSetting(key, { value: value.value || value });
      }
      showToast('Express settings updated successfully', 'success');
      loadExpressSettings();
    } catch (error) {
      showToast('Error updating settings', 'error');
    }
  };

  return (
    <div className="price-list-page">
      <ToastContainer />
      <div className="page-header-modern">
        <div>
          <h1>Price List & Settings</h1>
          <p className="subtitle">Manage items, pricing, and express delivery options</p>
        </div>
        {activeTab === 'items' && isAdmin && (
          <button
            type="button"
            className="dk-btn dk-btn--primary dk-btn--md"
            onClick={() => setShowAddForm(!showAddForm)}
          >
            {showAddForm ? 'Cancel' : '+ Add New Item'}
          </button>
        )}
      </div>

      {lastSyncedAt && (
        <div className="sync-cache-banner" role="status">
          Showing price list from last sync — {new Date(lastSyncedAt).toLocaleString()}
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab-btn ${activeTab === 'items' ? 'active' : ''}`}
          onClick={() => setActiveTab('items')}
        >
          👕 Items & Prices
        </button>
        <button
          className={`tab-btn ${activeTab === 'services' ? 'active' : ''}`}
          onClick={() => setActiveTab('services')}
        >
          🚚 Delivery Services
        </button>
        <button
          className={`tab-btn ${activeTab === 'express' ? 'active' : ''}`}
          onClick={() => setActiveTab('express')}
        >
          ⚡ Express Settings
        </button>
      </div>

      {activeTab === 'items' && (
        <>
          {/* Category Filter */}
          <div className="category-filter">
            <button
              className={`filter-btn ${selectedCategory === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('all')}
            >
              All Items
            </button>
            <button
              className={`filter-btn ${selectedCategory === 'gents' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('gents')}
            >
              👔 Gents
            </button>
            <button
              className={`filter-btn ${selectedCategory === 'ladies' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('ladies')}
            >
              👗 Ladies
            </button>
            <button
              className={`filter-btn ${selectedCategory === 'general' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('general')}
            >
              🏠 General
            </button>
          </div>

          {/* Add Item Form */}
          {showAddForm && isAdmin && (
            <div className="add-service-card">
              <h2>Add New Item</h2>
              <form onSubmit={handleAddItem}>
                <div className="form-grid-service">
                  <div className="form-group-service">
                    <label>Item Name *</label>
                    <input
                      type="text"
                      value={newItem.name}
                      onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                      required
                      placeholder="e.g., Shirts - White"
                    />
                  </div>
                  <div className="form-group-service">
                    <label>Category *</label>
                    <select
                      value={newItem.category}
                      onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
                      required
                    >
                      <option value="gents">Gents</option>
                      <option value="ladies">Ladies</option>
                      <option value="general">General</option>
                    </select>
                  </div>
                  <div className="form-group-service">
                    <label>Description</label>
                    <input
                      type="text"
                      value={newItem.description}
                      onChange={(e) => setNewItem({ ...newItem, description: e.target.value })}
                      placeholder="Brief description"
                    />
                  </div>
                  <div className="form-group-service">
                    <label>Base Price (TSh) *</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      value={newItem.base_price}
                      onChange={(e) => setNewItem({ ...newItem, base_price: e.target.value })}
                      required
                      placeholder="0.00"
                    />
                  </div>
                  <div className="form-group-service">
                    <label>Service Type *</label>
                    <select
                      value={newItem.service_type}
                      onChange={(e) => setNewItem({ ...newItem, service_type: e.target.value })}
                      required
                    >
                      <option value="Wash, Press & Hanged">Wash, Press & Hanged</option>
                      <option value="Wash & Fold">Wash & Fold</option>
                      <option value="Wash, Press & Fold">Wash, Press & Fold</option>
                      <option value="Wash, Dry & Folded">Wash, Dry & Folded</option>
                      <option value="Washed Only">Washed Only</option>
                      <option value="Washed & Fold">Washed & Fold</option>
                      <option value="Dry Clean">Dry Clean</option>
                    </select>
                  </div>
                  <div className="form-group-service">
                    <label>Status</label>
                    <select
                      value={newItem.is_active}
                      onChange={(e) => setNewItem({ ...newItem, is_active: e.target.value === 'true' })}
                    >
                      <option value={true}>Active</option>
                      <option value={false}>Inactive</option>
                    </select>
                  </div>
                </div>
                <div className="form-actions-service">
                  <button type="submit" className="btn-primary">Create Item</button>
                  <button type="button" className="btn-secondary" onClick={() => setShowAddForm(false)}>Cancel</button>
                </div>
              </form>
            </div>
          )}

          {/* Edit Item Form */}
          {editingId !== null && editingItem && isAdmin && (
            <div className="service-edit-card">
              <h3>✏️ Edit Item</h3>
              <form onSubmit={(e) => { e.preventDefault(); handleSave(editingId); }}>
                <div className="edit-form-grid">
                  <div className="form-group-service">
                    <label>Item Name *</label>
                    <input
                      type="text"
                      value={editingItem.name}
                      onChange={(e) => setEditingItem({ ...editingItem, name: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-group-service">
                    <label>Category *</label>
                    <select
                      value={editingItem.category}
                      onChange={(e) => setEditingItem({ ...editingItem, category: e.target.value })}
                      required
                    >
                      <option value="gents">Gents</option>
                      <option value="ladies">Ladies</option>
                      <option value="general">General</option>
                    </select>
                  </div>
                  <div className="form-group-service">
                    <label>Description</label>
                    <input
                      type="text"
                      value={editingItem.description || ''}
                      onChange={(e) => setEditingItem({ ...editingItem, description: e.target.value })}
                    />
                  </div>
                  <div className="form-group-service">
                    <label>Base Price (TSh) *</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      value={editingItem.base_price}
                      onChange={(e) => setEditingItem({ ...editingItem, base_price: parseFloat(e.target.value) })}
                      required
                    />
                  </div>
                  <div className="form-group-service">
                    <label>Service Type *</label>
                    <select
                      value={editingItem.service_type}
                      onChange={(e) => setEditingItem({ ...editingItem, service_type: e.target.value })}
                      required
                    >
                      <option value="Wash, Press & Hanged">Wash, Press & Hanged</option>
                      <option value="Wash & Fold">Wash & Fold</option>
                      <option value="Wash, Press & Fold">Wash, Press & Fold</option>
                      <option value="Wash, Dry & Folded">Wash, Dry & Folded</option>
                      <option value="Washed Only">Washed Only</option>
                      <option value="Washed & Fold">Washed & Fold</option>
                      <option value="Dry Clean">Dry Clean</option>
                    </select>
                  </div>
                  <div className="form-group-service">
                    <label>Status</label>
                    <select
                      value={editingItem.is_active}
                      onChange={(e) => setEditingItem({ ...editingItem, is_active: parseInt(e.target.value) })}
                    >
                      <option value={1}>Active</option>
                      <option value={0}>Inactive</option>
                    </select>
                  </div>
                </div>
                <div className="edit-form-actions">
                  <button type="submit" className="btn-small btn-success">✓ Save Changes</button>
                  <button type="button" className="btn-small btn-secondary" onClick={handleCancelEdit}>✕ Cancel</button>
                </div>
              </form>
            </div>
          )}

          {/* Branch Price Editor */}
          {editingBranchPrice && isAdmin && (
            <div className="service-edit-card">
              <h3>💰 Edit Branch Price</h3>
              <div className="edit-form-grid">
                <div className="form-group-service">
                  <label>Branch</label>
                  <select
                    value={editingBranchPrice.branchId}
                    onChange={(e) => setEditingBranchPrice({ ...editingBranchPrice, branchId: e.target.value })}
                  >
                    {branches.map(branch => (
                      <option key={branch.id} value={branch.id}>{branch.code} - {branch.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group-service">
                  <label>Price (TSh) *</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={editingBranchPrice.price || ''}
                    onChange={(e) => setEditingBranchPrice({ ...editingBranchPrice, price: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="edit-form-actions">
                <button 
                  type="button" 
                  className="btn-small btn-success"
                  onClick={handleSaveBranchPrice}
                >
                  ✓ Save Branch Price
                </button>
                {editingBranchPrice.isCustom && (
                  <button 
                    type="button" 
                    className="btn-small btn-warning"
                    onClick={() => handleDeleteBranchPrice(editingBranchPrice.itemId, editingBranchPrice.branchId)}
                  >
                    🗑️ Delete (Use Base Price)
                  </button>
                )}
                <button type="button" className="btn-small btn-secondary" onClick={() => setEditingBranchPrice(null)}>✕ Cancel</button>
              </div>
            </div>
          )}

          {/* Items List by Category */}
          <div className="items-by-category">
            {Object.keys(groupedItems).length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">💰</div>
                <h3>No Items Found</h3>
                <p>Add your first item to get started!</p>
              </div>
            ) : (
              Object.keys(groupedItems).map(category => (
                <div key={category} className="category-section">
                  <h2 className="category-title">
                    {getItemIcon(category, '')} {getCategoryLabel(category)} Items
                    <span className="category-count">({groupedItems[category].length})</span>
                  </h2>
                  <div className="items-table-container">
                    <table className="items-table">
                      <thead>
                        <tr>
                          <th className="col-icon">Icon</th>
                          <th className="col-name">Item Name</th>
                          <th className="col-category">Category</th>
                          <th className="col-service">Service Type</th>
                          <th className="col-price">Washing Price</th>
                          <th className="col-status">Status</th>
                          {isAdmin && <th className="col-actions">Actions</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {groupedItems[category].filter(item => editingId === null || item.id !== editingId).map(item => (
                          <tr key={item.id} className={!item.is_active ? 'inactive-row' : ''}>
                            <td className="col-icon">
                              <span className="item-icon">{getItemIcon(item.category, item.name)}</span>
                            </td>
                            <td className="col-name">
                              <div className="item-name-cell">
                                <strong>{item.name}</strong>
                                {item.description && (
                                  <span className="item-description">{item.description}</span>
                                )}
                              </div>
                            </td>
                            <td className="col-category">
                              <span className="category-badge">{getCategoryLabel(item.category)}</span>
                            </td>
                            <td className="col-service">
                              <span className="service-type">{item.service_type}</span>
                            </td>
                            <td className="col-price">
                              <div className="price-cell">
                                <span className="price-value">TSh {parseFloat(item.price || item.base_price || 0).toLocaleString()}</span>
                                {item.branch_price_id && (
                                  <span className="branch-price-badge-small">Branch</span>
                                )}
                              </div>
                            </td>
                            <td className="col-status">
                              <span className={`status-badge ${item.is_active ? 'active' : 'inactive'}`}>
                                {item.is_active ? '✅ Active' : '❌ Inactive'}
                              </span>
                            </td>
                            {isAdmin && (
                              <td className="col-actions">
                                <div className="table-actions">
                                  <button
                                    className="btn-small btn-primary"
                                    onClick={() => handleEdit(item)}
                                    title="Edit Item"
                                  >
                                    ✏️
                                  </button>
                                  {branches.length > 0 && (
                                    <button
                                      className="btn-small btn-secondary"
                                      onClick={() => handleEditBranchPrice(item.id, branches[0].id)}
                                      title="Branch Price"
                                    >
                                      💰
                                    </button>
                                  )}
                                  <button
                                    className={`btn-small ${item.is_active ? 'btn-warning' : 'btn-success'}`}
                                    onClick={() => handleDelete(item)}
                                    title={item.is_active ? 'Deactivate' : 'Activate'}
                                  >
                                    {item.is_active ? '🚫' : '✅'}
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {activeTab === 'services' && (
        <div className="services-list-container">
          <div className="services-list">
            {services.map(service => (
              <div key={service.id} className="service-card">
                <div className="service-card-header">
                  <div className="service-info">
                    <span className="service-icon-large">🚚</span>
                    <div className="service-details">
                      <h3 className="service-name">{service.name}</h3>
                      {service.description && (
                        <p className="service-description">{service.description}</p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="service-pricing">
                  <div className="price-item">
                    <span className="price-label">Price Multiplier:</span>
                    <span className="price-value">{parseFloat(service.base_price || 1).toFixed(1)}x</span>
                  </div>
                  <div className="price-item">
                    <span className="price-label">Example:</span>
                    <span className="price-value">Item (3,000) × {parseFloat(service.base_price || 1).toFixed(1)} = TSh {(3000 * parseFloat(service.base_price || 1)).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'express' && (
        <div className="express-settings-card">
          <h2>Express Delivery Configuration</h2>
          <p className="settings-description">
            Configure express service surcharges and delivery times. During high season, 
            you can adjust these settings to 24hrs working hours delivery.
          </p>

          <div className="settings-grid">
            <div className="setting-item">
              <label>Same-Day Delivery Multiplier</label>
              <div className="setting-input-group">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  min="1"
                  value={editingSettings.express_same_day_multiplier?.value || expressSettings.express_same_day_multiplier?.value || 2}
                  onChange={(e) => setEditingSettings({
                    ...editingSettings,
                    express_same_day_multiplier: { ...expressSettings.express_same_day_multiplier, value: e.target.value }
                  })}
                />
                <span className="setting-info">
                  ({((parseFloat(editingSettings.express_same_day_multiplier?.value || expressSettings.express_same_day_multiplier?.value || 2) - 1) * 100).toFixed(0)}% surcharge = {(parseFloat(editingSettings.express_same_day_multiplier?.value || expressSettings.express_same_day_multiplier?.value || 2) * 100).toFixed(0)}% of base price)
                </span>
              </div>
            </div>

            <div className="setting-item">
              <label>Same-Day Delivery Time (Hours)</label>
              <div className="setting-input-group">
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={editingSettings.express_same_day_hours?.value || expressSettings.express_same_day_hours?.value || 8}
                  onChange={(e) => setEditingSettings({
                    ...editingSettings,
                    express_same_day_hours: { ...expressSettings.express_same_day_hours, value: e.target.value }
                  })}
                />
                <span className="setting-info">
                  Default: &lt; 8HRS | High Season: 24HRS
                </span>
              </div>
            </div>

            <div className="setting-item">
              <label>Next-Day Delivery Multiplier</label>
              <div className="setting-input-group">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  min="1"
                  value={editingSettings.express_next_day_multiplier?.value || expressSettings.express_next_day_multiplier?.value || 3}
                  onChange={(e) => setEditingSettings({
                    ...editingSettings,
                    express_next_day_multiplier: { ...expressSettings.express_next_day_multiplier, value: e.target.value }
                  })}
                />
                <span className="setting-info">
                  ({((parseFloat(editingSettings.express_next_day_multiplier?.value || expressSettings.express_next_day_multiplier?.value || 3) - 1) * 100).toFixed(0)}% surcharge = {(parseFloat(editingSettings.express_next_day_multiplier?.value || expressSettings.express_next_day_multiplier?.value || 3) * 100).toFixed(0)}% of base price)
                </span>
              </div>
            </div>

            <div className="setting-item">
              <label>Next-Day Delivery Time (Hours)</label>
              <div className="setting-input-group">
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={editingSettings.express_next_day_hours?.value || expressSettings.express_next_day_hours?.value || 3}
                  onChange={(e) => setEditingSettings({
                    ...editingSettings,
                    express_next_day_hours: { ...expressSettings.express_next_day_hours, value: e.target.value }
                  })}
                />
                <span className="setting-info">
                  Default: &lt; 3HRS | High Season: 24HRS
                </span>
              </div>
            </div>

            <div className="setting-item full-width">
              <label>
                <input
                  type="checkbox"
                  checked={editingSettings.high_season_mode?.value === 'true' || expressSettings.high_season_mode?.value === 'true'}
                  onChange={(e) => setEditingSettings({
                    ...editingSettings,
                    high_season_mode: { ...expressSettings.high_season_mode, value: e.target.checked ? 'true' : 'false' }
                  })}
                />
                High Season Mode (24hrs working hours delivery)
              </label>
              <p className="setting-note">
                When enabled, delivery times adjust to 24hrs working hours. Use during peak seasons or high customer volume periods.
              </p>
            </div>
          </div>

          <div className="settings-actions">
            <button className="btn-primary" onClick={handleSaveSettings}>
              💾 Save Express Settings
            </button>
            <button className="btn-secondary" onClick={loadExpressSettings}>
              Reset Changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PriceList;
