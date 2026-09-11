/* global React */
const { useState } = React;

// ─── Logo ─────────────────────────────────────────────
function Logo({ size = 64 }) {
  return (
    <img
      src="../../assets/supaclean-logo.svg"
      alt="SUPACLEAN"
      width={size}
      height={size}
      style={{ display: 'block' }}
    />
  );
}

// ─── Button ───────────────────────────────────────────
function Button({ variant = 'primary', size = 'md', children, onClick, disabled, icon }) {
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: 600,
    letterSpacing: '-0.01em',
    borderRadius: 12,
    transition: 'all 0.4s cubic-bezier(0.36, 0.66, 0.04, 1)',
    opacity: disabled ? 0.6 : 1,
    fontFamily: 'inherit',
  };
  const sizes = {
    sm: { padding: '8px 16px', fontSize: 13, minHeight: 34 },
    md: { padding: '12px 20px', fontSize: 15, minHeight: 44 },
    lg: { padding: '14px 24px', fontSize: 17, minHeight: 48 },
  };
  const variants = {
    primary: {
      background: 'var(--primary-color)',
      color: '#fff',
      boxShadow: '0 2px 8px rgba(0,122,255,0.3), 0 1px 2px rgba(0,0,0,0.1)',
    },
    secondary: {
      background: 'var(--bg-secondary)',
      color: 'var(--text-primary)',
      border: '0.5px solid var(--border-color)',
    },
    success: { background: 'var(--success-color)', color: '#fff' },
    danger: { background: 'transparent', color: 'var(--danger-color)', border: '1px solid rgba(255,59,48,0.3)' },
    ghost: { background: 'transparent', color: 'var(--primary-color)' },
  };
  return (
    <button
      style={{ ...base, ...sizes[size], ...variants[variant] }}
      onClick={onClick}
      disabled={disabled}
      onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.97)')}
      onMouseUp={e => (e.currentTarget.style.transform = '')}
      onMouseLeave={e => (e.currentTarget.style.transform = '')}
    >
      {icon && <span style={{ fontSize: '1.1em' }}>{icon}</span>}
      {children}
    </button>
  );
}

