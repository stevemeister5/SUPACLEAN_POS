/* global React, PageHeader, Button, Badge, ReceiptChip, TierBadge, OrderTableRow */
const { useState: useStateOR } = React;

const ALL_ORDERS = [
  { id: 'SC-00147', name: 'Robert W.',  phone: '+255 787 556 001', date: '18/04/26', itemCount: 5, amount: 32500, balance: 0,     status: 'pending' },
  { id: 'SC-00146', name: 'Faith L.',   phone: '+255 712 881 002', date: '18/04/26', itemCount: 2, amount: 8500,  balance: 0,     status: 'pending' },
  { id: 'SC-00145', name: 'Amina K.',   phone: '+255 754 222 119', date: '18/04/26', itemCount: 1, amount: 6000,  balance: 2000,  status: 'pending', express: true },
  { id: 'SC-00144', name: 'Baraka S.',  phone: '+255 768 303 414', date: '18/04/26', itemCount: 7, amount: 41000, balance: 0,     status: 'pending' },
  { id: 'SC-00143', name: 'Joyce N.',   phone: '+255 719 002 987', date: '18/04/26', itemCount: 2, amount: 7500,  balance: 0,     status: 'pending' },
  { id: 'SC-00142', name: 'Mwalimu J.', phone: '+255 712 345 678', date: '18/04/26', itemCount: 3, amount: 18500, balance: 0,     status: 'pending' },
  { id: 'SC-00141', name: 'David M.',   phone: '+255 788 112 990', date: '18/04/26', itemCount: 4, amount: 16000, balance: 6000,  status: 'pending' },
  { id: 'SC-00140', name: 'Neema T.',   phone: '+255 765 100 200', date: '17/04/26', itemCount: 2, amount: 9000,  balance: 0,     status: 'ready' },
  { id: 'SC-00139', name: 'Irene K.',   phone: '+255 714 220 110', date: '17/04/26', itemCount: 3, amount: 12500, balance: 0,     status: 'ready' },
  { id: 'SC-00138', name: 'Daniel O.',  phone: '+255 711 444 005', date: '17/04/26', itemCount: 4, amount: 14500, balance: 4500,  status: 'ready' },
  { id: 'SC-00135', name: 'Esther G.',  phone: '+255 767 881 233', date: '16/04/26', itemCount: 2, amount: 9500,  balance: 0,     status: 'ready' },
  { id: 'SC-00131', name: 'Peter M.',   phone: '+255 713 900 002', date: '15/04/26', itemCount: 4, amount: 22500, balance: 22500, status: 'ready', overdue: true },
  { id: 'SC-00125', name: 'Sarah M.',   phone: '+255 718 223 440', date: '14/04/26', itemCount: 3, amount: 11000, balance: 0,     status: 'collected' },
  { id: 'SC-00124', name: 'John B.',    phone: '+255 715 990 112', date: '14/04/26', itemCount: 6, amount: 28000, balance: 0,     status: 'collected' },
  { id: 'SC-00123', name: 'Agnes R.',   phone: '+255 719 881 223', date: '14/04/26', itemCount: 2, amount: 7500,  balance: 0,     status: 'collected' },
  { id: 'SC-00122', name: 'Michael W.', phone: '+255 768 556 991', date: '13/04/26', itemCount: 5, amount: 24000, balance: 0,     status: 'collected' },
  { id: 'SC-00121', name: 'Lucy P.',    phone: '+255 712 003 887', date: '13/04/26', itemCount: 1, amount: 3500,  balance: 0,     status: 'collected' },
];

const COLS = [
  { label: 'Receipt' },
  { label: 'Customer' },
  { label: 'Date' },
  { label: 'Items' },
  { label: 'Total TZS', align: 'right' },
  { label: 'Balance', align: 'right' },
  { label: 'Status' },
  { label: '', align: 'right' },
];

