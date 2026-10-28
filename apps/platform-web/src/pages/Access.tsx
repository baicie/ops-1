import React, { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { usePolling } from '../hooks';
import type { Publisher } from '../types';
import { Icon } from '../components/Icons';
import { ConfirmDialog, CopyButton, ErrorState, Field, Modal, PageHeader, Skeleton, StatusBadge, TimeAgo, useToast } from '../components/Ui';
import { shortDigest } from '../format';
import { useT } from '../i18n';

type ManagedUser = { id: string; email: string; displayName: string; role: string; disabled: boolean; createdAt: string };

export function AccessPage() {
  const t = useT();
  const { user } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = usePolling(() => api.get<Publisher[]>('/api/v1/publishers'), 0);
  const { data: users, reload: reloadUsers } = usePolling<ManagedUser[]>(
    () => (user?.role === 'admin' ? api.get<ManagedUser[]>('/api/v1/users') : Promise.resolve([])),
    0,
  );
  const [userOpen, setUserOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('viewer');
  const [userBusy, setUserBusy] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);

  async function createUser() {
    setUserBusy(true);
    setUserError(null);
    try {
      await api.post('/api/v1/users', { email: newEmail, displayName: newName, password: newPassword, role: newRole });
      toast.push({ tone: 'ok', title: t('access.toast.userCreated'), detail: t('access.toast.userCreated.detail', { email: newEmail, role: newRole }) });
      setUserOpen(false); setNewEmail(''); setNewName(''); setNewPassword(''); setNewRole('viewer');
      await reloadUsers();
    } catch (cause: any) {
      setUserError(cause.message);
    } finally { setUserBusy(false); }
  }

  async function toggleUser(target: ManagedUser) {
    try {
      await api.patch(`/api/v1/users/${target.id}`, { disabled: !target.disabled });
      await reloadUsers();
      toast.push({ tone: 'ok', title: target.disabled ? t('access.toast.userEnabled') : t('access.toast.userDisabled') });
    } catch (cause: any) {
      toast.push({ tone: 'danger', title: t('access.toast.userUpdateFailed'), detail: cause.message });
    }
  }
  const [addOpen, setAddOpen] = useState(false);
  const [publisherId, setPublisherId] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState<string | null>(null);

  async function addPublisher() {
    setBusy(true);
    try {
      await api.post('/api/v1/publishers', { publisherId, publicKeyHex: publicKey.trim(), note });
      toast.push({ tone: 'ok', title: t('access.toast.publisherTrusted'), detail: publisherId });
      setAddOpen(false);
      setPublisherId(''); setPublicKey(''); setNote('');
      await reload();
    } catch (cause: any) {
      toast.push({ tone: 'danger', title: t('access.toast.addPublisherFailed'), detail: cause.message });
    } finally { setBusy(false); }
  }

  async function revokePublisher() {
    if (!revoke) return;
    setBusy(true);
    try {
      await api.del(`/api/v1/publishers/${encodeURIComponent(revoke)}`);
      toast.push({ tone: 'ok', title: t('access.toast.publisherRevoked'), detail: t('access.toast.publisherRevoked.detail') });
      setRevoke(null);
      await reload();
    } catch (cause: any) {
      toast.push({ tone: 'danger', title: t('common.revokeFailed'), detail: cause.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('access.title')}
        description={t('access.description')}
        actions={user?.role === 'admin' ? <button className="btn btn-primary" onClick={() => setAddOpen(true)}><Icon name="key" size={15} /> {t('access.action.addPublisher')}</button> : undefined}
      />
      <div className="summary-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>{t('access.roles.title')}</h2><p>{t('access.roles.description')}</p></div></div>
          <div className="role-list">
            <div><span className="role-pill">Viewer</span><p>{t('access.roles.viewer.description')}</p></div>
            <div><span className="role-pill">Operator</span><p>{t('access.roles.operator.description')}</p></div>
            <div><span className="role-pill">Admin</span><p>{t('access.roles.admin.description')}</p></div>
          </div>
          <div className="callout"><Icon name="access" size={16} /><p>{t('access.sessionNote')}</p></div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>{t('access.trust.title')}</h2><p>{t('access.trust.description')}</p></div></div>
          <ul className="trust-list">
            <li><Icon name="access" size={16} /><div><strong>{t('access.trust.userSession')}</strong><span>{t('access.trust.userSession.detail')}</span></div></li>
            <li><Icon name="server" size={16} /><div><strong>{t('access.trust.nodeIdentity')}</strong><span>{t('access.trust.nodeIdentity.detail')}</span></div></li>
            <li><Icon name="key" size={16} /><div><strong>{t('access.trust.publisherKey')}</strong><span>{t('access.trust.publisherKey.detail')}</span></div></li>
            <li><Icon name="box" size={16} /><div><strong>{t('access.trust.workload')}</strong><span>{t('access.trust.workload.detail')}</span></div></li>
          </ul>
        </section>
      </div>
      {user?.role === 'admin' && (
        <section className="panel table-panel">
          <div className="panel-head"><div><h2>{t('access.users.title')}</h2><p>{t('access.users.description')}</p></div><button className="btn btn-secondary" onClick={() => { setUserError(null); setUserOpen(true); }}><Icon name="plus" size={15} /> {t('access.users.add')}</button></div>
          {!users?.length ? <p className="muted pad">{t('access.users.empty')}</p> : (
            <table className="data-table"><thead><tr><th>{t('table.user')}</th><th>{t('table.role')}</th><th>{t('table.status')}</th><th>{t('table.created')}</th><th>{t('table.actions')}</th></tr></thead><tbody>
              {users.map((item) => <tr key={item.id}><td data-label={t('table.user')}><strong>{item.displayName}</strong><div className="muted small">{item.email}</div></td><td data-label={t('table.role')}><span className="role-pill">{item.role}</span></td><td data-label={t('table.status')}><StatusBadge status={item.disabled ? 'DISABLED' : 'READY'} label={item.disabled ? t('status.disabled') : t('status.active')} /></td><td data-label={t('table.created')}><TimeAgo value={item.createdAt} /></td><td data-label={t('table.actions')}>{item.id !== user?.id && <button className="btn btn-small" onClick={() => void toggleUser(item)}>{item.disabled ? t('action.enable') : t('action.disable')}</button>}</td></tr>)}
            </tbody></table>
          )}
        </section>
      )}
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('access.publishers.title')}</h2><p>{t('access.publishers.description')}</p></div></div>
        {loading && !data ? <Skeleton rows={3} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : !data?.length ? <p className="muted pad">{t('access.publishers.empty')}</p> : (
          <table className="data-table"><thead><tr><th>{t('table.publisher')}</th><th>{t('table.fingerprint')}</th><th>{t('table.trust')}</th><th>{t('table.added')}</th><th>{t('table.note')}</th>{user?.role === 'admin' && <th>{t('table.actions')}</th>}</tr></thead><tbody>
            {data.map((publisher) => <tr key={publisher.publisherId}><td data-label={t('table.publisher')}><strong>{publisher.publisherId}</strong></td><td data-label={t('table.fingerprint')}><span className="mono small">{shortDigest(publisher.fingerprint, 20)}</span><CopyButton value={publisher.fingerprint} /></td><td data-label={t('table.trust')}><StatusBadge status={publisher.trustState} /></td><td data-label={t('table.added')}><TimeAgo value={publisher.createdAt} /></td><td data-label={t('table.note')}><span className="muted small">{publisher.note || '—'}</span></td>{user?.role === 'admin' && <td data-label={t('table.actions')}>{publisher.trustState === 'TRUSTED' && <button className="btn btn-small btn-danger" onClick={() => setRevoke(publisher.publisherId)}>{t('action.revoke')}</button>}</td>}</tr>)}
          </tbody></table>
        )}
      </section>
      <Modal open={userOpen} onClose={() => setUserOpen(false)} title={t('access.modal.addUser.title')} footer={<><button className="btn btn-secondary" onClick={() => setUserOpen(false)}>{t('action.cancel')}</button><button className="btn btn-primary" onClick={() => void createUser()} disabled={userBusy || !newEmail || !newName || newPassword.length < 10}>{userBusy ? t('access.modal.addUser.creating') : t('access.modal.addUser.submit')}</button></>}>
        <div className="form-stack">
          {userError && <div className="inline-error"><Icon name="warning" size={16} /> {userError}</div>}
          <div className="form-grid">
            <Field label={t('access.field.displayName')}><input value={newName} onChange={(event) => setNewName(event.target.value)} /></Field>
            <Field label={t('access.field.email')}><input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} /></Field>
          </div>
          <div className="form-grid">
            <Field label={t('access.field.temporaryPassword')} hint={t('access.field.temporaryPassword.hint')}><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></Field>
            <Field label={t('access.field.role')}><select value={newRole} onChange={(event) => setNewRole(event.target.value)}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></Field>
          </div>
          <div className="callout"><Icon name="access" size={16} /><p>{t('access.usersNote')}</p></div>
        </div>
      </Modal>
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('access.modal.trustPublisher.title')} footer={<><button className="btn btn-secondary" onClick={() => setAddOpen(false)}>{t('action.cancel')}</button><button className="btn btn-primary" onClick={() => void addPublisher()} disabled={busy || !publisherId || !publicKey}>{busy ? t('access.modal.trustPublisher.adding') : t('access.modal.trustPublisher.submit')}</button></>}>
        <div className="form-stack">
          <Field label={t('access.field.publisherId')} hint={t('access.field.publisherId.hint')}><input value={publisherId} onChange={(event) => setPublisherId(event.target.value)} placeholder="trusted-team" /></Field>
          <Field label={t('access.field.publicKey')} hint={t('access.field.publicKey.hint')}><input value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder={t('access.field.publicKey.placeholder')} className="mono" /></Field>
          <Field label={t('table.note')}><input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('access.field.note.placeholder')} /></Field>
          <div className="callout"><Icon name="alert" size={16} /><p>{t('access.trustNote')}</p></div>
        </div>
      </Modal>
      <ConfirmDialog open={Boolean(revoke)} title={t('access.confirmRevoke.title', { id: revoke ?? '' })} description={t('access.confirmRevoke.description')} confirmLabel={t('access.confirmRevoke.confirm')} danger busy={busy} onConfirm={() => void revokePublisher()} onClose={() => setRevoke(null)} />
    </div>
  );
}
