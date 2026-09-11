/* global React, PageHeader, Button, Field, Input, Select, Badge */
const { useState: useStateNO } = React;

const SERVICES = [
  { id: 'wash', label: 'Wash, Dry & Fold', price: 2500, unit: 'kg' },
  { id: 'press', label: 'Pressing', price: 1500, unit: 'item' },
  { id: 'express', label: 'Express Service', price: 4500, unit: 'kg' },
  { id: 'standard', label: 'Standard Washing', price: 2000, unit: 'kg' },
];

function NewOrder({ onSubmit }) {
  const [items, setItems] = useStateNO([
    { id: 1, type: 'Shirts', color: 'White', qty: 3, service: 'press' },
    { id: 2, type: 'Trousers', color: 'Dark', qty: 2, service: 'wash' },
  ]);
  const [paid, setPaid] = useStateNO(5000);

  const total = items.reduce((acc, it) => {
    const s = SERVICES.find(s => s.id === it.service);
    return acc + (s?.price || 0) * it.qty;
  }, 0);
  const balance = Math.max(0, total - paid);

  const addItem = () => setItems(i => [...i, { id: Date.now(), type: '', color: '', qty: 1, service: 'wash' }]);
  const updateItem = (id, patch) => setItems(list => list.map(it => it.id === id ? { ...it, ...patch } : it));
  const removeItem = (id) => setItems(list => list.filter(it => it.id !== id));

  return (
    <div>
      <PageHeader title="New Order" subtitle="Drop-off · prints a receipt when saved" />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Customer */}
          <section style={{ background: 'var(--bg-secondary)', borderRadius: 16, border: '0.5px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', padding: 20 }}>
            <h3 style={{ margin: 0, marginBottom: 14, fontSize: 17, letterSpacing: '-0.02em' }}>Customer</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Name"><Input defaultValue="Grace Mollel" /></Field>
              <Field label="Phone" hint="SMS sent here when ready"><Input defaultValue="+255 712 004 456" /></Field>
            </div>
          </section>

          {/* Items */}
          <section style={{ background: 'var(--bg-secondary)', borderRadius: 16, border: '0.5px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 17, letterSpacing: '-0.02em' }}>Garments</h3>
              <Button size="sm" variant="secondary" icon="➕" onClick={addItem}>Add item</Button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items.map(it => (
                <div key={it.id} style={{
                  display: 'grid', gridTemplateColumns: '1.4fr 1fr 80px 1.4fr auto',
                  gap: 8, alignItems: 'center',
                  padding: 10, background: 'var(--bg-1)', borderRadius: 12,
                }}>
                  <Input value={it.type} placeholder="Type (shirt, dress…)" onChange={e => updateItem(it.id, { type: e.target.value })} />
                  <Input value={it.color} placeholder="Color" onChange={e => updateItem(it.id, { color: e.target.value })} />
                  <Input type="number" value={it.qty} min={1} onChange={e => updateItem(it.id, { qty: +e.target.value || 1 })} />
                  <Select value={it.service} onChange={e => updateItem(it.id, { service: e.target.value })}>
                    {SERVICES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </Select>
                  <button onClick={() => removeItem(it.id)} style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', fontSize: 18, cursor: 'pointer', padding: '0 8px' }} title="Remove">✕</button>
                </div>
              ))}
            </div>
          </section>

          {/* Notes */}
          <section style={{ background: 'var(--bg-secondary)', borderRadius: 16, border: '0.5px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', padding: 20 }}>
            <Field label="Notes for the counter">
              <textarea placeholder="e.g. stain on trouser pocket, separate wash"
                style={{
                  padding: 14, border: '2px solid var(--border-color)', borderRadius: 12,
                  fontSize: 15, background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                  outline: 'none', fontFamily: 'inherit', minHeight: 70, resize: 'vertical',
                }} />
            </Field>
          </section>
        </div>

        {/* Summary */}
        <aside style={{
          position: 'sticky', top: 16,
          background: 'var(--bg-secondary)', borderRadius: 16, border: '0.5px solid var(--border-color)',
          boxShadow: 'var(--shadow-md)', padding: 20,
        }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>Receipt summary</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 14, borderBottom: '0.5px dashed var(--border-color)' }}>
            {items.map(it => {
              const s = SERVICES.find(s => s.id === it.service);
              return (
                <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{it.qty}× {it.type || '—'} · {s?.label}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{((s?.price||0)*it.qty).toLocaleString()}</span>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '14px 0' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total</span>
            <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>TZS {total.toLocaleString()}</span>
          </div>

          <Field label="Paid at drop-off">
            <Input type="number" value={paid} onChange={e => setPaid(+e.target.value || 0)} />
          </Field>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, fontSize: 14 }}>
            <span style={{ color: 'var(--text-secondary)' }}>Balance</span>
            <span style={{ color: balance > 0 ? 'var(--warning-color)' : 'var(--success-color)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              TZS {balance.toLocaleString()}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <Button variant="secondary" size="lg">Cancel</Button>
            <Button variant="primary" size="lg" onClick={onSubmit}>Save & Print</Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

window.NewOrder = NewOrder;