function Orders() {
  const [filter, setFilter] = useStateOR('all');
  const rows = filter === 'all' ? ALL_ORDERS
    : filter === 'overdue' ? ALL_ORDERS.filter(o => o.overdue)
    : ALL_ORDERS.filter(o => o.status === filter);

  const pill = (k, label) => (
    <button key={k} onClick={() => setFilter(k)} style={{
      padding: '6px 12px', border: 'none',
      background: filter === k ? 'var(--bg-secondary)' : 'transparent',
      color: filter === k ? 'var(--primary-color)' : 'var(--text-secondary)',
      fontWeight: 600, fontSize: 12, borderRadius: 6, cursor: 'pointer',
      boxShadow: filter === k ? 'var(--shadow-sm)' : 'none', fontFamily: 'inherit',
    }}>{label}</button>
  );

  return (
    <div>
      <PageHeader title="Orders" subtitle={`${rows.length} shown of ${ALL_ORDERS.length} total`} actions={<Button variant="primary" icon="➕">New Order</Button>} />

      <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, border: '0.5px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--bg-1)', borderBottom: '0.5px solid var(--border-color)' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {pill('all', `All · ${ALL_ORDERS.length}`)}
            {pill('pending', `Pending · ${ALL_ORDERS.filter(o=>o.status==='pending').length}`)}
            {pill('ready', `Ready · ${ALL_ORDERS.filter(o=>o.status==='ready').length}`)}
            {pill('collected', `Collected · ${ALL_ORDERS.filter(o=>o.status==='collected').length}`)}
            {pill('overdue', `Overdue · ${ALL_ORDERS.filter(o=>o.overdue).length}`)}
          </div>
          <input placeholder="Search…" style={{
            padding: '6px 12px', border: '1px solid var(--border-color)',
            borderRadius: 9999, fontSize: 12, background: 'var(--bg-secondary)',
            color: 'var(--text-primary)', outline: 'none', minWidth: 220, fontFamily: 'inherit',
          }} />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg-1)' }}>
              <th style={{ width: 3, padding: 0 }} />
              {COLS.map((c, i) => (
                <th key={i} style={{
                  textAlign: c.align || 'left', padding: '8px 12px',
                  fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: 'var(--text-muted)',
                  borderBottom: '0.5px solid var(--border-color)', whiteSpace: 'nowrap',
                }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(o => (
              <OrderTableRow key={o.id} order={o}
                columns={['receipt','customer','date','items','total','balance','status','actions']} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const CUSTOMERS = [
  { name: 'Mwalimu Juma',  phone: '+255 712 345 678', lastVisit: '18/04/26', visits: 42, spend: 412500, balance: 0,    tier: 'PLATINUM' },
  { name: 'Amina Kassim',  phone: '+255 754 222 119', lastVisit: '18/04/26', visits: 28, spend: 186000, balance: 2000, tier: 'GOLD' },
  { name: 'Peter Mollel',  phone: '+255 713 900 002', lastVisit: '15/04/26', visits: 19, spend: 124500, balance: 22500, tier: 'GOLD' },
  { name: 'Neema Temba',   phone: '+255 765 100 200', lastVisit: '17/04/26', visits: 11, spend: 78000,  balance: 0,    tier: 'SILVER' },
  { name: 'Robert Wambura',phone: '+255 787 556 001', lastVisit: '18/04/26', visits: 9,  spend: 64500,  balance: 0,    tier: 'SILVER' },
  { name: 'Esther Gama',   phone: '+255 767 881 233', lastVisit: '16/04/26', visits: 8,  spend: 52000,  balance: 0,    tier: 'SILVER' },
  { name: 'Daniel Omari',  phone: '+255 711 444 005', lastVisit: '17/04/26', visits: 6,  spend: 32000,  balance: 4500, tier: 'BRONZE' },
  { name: 'Faith Lyimo',   phone: '+255 712 881 002', lastVisit: '18/04/26', visits: 4,  spend: 18500,  balance: 0,    tier: 'BRONZE' },
  { name: 'Irene Kato',    phone: '+255 714 220 110', lastVisit: '17/04/26', visits: 3,  spend: 14000,  balance: 0,    tier: 'BRONZE' },
  { name: 'David Mushi',   phone: '+255 788 112 990', lastVisit: '18/04/26', visits: 2,  spend: 9500,   balance: 6000, tier: 'BRONZE' },
];

function Customers() {
  const td = { padding: '8px 12px', fontSize: 13, borderBottom: '0.5px solid var(--border-light)', verticalAlign: 'middle' };
  const th = { textAlign: 'left', padding: '8px 12px', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '0.5px solid var(--border-color)', whiteSpace: 'nowrap' };
  return (
    <div>
      <PageHeader title="Customers" subtitle={`${CUSTOMERS.length} shown · loyalty enabled`} actions={<Button variant="primary" icon="➕">Add customer</Button>} />
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, border: '0.5px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', background: 'var(--bg-1)', borderBottom: '0.5px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.04em' }}>Sorted by lifetime spend</div>
          <input placeholder="Search name or phone…" style={{
            padding: '6px 12px', border: '1px solid var(--border-color)', borderRadius: 9999,
            fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)',
            outline: 'none', minWidth: 240, fontFamily: 'inherit',
          }} />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg-1)' }}>
              <th style={th}>Name</th>
              <th style={th}>Phone</th>
              <th style={th}>Last visit</th>
              <th style={{ ...th, textAlign: 'right' }}>Visits</th>
              <th style={{ ...th, textAlign: 'right' }}>Lifetime TZS</th>
              <th style={{ ...th, textAlign: 'right' }}>Balance</th>
              <th style={th}>Tier</th>
              <th style={{ ...th, textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {CUSTOMERS.map(c => (
              <tr key={c.phone} onMouseEnter={e => e.currentTarget.style.background='var(--bg-1)'} onMouseLeave={e => e.currentTarget.style.background=''}>
                <td style={{ ...td, fontWeight: 600 }}>{c.name}</td>
                <td style={{ ...td, fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{c.phone}</td>
                <td style={{ ...td, color: 'var(--text-secondary)' }}>{c.lastVisit}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.visits}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--success-color)' }}>{c.spend.toLocaleString()}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: c.balance > 0 ? 'var(--warning-color)' : 'var(--text-muted)', fontWeight: c.balance > 0 ? 600 : 400 }}>{c.balance > 0 ? c.balance.toLocaleString() : '—'}</td>
                <td style={td}><TierBadge tier={c.tier} /></td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button style={{ background: 'transparent', border: 'none', color: 'var(--primary-color)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '4px 8px', fontFamily: 'inherit' }}>View</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlaceholderScreen({ title, icon, message }) {
  return (
    <div>
      <PageHeader title={title} />
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, border: '0.5px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', padding: 40, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.5 }}>{icon}</div>
        <div style={{ fontSize: 14, color: 'var(--text-muted)', fontStyle: 'italic' }}>{message}</div>
      </div>
    </div>
  );
}

Object.assign(window, { Orders, Customers, PlaceholderScreen });
