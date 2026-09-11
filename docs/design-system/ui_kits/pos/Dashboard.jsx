/* global React, PageHeader, StatStrip, OrderTableRow, Button */
const { useState: useStateDB } = React;

const QUEUE = [
  { id: 'SC-00147', name: 'Robert W.',  phone: '+255 787 556 001', date: '18/04 09:14', itemCount: 5, amount: 32500, balance: 0,     status: 'pending' },
  { id: 'SC-00146', name: 'Faith L.',   phone: '+255 712 881 002', date: '18/04 10:02', itemCount: 2, amount: 8500,  balance: 0,     status: 'pending' },
  { id: 'SC-00145', name: 'Amina K.',   phone: '+255 754 222 119', date: '18/04 10:48', itemCount: 1, amount: 6000,  balance: 2000,  status: 'pending', express: true },
  { id: 'SC-00144', name: 'Baraka S.',  phone: '+255 768 303 414', date: '18/04 11:15', itemCount: 7, amount: 41000, balance: 0,     status: 'pending' },
  { id: 'SC-00143', name: 'Joyce N.',   phone: '+255 719 002 987', date: '18/04 11:52', itemCount: 2, amount: 7500,  balance: 0,     status: 'pending' },
  { id: 'SC-00142', name: 'Mwalimu J.', phone: '+255 712 345 678', date: '18/04 12:30', itemCount: 3, amount: 18500, balance: 0,     status: 'pending' },
  { id: 'SC-00141', name: 'David M.',   phone: '+255 788 112 990', date: '18/04 13:04', itemCount: 4, amount: 16000, balance: 6000,  status: 'pending' },
  { id: 'SC-00140', name: 'Neema T.',   phone: '+255 765 100 200', date: '17/04 16:42', itemCount: 2, amount: 9000,  balance: 0,     status: 'ready' },
  { id: 'SC-00139', name: 'Irene K.',   phone: '+255 714 220 110', date: '17/04 17:18', itemCount: 3, amount: 12500, balance: 0,     status: 'ready' },
  { id: 'SC-00138', name: 'Daniel O.',  phone: '+255 711 444 005', date: '17/04 17:55', itemCount: 4, amount: 14500, balance: 4500,  status: 'ready' },
  { id: 'SC-00135', name: 'Esther G.',  phone: '+255 767 881 233', date: '16/04 14:22', itemCount: 2, amount: 9500,  balance: 0,     status: 'ready' },
  { id: 'SC-00131', name: 'Peter M.',   phone: '+255 713 900 002', date: '15/04 10:18', itemCount: 4, amount: 22500, balance: 22500, status: 'ready', overdue: true },
];

const COLS = [
  { label: 'Receipt' },
  { label: 'Customer' },
  { label: 'Dropped' },
  { label: 'Items' },
  { label: 'Total TZS', align: 'right' },
  { label: 'Balance', align: 'right' },
  { label: 'Status' },
  { label: '', align: 'right' },
];

function Dashboard({ onNavigate }) {
  const [tab, setTab] = useStateDB('all');
  const filtered = tab === 'all' ? QUEUE : tab === 'overdue' ? QUEUE.filter(o => o.overdue) : QUEUE.filter(o => o.status === tab);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Tuesday · 18 April 2026 · Central branch"
        actions={<>
          <Button variant="secondary" icon="📈">Reports</Button>
          <Button variant="primary" icon="➕" onClick={() => onNavigate?.('new-order')}>New Order</Button>
        </>}
      />

      <StatStrip stats={[
        { label: 'Income today',  value: 'TZS 412,500', sub: '+18%',    accent: 'success' },
        { label: 'Orders today',  value: '27',          sub: '3 exp',   accent: 'info' },
        { label: 'Pending',       value: '14',          sub: '4 due',   accent: 'warning' },
        { label: 'Ready',         value: '9',                            accent: 'success' },
        { label: 'Overdue',       value: '1',           sub: '3d+',     accent: 'danger' },
        { label: 'Open balances', value: 'TZS 34,500',                   accent: 'warning' },
      ]} />

      <div style={{
        background: 'var(--bg-secondary)', borderRadius: 12,
        border: '0.5px solid var(--border-color)', boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '0.5px solid var(--border-color)', background: 'var(--bg-1)' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              ['all', `All · ${QUEUE.length}`],
              ['pending', `Pending · ${QUEUE.filter(o=>o.status==='pending').length}`],
              ['ready', `Ready · ${QUEUE.filter(o=>o.status==='ready').length}`],
              ['overdue', `Overdue · ${QUEUE.filter(o=>o.overdue).length}`],
            ].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={{
                padding: '6px 12px', border: 'none',
                background: tab === k ? 'var(--bg-secondary)' : 'transparent',
                color: tab === k ? 'var(--primary-color)' : 'var(--text-secondary)',
                fontWeight: 600, fontSize: 12, borderRadius: 6, cursor: 'pointer',
                boxShadow: tab === k ? 'var(--shadow-sm)' : 'none', fontFamily: 'inherit',
              }}>{l}</button>
            ))}
          </div>
          <input placeholder="Search receipt, name, phone…" style={{
            padding: '6px 12px', border: '1px solid var(--border-color)',
            borderRadius: 9999, fontSize: 12, background: 'var(--bg-secondary)',
            color: 'var(--text-primary)', outline: 'none', minWidth: 240, fontFamily: 'inherit',
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
            {filtered.map(o => (
              <OrderTableRow
                key={o.id} order={o}
                columns={['receipt','customer','date','items','total','balance','status','actions']}
                onView={() => onNavigate?.('orders')}
                onCollect={() => onNavigate?.('collection')}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;
