/* global React, Logo */
const { useState: useStateSB } = React;

function Sidebar({ current, onNavigate, collapsed }) {
  const groups = [
    { label: null, items: [
      { key: 'dashboard', label: 'Dashboard', icon: '📊' },
    ]},
    { label: 'Counter', items: [
      { key: 'new-order', label: 'New Order', icon: '➕' },
      { key: 'collection', label: 'Collection', icon: '✅' },
    ]},
    { label: 'Orders & customers', items: [
      { key: 'orders', label: 'Orders', icon: '📋' },
      { key: 'customers', label: 'Customers', icon: '👥' },
      { key: 'price-list', label: 'Price List', icon: '💰' },
      { key: 'billing', label: 'Monthly Billing', icon: '📄' },
    ]},
    { label: 'Money & reports', items: [
      { key: 'cash', label: 'Cash Management', icon: '💵' },
      { key: 'expenses', label: 'Expenses', icon: '📝' },
      { key: 'payroll', label: 'Payroll', icon: '👨‍💼' },
      { key: 'reports', label: 'Reports', icon: '📈' },
    ]},
    { label: null, items: [
      { key: 'cleaning', label: 'Cleaning Services', icon: '🧹' },
    ]},
    { label: 'Admin', items: [
      { key: 'branches', label: 'Branches', icon: '🏢' },
      { key: 'banking', label: 'Banking', icon: '🏦' },
    ]},
  ];
  const W = collapsed ? 88 : 280;
  return (
    <aside style={{
      position: 'fixed', left: 0, top: 0, height: '100vh', width: W,
      background: 'rgba(248,248,248,0.8)',
      backdropFilter: 'blur(30px) saturate(180%)',
      WebkitBackdropFilter: 'blur(30px) saturate(180%)',
      borderRight: '0.5px solid var(--border-color)',
      display: 'flex', flexDirection: 'column',
      transition: 'width 0.4s cubic-bezier(0.36, 0.66, 0.04, 1)',
      zIndex: 10,
    }}>
      <div style={{ padding: collapsed ? '20px 10px' : '28px 24px 24px', borderBottom: '0.5px solid var(--border-color)', textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: collapsed ? 0 : 12 }}>
          <Logo size={collapsed ? 46 : 56} />
        </div>
        {!collapsed && (<>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', margin: 0, marginBottom: 4 }}>SUPACLEAN</h2>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '1.5px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>POS System</div>
          <span style={{
            fontSize: 11, color: 'var(--primary-color)', fontWeight: 600,
            padding: '2px 10px', background: 'var(--primary-light)',
            borderRadius: 6, display: 'inline-block',
          }}>Arusha · Central</span>
        </>)}
      </div>

      <nav style={{ padding: '16px 0', flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {groups.map((g, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            {g.label && !collapsed && (
              <div style={{ padding: '8px 16px 4px 20px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600, color: 'var(--text-muted)' }}>{g.label}</div>
            )}
            {g.items.map(item => {
              const active = current === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => onNavigate(item.key)}
                  style={{
                    display: 'flex', alignItems: 'center', width: 'auto',
                    padding: collapsed ? '12px 8px' : '10px 14px',
                    margin: '2px 12px', minHeight: 44, boxSizing: 'border-box',
                    background: active ? 'var(--primary-light)' : 'transparent',
                    color: active ? 'var(--primary-color)' : 'var(--text-secondary)',
                    borderRadius: 12, border: 'none',
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    cursor: 'pointer', fontSize: 15,
                    fontWeight: active ? 600 : 500,
                    transition: 'all 0.4s cubic-bezier(0.36, 0.66, 0.04, 1)',
                    width: collapsed ? 'calc(100% - 24px)' : 'calc(100% - 24px)',
                    textAlign: 'left', fontFamily: 'inherit',
                  }}
                  onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.transform = 'translateX(2px)'; e.currentTarget.style.color = 'var(--text-primary)'; } }}
                  onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.transform = ''; e.currentTarget.style.color = 'var(--text-secondary)'; } }}
                >
                  <span style={{ fontSize: 20, marginRight: collapsed ? 0 : 12, width: 24, textAlign: 'center' }}>{item.icon}</span>
                  {!collapsed && <span>{item.label}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {!collapsed && (
        <div style={{ padding: '16px 20px 20px', borderTop: '0.5px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '10px 14px', background: 'var(--bg-secondary)',
            border: '0.5px solid var(--border-color)', borderRadius: 12,
            color: 'var(--text-primary)', fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}>🌙 <span>Dark Mode</span></button>
          <button style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '10px', background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)', borderRadius: 12,
            color: '#ef4444', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>🚪 Logout</button>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2, lineHeight: 1.4, textAlign: 'center' }}>Arusha, Tanzania</div>
        </div>
      )}
    </aside>
  );
}

window.Sidebar = Sidebar;
