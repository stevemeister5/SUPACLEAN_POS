import React from 'react';
import './SkeletonList.css';

/**
 * Shimmering placeholder rows for list pages - renders instantly (no delay),
 * giving a faster perceived load than a spinner for initial data fetches.
 * Honors prefers-reduced-motion via CSS.
 * @param {number} [rows=8] - number of placeholder rows
 * @param {string} [variant='table'] - 'table' (full-width rows) or 'card' (grid cards)
 */
export default function SkeletonList({ rows = 8, variant = 'table' }) {
  const items = Array.from({ length: Math.max(1, Math.min(rows, 30)) });
  return (
    <div className={`skeleton-list skeleton-list--${variant}`} role="status" aria-label="Loading">
      {items.map((_, i) => (
        <div
          key={i}
          className="skeleton-row"
          style={{ animationDelay: `${(i % 8) * 90}ms` }}
          aria-hidden="true"
        >
          <span className="skeleton-bar skeleton-bar--icon" />
          <span className="skeleton-bar skeleton-bar--main" />
          <span className="skeleton-bar skeleton-bar--mid" />
          <span className="skeleton-bar skeleton-bar--short" />
        </div>
      ))}
    </div>
  );
}
