import React, { useState, useEffect, useCallback } from 'react';
import { getCoupons, createCoupon, updateCoupon } from '../api/api';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../contexts/AuthContext';
import './AdminBranches.css';

const EMPTY_FORM = {
  code: '',
  type: 'percent',
  value: '',
  min_order_amount: '20000',
  max_uses: '0',
  expires_at: '',
  branch_id: '',
  is_active: true,
};

const AdminCoupons = () => {
  const { showToast, ToastContainer } = useToast();
  const { hasPermission } = useAuth();
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const canManage = hasPermission('canManageBranches');

  const loadCoupons = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getCoupons();
      setCoupons(res.data || []);
    } catch (error) {
      showToast('Error loading coupons: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadCoupons();
  }, [loadCoupons]);

  const handleChange = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.code.trim()) {
      showToast('Coupon code is required', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        code: form.code.trim().toUpperCase(),
        type: form.type,
        value: parseFloat(form.value),
        min_order_amount: parseFloat(form.min_order_amount) || 20000,
        max_uses: parseInt(form.max_uses, 10) || 0,
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
        branch_id: form.branch_id ? parseInt(form.branch_id, 10) : null,
        is_active: form.is_active,
      };
      if (editingId) {
        await updateCoupon(editingId, payload);
        showToast('Coupon updated', 'success');
      } else {
        await createCoupon(payload);
        showToast('Coupon created', 'success');
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      loadCoupons();
    } catch (error) {
      showToast('Error saving coupon: ' + (error.response?.data?.error || error.message), 'error');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (coupon) => {
    setEditingId(coupon.id);
    setForm({
      code: coupon.code,
      type: coupon.type,
      value: String(coupon.value),
      min_order_amount: String(coupon.min_order_amount ?? 20000),
      max_uses: String(coupon.max_uses ?? 0),
      expires_at: coupon.expires_at ? new Date(coupon.expires_at).toISOString().slice(0, 10) : '',
      branch_id: coupon.branch_id != null ? String(coupon.branch_id) : '',
      is_active: !!coupon.is_active,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggleActive = async (coupon) => {
    try {
      await updateCoupon(coupon.id, { is_active: !coupon.is_active });
      showToast(coupon.is_active ? 'Coupon deactivated' : 'Coupon activated', 'success');
      loadCoupons();
    } catch (error) {
      showToast('Error: ' + (error.response?.data?.error || error.message), 'error');
    }
  };

  if (!canManage) {
    return (
      <div className="admin-page">
        <ToastContainer />
        <h2>🎟️ Coupons</h2>
        <p>You do not have permission to manage coupons.</p>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <ToastContainer />
      <h2>🎟️ Coupons</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '16px' }}>
        A coupon can only be applied when the order subtotal is at least <strong>TSh 20,000</strong>.
      </p>

      <form onSubmit={handleSubmit} className="admin-form" style={{ marginBottom: '24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', alignItems: 'end' }}>
        <label>
          Code *
          <input type="text" value={form.code} onChange={(e) => handleChange('code', e.target.value.toUpperCase())} placeholder="e.g. SAVE20" required />
        </label>
        <label>
          Type
          <select value={form.type} onChange={(e) => handleChange('type', e.target.value)}>
            <option value="percent">Percent (%)</option>
            <option value="fixed">Fixed (TSh)</option>
          </select>
        </label>
        <label>
          Value *
          <input type="number" min="0" step="0.01" value={form.value} onChange={(e) => handleChange('value', e.target.value)} placeholder={form.type === 'percent' ? 'e.g. 10' : 'e.g. 5000'} required />
        </label>
        <label>
          Min Order (TSh)
          <input type="number" min="0" value={form.min_order_amount} onChange={(e) => handleChange('min_order_amount', e.target.value)} />
        </label>
        <label>
          Max Uses (0 = unlimited)
          <input type="number" min="0" value={form.max_uses} onChange={(e) => handleChange('max_uses', e.target.value)} />
        </label>
        <label>
          Expires
          <input type="date" value={form.expires_at} onChange={(e) => handleChange('expires_at', e.target.value)} />
        </label>
        <label>
          Branch ID (blank = all)
          <input type="number" min="0" value={form.branch_id} onChange={(e) => handleChange('branch_id', e.target.value)} />
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : (editingId ? 'Update' : 'Create')}</button>
          {editingId && (
            <button type="button" className="btn-secondary" onClick={() => { setEditingId(null); setForm(EMPTY_FORM); }}>Cancel</button>
          )}
        </div>
      </form>

      {loading ? (
        <p>Loading coupons…</p>
      ) : coupons.length === 0 ? (
        <p>No coupons yet. Create one above.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-color)' }}>
              <th style={{ padding: '8px' }}>Code</th>
              <th style={{ padding: '8px' }}>Discount</th>
              <th style={{ padding: '8px' }}>Min Order</th>
              <th style={{ padding: '8px' }}>Used</th>
              <th style={{ padding: '8px' }}>Expires</th>
              <th style={{ padding: '8px' }}>Status</th>
              <th style={{ padding: '8px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {coupons.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '8px', fontWeight: 600 }}>{c.code}</td>
                <td style={{ padding: '8px' }}>{c.type === 'percent' ? `${c.value}%` : `TSh ${Number(c.value).toLocaleString()}`}</td>
                <td style={{ padding: '8px' }}>TSh {Number(c.min_order_amount || 0).toLocaleString()}</td>
                <td style={{ padding: '8px' }}>{c.used_count}{c.max_uses > 0 ? ` / ${c.max_uses}` : ''}</td>
                <td style={{ padding: '8px' }}>{c.expires_at ? new Date(c.expires_at).toLocaleDateString() : '—'}</td>
                <td style={{ padding: '8px' }}>
                  <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '12px', background: c.is_active ? '#d1fae5' : '#fee2e2', color: c.is_active ? '#065f46' : '#991b1b' }}>
                    {c.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td style={{ padding: '8px', display: 'flex', gap: '6px' }}>
                  <button className="btn-small btn-primary" onClick={() => startEdit(c)}>Edit</button>
                  <button className="btn-small btn-secondary" onClick={() => toggleActive(c)}>{c.is_active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default AdminCoupons;
