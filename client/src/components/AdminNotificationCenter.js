import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getAdminInbox,
  getAdminInboxCounts,
  markAdminInboxRead,
  dismissAdminInboxItem,
  approveAdminInboxItem,
  rejectAdminInboxItem,
} from '../api/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../hooks/useToast';
import './AdminNotificationCenter.css';

const TYPE_LABELS = {
  void_receipt: 'Void',
  cash_short: 'Cash short',
  ai_suggestion: 'AI tip',
  system: 'System',
};

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatWhen(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function getInboxDetailLines(item) {
  const payload = item.payload || {};
  const lines = [];

  if (item.type === 'void_receipt') {
    if (payload.receipt_number) {
      lines.push({ label: 'Receipt', value: String(payload.receipt_number).toUpperCase() });
    }
    if (payload.customer_name) {
      lines.push({ label: 'Customer', value: payload.customer_name });
    }
    if (payload.void_reason) {
      lines.push({ label: 'Reason', value: payload.void_reason });
    }
    const total = formatMoney(payload.total_amount);
    const paid = formatMoney(payload.paid_amount);
    if (total != null) {
      lines.push({ label: 'Total', value: `${total} TZS` });
    }
    if (paid != null && paid !== total) {
      lines.push({ label: 'Paid', value: `${paid} TZS` });
    }
    if (payload.item_count > 1) {
      lines.push({ label: 'Items', value: String(payload.item_count) });
    }
  } else if (item.type === 'cash_short') {
    if (payload.date) {
      lines.push({ label: 'Date', value: payload.date });
    }
    const shortAmt = formatMoney(payload.opening_short ?? Math.abs(payload.opening_variance || 0));
    if (shortAmt != null) {
      lines.push({ label: 'Short by', value: `${shortAmt} TZS` });
    }
    const declared = formatMoney(payload.opening_cash_declared);
    const expected = formatMoney(payload.expected_opening);
    if (declared != null) {
      lines.push({ label: 'Declared', value: `${declared} TZS` });
    }
    if (expected != null) {
      lines.push({ label: 'Expected', value: `${expected} TZS` });
    }
  } else if (item.type === 'system' || item.type === 'ai_suggestion') {
    if (payload.date) {
      lines.push({ label: 'Date', value: payload.date });
    }
    const closing = formatMoney(payload.closing_balance);
    if (closing != null) {
      lines.push({ label: 'Closing', value: `${closing} TZS` });
    }
  }

  if (item.requested_by) {
    lines.push({ label: 'From', value: item.requested_by });
  }

  if (item.review_note) {
    lines.push({ label: 'Note', value: item.review_note });
  }

  return lines;
}

function handleItemKeyDown(event, item, onOpen) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onOpen(item);
  }
}

