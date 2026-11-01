import React, { useState } from 'react';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { NoticeBar } from '../components/app/async-boundary';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import type { Connector } from './sources-model';
import { maskReference, validateCredentialRef, type CredentialRefResult } from './sources-model';

/**
 * The connector configuration form.
 *
 * Two things make this file worth keeping apart from `Sources.tsx`.
 *
 * **It is the security boundary.** `rules/03-security.md` is unconditional: plugin secrets are
 * references with short-lived access grants, and they must never enter a log, a manifest, a URL
 * or an error response. So this form has no field that accepts secret material. The credential
 * input takes a `secret://…` reference or an environment variable NAME, the validator refuses
 * anything shaped like a token before it can be submitted, and the rejection message never
 * echoes what was typed — a message that quoted the refused input would put it straight into the
 * DOM, and from there into a screenshot. `type="text"` is deliberate, not an oversight: a
 * password field would imply this is where a secret goes.
 *
 * **It cannot save yet, and says so.** There is no kernel endpoint that persists per-connector
 * configuration in this build — the router (`apps/kernel/src/routes.rs`) exposes plugin
 * lifecycle verbs, capability grants and storage bindings, and nothing that writes a connector
 * config document. Rendering a Save button that silently did nothing, or that wrote to an
 * endpoint invented here, would be the "demo-driven" failure `AGENTS.md` forbids. The form
 * therefore validates in full, shows exactly what it *would* send, and states the missing
 * interface instead of pretending to store it.
 *
 * What a connector plugin has to agree to is only this: its credential arrives as a reference
 * or an environment variable name resolved on the node, never as a literal from this UI.
 */

/** The credential shapes a connector may be handed. Neither is secret material. */
type CredentialMode = 'secretRef' | 'envVar';

const MODE_LABEL: Record<CredentialMode, MessageKey> = {
  secretRef: 'sources.config.mode.secretRef',
  envVar: 'sources.config.mode.envVar',
};

const MODE_HINT: Record<CredentialMode, MessageKey> = {
  secretRef: 'sources.config.mode.secretRef.hint',
  envVar: 'sources.config.mode.envVar.hint',
};

const MODE_PLACEHOLDER: Record<CredentialMode, MessageKey> = {
  secretRef: 'sources.config.credential.placeholder.secretRef',
  envVar: 'sources.config.credential.placeholder.envVar',
};

/** One message per rejection reason. None of them contains the rejected value. */
const REJECTION: Record<Exclude<CredentialRefResult, { ok: true }>['code'], MessageKey> = {
  empty: 'sources.config.error.empty',
  looksLikeSecret: 'sources.config.error.looksLikeSecret',
  badShape: 'sources.config.error.badShape',
  tooLong: 'sources.config.error.tooLong',
};

