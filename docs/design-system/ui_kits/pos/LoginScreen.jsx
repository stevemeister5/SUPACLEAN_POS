/* global React, Logo, Button, Field, Input */
const { useState: useStateLI } = React;

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useStateLI('admin');
  const [password, setPassword] = useStateLI('admin123');
  const [loading, setLoading] = useStateLI(false);

  const submit = (e) => {
    e.preventDefault();
    setLoading(true);
    setTimeout(() => { setLoading(false); onLogin?.(); }, 600);
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #DCE8FF 0%, #F2F2F7 60%, #fff 100%)',
      padding: 20,
    }}>
      <div style={{
        background: 'var(--bg-secondary)', borderRadius: 20, padding: 40,
        width: '100%', maxWidth: 420,
        boxShadow: '0 20px 60px rgba(37, 99, 235, 0.18)',
        border: '0.5px solid var(--border-color)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <Logo size={80} />
          </div>
          <h1 style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em', margin: 0, marginBottom: 6 }}>SUPACLEAN</h1>
          <p style={{ fontSize: 15, color: 'var(--text-secondary)', margin: 0, marginBottom: 2 }}>Laundry & Dry Cleaning POS</p>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic', margin: 0 }}>Arusha, Tanzania</p>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Field label="Username">
            <Input value={username} onChange={e => setUsername(e.target.value)} placeholder="Enter your username" disabled={loading} autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" disabled={loading} />
          </Field>
          <Button variant="primary" size="lg" disabled={loading || !username || !password}>
            {loading ? 'Logging in…' : 'Login'}
          </Button>
        </form>

        <div style={{ marginTop: 22, paddingTop: 22, borderTop: '1px solid var(--border-color)', textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Default credentials: <b>admin</b> / <b>admin123</b>
          </div>
          <div style={{ fontSize: 11, color: 'var(--warning-color)', fontStyle: 'italic' }}>
            ⚠️ Please change default password after first login
          </div>
        </div>
      </div>
    </div>
  );
}

window.LoginScreen = LoginScreen;
