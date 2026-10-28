import React, { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Icon } from '../components/Icons';
import { useT } from '../i18n';

export function LoginPage() {
  const t = useT();
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
      // Server text is diagnostic detail; the localized message is the primary copy.
      setError(cause?.message || t('login.error.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <section className="login-brand">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="brand-word">{t('app.brand')}</span>
        </div>
        <div className="login-copy">
          <p className="eyebrow">{t('login.eyebrow')}</p>
          <h1>{t('login.headline')}</h1>
          <p>{t('login.lead')}</p>
        </div>
        <ul className="login-points">
          <li><Icon name="check" size={16} /> {t('login.point.stateSeparate')}</li>
          <li><Icon name="check" size={16} /> {t('login.point.gatewayReady')}</li>
          <li><Icon name="check" size={16} /> {t('login.point.recoveryIndependent')}</li>
        </ul>
        <p className="login-footnote">{t('login.footnote')}</p>
      </section>
      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <div className="login-form-head">
            <p className="eyebrow">{t('login.form.eyebrow')}</p>
            <h2>{t('login.form.title')}</h2>
            <p>{t('login.form.lead')}</p>
          </div>
          {error && <div className="inline-error" role="alert"><Icon name="warning" size={16} /> {error}</div>}
          <label className="field">
            <span className="field-label">{t('login.field.email')}</span>
            <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span className="field-label">{t('login.field.password')}</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <button className="btn btn-primary btn-wide" disabled={busy}>{busy ? t('login.submitPending') : t('login.submit')}</button>
          <p className="login-help">{t('login.help')}</p>
        </form>
      </section>
    </div>
  );
}