/** Label + control + hint, matching the shared `Field` shape used elsewhere in the shell. */
function Field({
  label,
  hint,
  htmlFor,
  error,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ow-source-field">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        // Not colour alone: the glyph and the sentence carry it too (rules/06-ui-ux.md).
        <p className="ow-source-field-error" role="alert">
          <Icon name="warning" size={13} /> {error}
        </p>
      ) : hint ? (
        <p className="ow-source-field-hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function ConnectorConfigForm({
  connector,
  canOperate,
  onClose,
}: {
  connector: Connector;
  canOperate: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [endpoint, setEndpoint] = useState('');
  const [mode, setMode] = useState<CredentialMode>('secretRef');
  const [credential, setCredential] = useState('');
  const [touched, setTouched] = useState(false);

  const result = validateCredentialRef(credential);
  // The mode is a declaration of intent, so a value that is valid for the *other* shape is
  // still wrong here: picking "environment variable" and pasting a secret:// path is a mistake
  // worth naming rather than silently accepting.
  const modeMismatch = result.ok && result.kind !== mode;
  const credentialError = touched && credential.length > 0
    ? (!result.ok ? t(REJECTION[result.code]) : modeMismatch ? t('sources.config.error.modeMismatch') : undefined)
    : undefined;

  const endpointError = touched && endpoint.trim().length > 0 && !isHttpUrl(endpoint)
    ? t('sources.config.error.endpoint')
    : undefined;

  const complete = isHttpUrl(endpoint) && result.ok && !modeMismatch;

  return (
    <div className="ow-source-detail" data-testid="sources-config-form">
      {/* The interface this form is waiting for, stated before anything else, so nobody fills
          it in expecting it to persist. */}
      <NoticeBar
        state="notConfigured"
        title={t('sources.config.absent.title')}
        detail={t('sources.config.absent.detail')}
      />

      {!canOperate ? (
        <NoticeBar
          state="forbidden"
          title={t('sources.config.forbidden.title')}
          detail={t('sources.config.forbidden.detail')}
        />
      ) : null}

      <form
        className="ow-source-form"
        onSubmit={(event) => {
          // Nothing to submit to. Prevented so a stray Enter cannot navigate the surface away.
          event.preventDefault();
          setTouched(true);
        }}
      >
        <Field
          label={t('sources.config.endpoint')}
          hint={t('sources.config.endpoint.hint')}
          htmlFor="source-endpoint"
          error={endpointError}
        >
          <Input
            id="source-endpoint"
            value={endpoint}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('sources.config.endpoint.placeholder')}
            aria-invalid={endpointError ? true : undefined}
            onBlur={() => setTouched(true)}
            onChange={(event) => setEndpoint(event.target.value)}
            data-testid="sources-config-endpoint"
          />
        </Field>

        <Field label={t('sources.config.mode')} hint={t(MODE_HINT[mode])} htmlFor="source-credential-mode">
          <Select value={mode} onValueChange={(value: string) => setMode(value as CredentialMode)}>
            <SelectTrigger id="source-credential-mode" aria-label={t('sources.config.mode')} data-testid="sources-config-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MODE_LABEL) as CredentialMode[]).map((value) => (
                <SelectItem key={value} value={value}>{t(MODE_LABEL[value])}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label={t('sources.config.credential')}
          hint={t('sources.config.credential.hint')}
          htmlFor="source-credential"
          error={credentialError}
        >
          {/*
            Deliberately NOT type="password", and deliberately not pre-filled.
            - Not a password field: this input never receives a secret, and dressing it as one
              would invite an operator to paste the token the validator then refuses.
            - Never pre-filled: an existing credential is a reference the platform holds, and
              echoing even a reference back into an editable field is how a stored value ends
              up in a form post. The masked hint below is read-only text.
          */}
          <Input
            id="source-credential"
            type="text"
            value={credential}
            autoComplete="off"
            spellCheck={false}
            placeholder={t(MODE_PLACEHOLDER[mode])}
            aria-invalid={credentialError ? true : undefined}
            onBlur={() => setTouched(true)}
            onChange={(event) => setCredential(event.target.value)}
            data-testid="sources-config-credential"
          />
        </Field>

        {/* What the platform already holds for this connector, if anything: a masked hint, never
            a value and never editable. No endpoint in this build returns one, so it reads as
            "none recorded" rather than inventing a placeholder. */}
        <ul className="detail-list">
          <li>
            <span>{t('sources.config.existing')}</span>
            <span className="mono small" data-testid="sources-config-existing">
              {maskReference(null) ?? t('sources.config.existing.none')}
            </span>
          </li>
        </ul>

        <div className="ow-source-actions">
          <Button type="button" variant="secondary" onClick={onClose} data-testid="sources-config-close">
            {t('action.close')}
          </Button>
          {/*
            Permanently disabled, with the reason in the tooltip and in the notice above: there
            is no endpoint behind it. An enabled button that did nothing would be worse than an
            absent one, and an absent one would hide that the rest of the form is real.
          */}
          <Button
            type="submit"
            disabled
            title={t('sources.config.absent.detail')}
            data-testid="sources-config-save"
          >
            <Icon name="save" size={15} /> {t('sources.config.save')}
          </Button>
        </div>

        {/* The payload the form would send once that endpoint exists. Printed so the shape is
            reviewable now: a reference, never a value. */}
        {complete ? (
          <section className="ow-source-preview" data-testid="sources-config-preview">
            <h3 className="ow-source-subhead">{t('sources.config.preview')}</h3>
            <p className="ow-source-note">{t('sources.config.preview.detail')}</p>
            <ul className="detail-list">
              <li><span>{t('sources.config.endpoint')}</span><span className="mono small">{endpoint.trim()}</span></li>
              <li>
                <span>{t('sources.config.credentialField')}</span>
                <span className="mono small">
                  {mode === 'secretRef' ? 'credentialRef' : 'credentialEnv'}: {result.ok ? result.value : ''}
                </span>
              </li>
            </ul>
          </section>
        ) : null}
      </form>
    </div>
  );
}

/** An absolute http(s) URL. A connector endpoint is a network target, so the scheme matters. */
function isHttpUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