// ─── Field ────────────────────────────────────────────
function Field({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {label && <label style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</label>}
      {children}
      {hint && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
  );
}

function Input(props) {
  const [focus, setFocus] = useState(false);
  return (
    <input
      {...props}
      onFocus={e => { setFocus(true); props.onFocus?.(e); }}
      onBlur={e => { setFocus(false); props.onBlur?.(e); }}
      style={{
        padding: '12px 14px',
        border: `2px solid ${focus ? 'var(--primary-color)' : 'var(--border-color)'}`,
        borderRadius: 12,
        fontSize: 15,
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        outline: 'none',
        boxShadow: focus ? '0 0 0 4px rgba(0,122,255,0.1)' : 'none',
        fontFamily: 'inherit',
        transition: 'all 0.3s cubic-bezier(0.4,0,0.2,1)',
        ...(props.style || {}),
      }}
    />
  );
}

function Select(props) {
  return (
    <select
      {...props}
      style={{
        padding: '12px 14px',
        border: '2px solid var(--border-color)',
        borderRadius: 12,
        fontSize: 15,
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        outline: 'none',
        fontFamily: 'inherit',
        appearance: 'none',
        backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'8\' viewBox=\'0 0 12 8\'><path fill=\'%238E8E93\' d=\'M6 8L0 0h12z\'/></svg>")',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 14px center',
        paddingRight: 36,
        ...(props.style || {}),
      }}
    />
  );
}

// ─── Badge ────────────────────────────────────────────
function Badge({ variant = 'info', children }) {
  const map = {
    info:    ['rgba(90,200,250,0.15)', '#0a84c4'],
    success: ['rgba(52,199,89,0.15)',  '#248a3d'],
    warning: ['rgba(255,149,0,0.15)',  '#b86e00'],
    danger:  ['rgba(255,59,48,0.15)',  '#c01b10'],
    muted:   ['#E5E5EA',                'var(--text-secondary)'],
    primary: ['var(--primary-light)',   'var(--primary-color)'],
  };
  const [bg, fg] = map[variant];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: bg, color: fg, fontSize: 12, fontWeight: 600,
      padding: '4px 10px', borderRadius: 8, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function TierBadge({ tier }) {
  const map = {
    BRONZE: ['#FBE3C6', '#8B4513'],
    SILVER: ['#E8E8E8', '#5C5C5C'],
    GOLD: ['#FFE9A8', '#8A6400'],
    PLATINUM: ['#E4E9F5', '#38466B'],
  };
  const [bg, fg] = map[tier] || map.BRONZE;
  return <span style={{ background: bg, color: fg, borderRadius: 9999, padding: '4px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em' }}>{tier}</span>;
}

// ─── ReceiptChip ──────────────────────────────────────
function ReceiptChip({ id, overdue, filled }) {
  const base = {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 8,
    fontWeight: 600,
    display: 'inline-block',
  };
  if (overdue) {
    return <span style={{ ...base, background: 'var(--danger-color)', color: 'white', animation: 'pulse 2s infinite' }}>{id}</span>;
  }
  if (filled) {
    return <span style={{ ...base, background: 'var(--primary-color)', color: 'white' }}>{id}</span>;
  }
  return <span style={{ ...base, border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>{id}</span>;
}

// ─── Card / StatCard ──────────────────────────────────
function Card({ children, style, frosted }) {
  return (
    <div style={{
      background: frosted ? 'rgba(255,255,255,0.7)' : 'var(--bg-secondary)',
      backdropFilter: frosted ? 'blur(20px) saturate(180%)' : undefined,
      WebkitBackdropFilter: frosted ? 'blur(20px) saturate(180%)' : undefined,
      borderRadius: 16,
      border: '0.5px solid var(--border-color)',
      boxShadow: 'var(--shadow-sm)',
      padding: 20,
      ...(style || {}),
    }}>{children}</div>
  );
}

function StatCard({ icon, label, value, sub, accent = 'primary' }) {
  const accentColor = {
    primary: 'var(--primary-color)',
    success: 'var(--success-color)',
    warning: 'var(--warning-color)',
    danger: 'var(--danger-color)',
    info: 'var(--info-color)',
  }[accent];
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      background: 'rgba(255,255,255,0.7)',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      borderRadius: 16, padding: 20,
      display: 'flex', alignItems: 'center', gap: 16,
      boxShadow: 'var(--shadow-sm)',
      border: '0.5px solid var(--border-color)',
    }}>
      <span style={{ position: 'absolute', top: 0, left: 0, width: 4, height: '100%', background: accentColor }} />
      <div style={{ fontSize: 28, width: 52, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--primary-light)', borderRadius: 12, flexShrink: 0 }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── OrderRow ─────────────────────────────────────────
function OrderRow({ order, onView, onCollect }) {
  const accent = order.overdue ? 'var(--danger-color)' : order.status === 'ready' ? 'var(--success-color)' : 'var(--primary-color)';
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '16px 18px', background: 'var(--bg-secondary)', borderRadius: 16,
      border: '1px solid var(--border-light)',
      borderLeft: `5px solid ${accent}`,
      transition: 'all 0.3s cubic-bezier(0.4,0,0.2,1)',
      ...(order.overdue ? { background: 'rgba(255,59,48,0.05)' } : {}),
      cursor: 'pointer',
    }}
    onMouseEnter={e => { e.currentTarget.style.transform = 'translateX(6px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
    onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <ReceiptChip id={order.id} overdue={order.overdue} filled={!order.overdue && order.status !== 'ready'} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>{order.name}</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {order.phone} · {order.itemCount} items{order.express ? ' · Express' : ''}
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
        <div style={{ fontWeight: 600, color: 'var(--success-color)', fontVariantNumeric: 'tabular-nums' }}>TZS {order.amount.toLocaleString()}</div>
        {order.balance > 0 && (
          <div style={{ fontSize: 12, color: order.overdue ? 'var(--danger-color)' : 'var(--warning-color)', fontWeight: 500 }}>
            {order.overdue ? 'Overdue' : `Balance · TZS ${order.balance.toLocaleString()}`}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant="secondary" onClick={onView}>View</Button>
          {order.status === 'ready' && <Button size="sm" variant="success" onClick={onCollect}>Collect</Button>}
        </div>
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────
function Toast({ toast }) {
  if (!toast) return null;
  const borderColor = { success: 'var(--success-color)', error: 'var(--danger-color)', warning: 'var(--warning-color)' }[toast.type] || 'var(--primary-color)';
  const icon = { success: '✅', error: '❌', warning: '⚠️' }[toast.type] || 'ℹ️';
  return (
    <div style={{
      position: 'fixed', top: 20, right: 20, zIndex: 10000,
      background: 'rgba(28,28,30,0.95)',
      backdropFilter: 'blur(30px) saturate(180%)',
      WebkitBackdropFilter: 'blur(30px) saturate(180%)',
      padding: '14px 18px', borderRadius: 16, color: 'white',
      boxShadow: '0 8px 32px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.2)',
      border: '0.5px solid rgba(255,255,255,0.1)',
      borderLeft: `3px solid ${borderColor}`,
      minWidth: 300, display: 'flex', alignItems: 'center', gap: 10,
      animation: 'slideUp 0.3s cubic-bezier(0.36, 0.66, 0.04, 1)',
    }}>
      <span style={{ fontSize: 18 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{toast.msg}</div>
        {toast.sub && <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{toast.sub}</div>}
      </div>
    </div>
  );
}

// ─── PageHeader ───────────────────────────────────────
function PageHeader({ title, subtitle, actions }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16,
      marginBottom: 20, padding: 20,
      background: 'rgba(255,255,255,0.7)',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      borderRadius: 16,
      boxShadow: 'var(--shadow-sm)',
      border: '0.5px solid var(--border-color)',
    }}>
      <div>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', margin: 0, marginBottom: 4 }}>{title}</h1>
        {subtitle && <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{subtitle}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

// ─── StatStrip ────────────────────────────────────────
// Compact horizontal stat bar — replaces tall stat cards to save vertical space
function StatStrip({ stats }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${stats.length}, 1fr)`,
      background: 'var(--bg-secondary)', borderRadius: 12,
      border: '0.5px solid var(--border-color)',
      boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
      marginBottom: 12,
    }}>
      {stats.map((s, i) => {
        const accentColor = {
          primary: 'var(--primary-color)', success: 'var(--success-color)',
          warning: 'var(--warning-color)', danger: 'var(--danger-color)', info: 'var(--info-color)',
        }[s.accent || 'primary'];
        return (
          <div key={i} style={{
            padding: '10px 16px',
            borderLeft: i === 0 ? 'none' : '0.5px solid var(--border-color)',
            display: 'flex', flexDirection: 'column', gap: 2,
            position: 'relative',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: accentColor }} />
              <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{s.label}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{s.value}</span>
              {s.sub && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.sub}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── OrderTableRow ────────────────────────────────────
// Dense table row for lists of orders. Status = left border; no per-row padding bloat.
function OrderTableRow({ order, columns = ['receipt','customer','items','total','balance','status','actions'], onView, onCollect }) {
  const accent = order.overdue ? 'var(--danger-color)' : order.status === 'ready' ? 'var(--success-color)' : order.status === 'collected' ? 'var(--border-color)' : 'var(--primary-color)';
  const td = { padding: '8px 12px', fontSize: 13, borderBottom: '0.5px solid var(--border-light)', verticalAlign: 'middle' };
  return (
    <tr style={{ background: order.overdue ? 'rgba(255,59,48,0.04)' : 'transparent', transition: 'background 0.15s' }}
      onMouseEnter={e => e.currentTarget.style.background = order.overdue ? 'rgba(255,59,48,0.08)' : 'var(--bg-1)'}
      onMouseLeave={e => e.currentTarget.style.background = order.overdue ? 'rgba(255,59,48,0.04)' : 'transparent'}
    >
      <td style={{ ...td, padding: 0, width: 3, background: accent }} />
      {columns.includes('receipt') && <td style={{ ...td, width: 100 }}><ReceiptChip id={order.id} overdue={order.overdue} filled={!order.overdue && order.status !== 'ready' && order.status !== 'collected'} /></td>}
      {columns.includes('customer') && (
        <td style={td}>
          <div style={{ fontWeight: 600 }}>{order.name}</div>
          {order.phone && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{order.phone}</div>}
        </td>
      )}
      {columns.includes('date') && <td style={{ ...td, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{order.date}</td>}
      {columns.includes('items') && <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{order.itemCount ?? order.items} items{order.express ? ' · Exp' : ''}</td>}
      {columns.includes('total') && <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--success-color)', whiteSpace: 'nowrap' }}>{(order.amount ?? order.total).toLocaleString()}</td>}
      {columns.includes('balance') && <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: order.balance > 0 ? (order.overdue ? 'var(--danger-color)' : 'var(--warning-color)') : 'var(--text-muted)', fontWeight: order.balance > 0 ? 600 : 400, whiteSpace: 'nowrap' }}>{order.balance > 0 ? order.balance.toLocaleString() : '—'}</td>}
      {columns.includes('status') && (
        <td style={td}>
          {order.overdue ? <Badge variant="danger">Overdue</Badge>
            : order.status === 'ready' ? <Badge variant="success">Ready</Badge>
            : order.status === 'collected' ? <Badge variant="muted">Collected</Badge>
            : <Badge variant="warning">Pending</Badge>}
        </td>
      )}
      {columns.includes('actions') && (
        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
          <button onClick={onView} style={{ background: 'transparent', border: 'none', color: 'var(--primary-color)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '4px 8px', fontFamily: 'inherit' }}>View</button>
          {order.status === 'ready' && <button onClick={onCollect} style={{ background: 'transparent', border: 'none', color: 'var(--success-color)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '4px 8px', fontFamily: 'inherit' }}>Collect</button>}
        </td>
      )}
    </tr>
  );
}

// ─── DataTable wrapper ────────────────────────────────
function DataTable({ columns, children, caption }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, border: '0.5px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      {caption && (
        <div style={{ padding: '10px 16px', borderBottom: '0.5px solid var(--border-color)', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.04em', background: 'var(--bg-1)' }}>
          {caption}
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--bg-1)' }}>
            <th style={{ width: 3, padding: 0 }} />
            {columns.map((c, i) => (
              <th key={i} style={{
                textAlign: c.align || 'left', padding: '8px 12px',
                fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'var(--text-muted)',
                borderBottom: '0.5px solid var(--border-color)', whiteSpace: 'nowrap',
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

Object.assign(window, { Logo, Button, Field, Input, Select, Badge, TierBadge, ReceiptChip, Card, StatCard, StatStrip, OrderRow, OrderTableRow, DataTable, Toast, PageHeader });
