import React, { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Icon } from '../components/Icons';

export function LoginPage() {
  const { user, login, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!loading && user) return <Navigate to="/" replace />;
  const from = (location.state as any)?.from || '/';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (cause: any) {
      setError(cause?.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <section className="login-brand">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="brand-word">OpsWeave</span>
        </div>
        <div className="login-copy">
          <p className="eyebrow">Platform Foundation · 0.0.1</p>
          <h1>Operate a plugin platform that can heal itself.</h1>
          <p>Signed full-stack plugins, two-node placement, readiness-gated routing and bootstrap diagnostics — all visible from one controlled surface.</p>
        </div>
        <ul className="login-points">
          <li><Icon name="check" size={16} /> Desired, observed and effective state stay separate</li>
          <li><Icon name="check" size={16} /> Gateway only routes to READY, reachable replicas</li>
          <li><Icon name="check" size={16} /> Kernel recovery never depends on a business plugin</li>
        </ul>
        <p className="login-footnote">Internal experimental environment. Not a production HA claim.</p>
      </section>
      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <div className="login-form-head">
            <p className="eyebrow">Authorized access</p>
            <h2>Sign in</h2>
            <p>Use the bootstrap administrator configured for this environment.</p>
          </div>
          {error && <div className="inline-error" role="alert"><Icon name="warning" size={16} /> {error}</div>}
          <label className="field">
            <span className="field-label">Email</span>
            <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <button className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="login-help">Sessions are HttpOnly cookies with CSRF protection. Node and workload identities are separate credentials.</p>
        </form>
      </section>
    </div>
  );
}
