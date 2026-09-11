/* global React, PageHeader, Button, Field, Input, Badge, ReceiptChip, OrderTableRow */
const { useState: useStateCL } = React;

const READY_ORDERS = [
  { id: 'SC-00140', name: 'Neema T.',  phone: '+255 765 100 200', date: '17/04 16:42', itemCount: 2, amount: 9000,  balance: 0,     status: 'ready' },
  { id: 'SC-00139', name: 'Irene K.',  phone: '+255 714 220 110', date: '17/04 17:18', itemCount: 3, amount: 12500, balance: 0,     status: 'ready' },
  { id: 'SC-00138', name: 'Daniel O.', phone: '+255 711 444 005', date: '17/04 17:55', itemCount: 4, amount: 14500, balance: 4500,  status: 'ready' },
  { id: 'SC-00135', name: 'Esther G.', phone: '+255 767 881 233', date: '16/04 14:22', itemCount: 2, amount: 9500,  balance: 0,     status: 'ready' },
  { id: 'SC-00133', name: 'Joyce M.',  phone: '+255 712 660 004', date: '15/04 12:09', itemCount: 1, amount: 4500,  balance: 0,     status: 'ready' },
  { id: 'SC-00131', name: 'Peter M.',  phone: '+255 713 900 002', date: '15/04 10:18', itemCount: 4, amount: 22500, balance: 22500, status: 'ready', overdue: true },
];

const COLS = [
  { label: 'Receipt' },
  { label: 'Customer' },
  { label: 'Ready since' },
  { label: 'Items' },
  { label: 'Total TZS', align: 'right' },
  { label: 'Balance', align: 'right' },
  { label: 'Status' },
  { label: '', align: 'right' },
];

function Collection({ onToast }) {
  const [code, setCode] = useStateCL('');
  const [scanned, setScanned] = useStateCL(null);
  const lookup = (q) => READY_ORDERS.find(o => o.id.toLowerCase().includes(q.toLowerCase()));

  const submit = (e) => {
    e.preventDefault();
    const hit = lookup(code);
    if (hit) setScanned(hit);
    else if (code) onToast?.({ type: 'error', msg: 'Receipt not found', sub: 'Check the number with the customer.' });
  };

  const confirmCollection = () => {
    onToast?.({ type: 'success', msg: 'Order collected', sub: `${scanned.name} · SMS sent` });
    setScanned(null); setCode('');
  };

  return (
    <div>
      <PageHeader title="Collection" subtitle="Scan the receipt or pick from the ready list" />

      {/* Compact scan bar */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center',
        background: 'var(--bg-secondary)', padding: '10px 14px',
        borderRadius: 12, border: '0.5px solid var(--border-color)',
        boxShadow: 'var(--shadow-sm)', marginBottom: 10,
      }}>
        <span style={{ fontSize: 18 }}>🔍</span>
        <form onSubmit={submit} style={{ flex: 1, display: 'flex', gap: 8 }}>
          <input
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            placeholder="Scan or type receipt — SC-00000"
            autoFocus
            style={{
              flex: 1, padding: '8px 12px',
              border: '1px solid var(--border-color)', borderRadius: 8,
              fontSize: 14, fontFamily: 'var(--font-mono)', letterSpacing: '0.05em',
              background: 'var(--bg-1)', color: 'var(--text-primary)', outline: 'none',
            }}
          />
          <Button size="sm" variant="primary">Look up</Button>
        </form>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {READY_ORDERS.length} ready · {READY_ORDERS.filter(o => o.overdue).length} overdue
        </div>
      </div>

      {/* Scanned result inline banner */}
      {scanned && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '10px 14px', marginBottom: 10,
          background: scanned.overdue ? 'rgba(255,59,48,0.06)' : 'rgba(52,199,89,0.08)',
          border: `1px solid ${scanned.overdue ? 'rgba(255,59,48,0.3)' : 'rgba(52,199,89,0.3)'}`,
          borderLeft: `4px solid ${scanned.overdue ? 'var(--danger-color)' : 'var(--success-color)'}`,
          borderRadius: 12,
        }}>
          <ReceiptChip id={scanned.id} overdue={scanned.overdue} filled={!scanned.overdue} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{scanned.name} · <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontFamily: 'var(--font-mono)' }}>{scanned.phone}</span></div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {scanned.itemCount} items · Total TZS {scanned.amount.toLocaleString()}
              {scanned.balance > 0 && <> · <span style={{ color: 'var(--warning-color)', fontWeight: 600 }}>Balance TZS {scanned.balance.toLocaleString()}</span></>}
            </div>
          </div>
          <Badge variant={scanned.overdue ? 'danger' : 'success'}>{scanned.overdue ? 'Overdue' : 'Ready'}</Badge>
          <Button size="sm" variant="secondary" onClick={() => { setScanned(null); setCode(''); }}>Cancel</Button>
          <Button size="sm" variant="success" onClick={confirmCollection}>✓ Confirm collection</Button>
        </div>
      )}

      {/* Ready list — dense table */}
      <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, border: '0.5px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border-color)', background: 'var(--bg-1)', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.04em' }}>
          Ready for collection · sorted by age
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
            {READY_ORDERS.map(o => (
              <OrderTableRow
                key={o.id} order={o}
                columns={['receipt','customer','date','items','total','balance','status','actions']}
                onView={() => { setCode(o.id); setScanned(o); }}
                onCollect={() => { setCode(o.id); setScanned(o); }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

window.Collection = Collection;
