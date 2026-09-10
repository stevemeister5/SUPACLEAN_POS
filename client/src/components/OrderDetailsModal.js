import React from 'react';
import ReceiptDetailPanel from './ReceiptDetailPanel';
import './OrderDetailsModal.css';

/**
 * Receipt detail modal for Collections.
 * Renders receipt details in a popup so selecting a receipt
 * from search or queue results shows immediately without scrolling.
 */
export default function OrderDetailsModal({
  open,
  order,
  items,
  loading = false,
  error = null,
  onClose,
  actions = null,
}) {
  if (!open) return null;

  return (
    <div
      className="modal-overlay order-details-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Receipt details"
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div className="modal-content order-details-modal-content">
        <div className="modal-header">
          <h2>Receipt Details</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close receipt details">
            ×
          </button>
        </div>
        <div className="modal-body order-details-modal-body">
          <ReceiptDetailPanel
            order={order}
            items={items}
            loading={loading}
            error={error}
            onClose={null}
            actions={actions}
          />
        </div>
      </div>
    </div>
  );
}