export default function AdminNotificationCenter() {
  const { isAdmin, selectedBranchId } = useAuth();
  const { showToast, ToastContainer } = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ unread: 0, pending_actions: 0, total: 0 });
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [filter, setFilter] = useState('all'); // all | pending | unread
  const panelRef = useRef(null);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const params = {};
      if (selectedBranchId != null && selectedBranchId !== '') {
        params.branch_id = selectedBranchId;
      }
      if (filter === 'pending') params.action_status = 'pending';
      if (filter === 'unread') params.status = 'unread';

      const [listRes, countRes] = await Promise.all([
        getAdminInbox(params),
        getAdminInboxCounts(
          selectedBranchId != null && selectedBranchId !== ''
            ? { branch_id: selectedBranchId }
            : {}
        ),
      ]);
      setItems(listRes?.data?.items || []);
      setCounts(countRes?.data || listRes?.data?.counts || { unread: 0, pending_actions: 0, total: 0 });
    } catch (err) {
      console.error('Failed to load admin inbox:', err);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, selectedBranchId, filter]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    load();
    const id = setInterval(load, 45000);
    return () => clearInterval(id);
  }, [isAdmin, load]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!isAdmin) return null;

  const badge = Math.max(counts.pending_actions || 0, counts.unread || 0);

  const handleApprove = async (item, acknowledgeReconciled = false) => {
    setBusyId(item.id);
    try {
      await approveAdminInboxItem(item.id, acknowledgeReconciled ? { acknowledge_reconciled_day: true } : {});
      await load();
    } catch (error) {
      const status = error.response?.status;
      const code = error.response?.data?.code;
      if (status === 409 && code === 'reconciled_day') {
        setBusyId(null);
        const confirmed = window.confirm(
          'This receipt touches a reconciled day.\n\nApproving will recalculate the locked daily summary and refresh any later pending days.\n\nContinue?'
        );
        if (!confirmed) return;
        // Re-approve with acknowledgement
        await handleApprove(item, true);
        return;
      }
      const msg = error.response?.data?.error || error.message || 'Approve failed';
      showToast('Could not approve void request: ' + msg, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (item) => {
    const note = window.prompt('Optional note for declining this void request:', '');
    if (note === null) return;
    setBusyId(item.id);
    try {
      await rejectAdminInboxItem(item.id, { review_note: note.trim() || null });
      await load();
    } catch (error) {
      showToast(error.response?.data?.error || error.message || 'Decline failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleOpenItem = async (item) => {
    if (item.status === 'unread') {
      try {
        await markAdminInboxRead(item.id);
        setItems((prev) =>
          prev.map((row) => (row.id === item.id ? { ...row, status: 'read' } : row))
        );
        setCounts((c) => ({ ...c, unread: Math.max(0, (c.unread || 0) - 1) }));
      } catch (_) {
        /* ignore */
      }
    }

    if (item.type === 'void_receipt' && item.payload?.receipt_number) {
      setOpen(false);
      navigate(`/orders?receipt=${encodeURIComponent(item.payload.receipt_number)}`);
    } else if (item.type === 'cash_short') {
      setOpen(false);
      navigate('/cash-management');
    }
  };

  const handleDismiss = async (item, e) => {
    e.stopPropagation();
    setBusyId(item.id);
    try {
      await dismissAdminInboxItem(item.id);
      await load();
    } catch (error) {
      showToast(error.response?.data?.error || error.message || 'Dismiss failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="admin-inbox" ref={panelRef}>
      <ToastContainer />
      <button
        type="button"
        className={`admin-inbox__bell${open ? ' is-open' : ''}`}
        aria-label="Admin notification center"
        aria-expanded={open}
        title="Admin inbox"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) load();
        }}
      >
        <span className="admin-inbox__bell-icon" aria-hidden>inbox</span>
        {badge > 0 && (
          <span className="admin-inbox__badge">{badge > 99 ? '99+' : badge}</span>
        )}
      </button>

      {open && (
        <div className="admin-inbox__panel" role="dialog" aria-label="Admin notifications">
          <div className="admin-inbox__header">
            <div>
              <h2>Inbox</h2>
              <p>
                {counts.pending_actions
                  ? `${counts.pending_actions} awaiting approval`
                  : 'Branch alerts & requests'}
              </p>
            </div>
            <button type="button" className="admin-inbox__refresh" onClick={load} disabled={loading}>
              {loading ? '…' : 'Refresh'}
            </button>
          </div>

          <div className="admin-inbox__filters">
            {[
              { id: 'all', label: 'All' },
              { id: 'pending', label: 'Approvals' },
              { id: 'unread', label: 'Unread' },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                className={`admin-inbox__chip${filter === f.id ? ' is-active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="admin-inbox__list">
            {!loading && items.length === 0 && (
              <div className="admin-inbox__empty">
                No notifications right now. Void requests, cash shorts, and AI tips will show here by branch.
              </div>
            )}
            {items.map((item) => {
              const pending = item.action_status === 'pending';
              const typeLabel = TYPE_LABELS[item.type] || item.type;
              const detailLines = getInboxDetailLines(item);
              const showBody = item.body && detailLines.length === 0;
              return (
                <article
                  key={item.id}
                  className={`admin-inbox__item admin-inbox__item--${item.type}${item.status === 'unread' ? ' is-unread' : ''}${pending ? ' is-pending' : ''}`}
                >
                  <div
                    className="admin-inbox__item-main"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleOpenItem(item)}
                    onKeyDown={(event) => handleItemKeyDown(event, item, handleOpenItem)}
                  >
                    <div className="admin-inbox__item-top">
                      <span className={`admin-inbox__type admin-inbox__type--${item.type}`}>{typeLabel}</span>
                      {item.branch_name && (
                        <span className="admin-inbox__branch">{item.branch_code || item.branch_name}</span>
                      )}
                      <span className="admin-inbox__when">{formatWhen(item.created_at)}</span>
                    </div>
                    <div className="admin-inbox__title">{item.title}</div>
                    {detailLines.length > 0 && (
                      <dl className="admin-inbox__details">
                        {detailLines.map((line) => (
                          <div key={`${item.id}-${line.label}`} className="admin-inbox__detail-row">
                            <dt className="admin-inbox__detail-label">{line.label}</dt>
                            <dd className="admin-inbox__detail-value">{line.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {showBody && <p className="admin-inbox__body">{item.body}</p>}
                    <div className="admin-inbox__meta">
                      {item.action_status && item.action_status !== 'pending' && (
                        <span className="admin-inbox__status-pill">{item.action_status}</span>
                      )}
                      {item.reviewed_by && (
                        <span className="admin-inbox__reviewed">Reviewed by {item.reviewed_by}</span>
                      )}
                    </div>
                  </div>

                  {pending && (
                    <div className="admin-inbox__actions">
                      <button
                        type="button"
                        className="admin-inbox__btn admin-inbox__btn--approve"
                        disabled={busyId === item.id}
                        onClick={() => handleApprove(item)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="admin-inbox__btn admin-inbox__btn--reject"
                        disabled={busyId === item.id}
                        onClick={() => handleReject(item)}
                      >
                        Decline
                      </button>
                    </div>
                  )}

                  {!pending && (
                    <div className="admin-inbox__actions">
                      <button
                        type="button"
                        className="admin-inbox__btn admin-inbox__btn--ghost"
                        disabled={busyId === item.id}
                        onClick={(e) => handleDismiss(item, e)}
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
