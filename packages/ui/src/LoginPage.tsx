import React, { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@opsweave/platform-client/auth';
import {
  canEnterSurface,
  surfaceEntryPath,
  type AccessInfo,
  type Surface,
} from '@opsweave/platform-client/surface';
import { Icon } from '@opsweave/ui/icons';
import { Button } from '@opsweave/ui/button';
import { useT } from '@opsweave/platform-client/i18n';

/**
 * Where a just-signed-in caller belongs.
 *
 * `signInTarget` answers that from the grant the login response itself carried,
 * so the page navigates ONCE. The previous shape navigated to `/` and let the
 * entry route decide, which meant a caller granted only the workspace took two
 * navigations: the client-side hop to `/`, then a document navigation into the
 * other bundle. During the second one, any navigation already in flight is
 * cancelled - a real user tapping a link out of the sign-in transition, or a
 * test that goes straight to the page it needs, was interrupted by it.
 *
 * `null` means "this account may not enter anything": the caller is shown the
 * forbidden page rather than being sent somewhere it will only be refused.
 */
export function signInTarget(access: AccessInfo, from: string): string | null {
  if (canEnterSurface(access, 'admin')) return from;
  if (canEnterSurface(access, 'workspace')) return surfaceEntryPath('workspace');
  return null;
}

/**
 * Is `target` served by the OTHER application's bundle?
 *
 * The two applications are separate documents, so a client-side route to a path
 * the current bundle does not own would render this bundle's 404. The entry
 * route keeps the same knowledge; it is duplicated here rather than moved into
 * the shared package because the shared package must not learn either
 * application's route tree (ADR-022 §2.2).
 */
function isForeignBundle(target: string, home: Surface): boolean {
  const own = home === 'admin' ? '/admin/' : '/app/';
  const other = home === 'admin' ? '/app/' : '/admin/';
  if (target.startsWith(own)) return false;
  return target.startsWith(other);
}

export function LoginPage({ surface }: { surface: Surface }) {
  const t = useT();
  const { user, login, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A sign-in SUBMITTED here owns the next navigation, and this component must not
  // race it.
  //
  // `login()` sets `user` before it resolves, so the moment the POST commits the
  // component re-renders with a session. The `!loading && user` branch below then
  // renders `<Navigate to="/">` in the render body - which is a navigation, issued
  // while `submit` is still awaiting the promise that will navigate somewhere else.
  // On a caller granted only the workspace the two disagreed loudly: `/` mounted the
  // console's entry route, which replaced the document to `/app/home`, and the
  // caller's own navigation was cancelled by it. That is the `page.goto:
  // Navigation ... is interrupted by another navigation to /app/home` seen in CI.
  //
  // Two navigations from one click is one too many whether or not they collide, so
  // the submitted path is excluded from the render-body redirect rather than made to
  // win a race. The flag is set before the await and never cleared: after a failed
  // sign-in the form must stay put and show the error, not bounce to `/`.
  const [submitted, setSubmitted] = useState(false);
  if (!loading && user && !submitted) return <Navigate to="/" replace />;
  const from = (location.state as { from?: string } | null)?.from || '/';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setBusy(true);
    setError(null);
    try {
      const access = await login(email.trim(), password);
      const target = signInTarget(access, from);
      if (target === null) {
        navigate('/403', { replace: true });
      } else if (isForeignBundle(target, surface)) {
        // A document navigation, deliberately: it loads the other application's
        // router. `navigate()` here would stay inside this bundle.
        window.location.replace(target);
      } else {
        navigate(target, { replace: true });
      }
    } catch (cause: any) {
      // Server text is diagnostic detail; the localized message is the primary copy.
      setError(cause?.message || t('login.error.failed'));
      setSubmitted(false);
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
        {/* The three ticks that used to sit here were design declarations, not facts about
            this deployment: "kernel recovery never depends on a business plugin" is a property
            of the architecture, and a sign-in screen is not where it is proven. Deleted rather
            than reworded. The one caveat that IS about this environment stays. */}
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
          <Button type="submit" data-testid="login-submit" className="w-full" disabled={busy}>{busy ? t('login.submitPending') : t('login.submit')}</Button>
        </form>
      </section>
    </div>
  );
}
