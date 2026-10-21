import React, { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { usePolling } from '../hooks';
import type { Publisher } from '../types';
import { Icon } from '../components/Icons';
import { ConfirmDialog, CopyButton, ErrorState, Field, Modal, PageHeader, Skeleton, StatusBadge, TimeAgo, useToast } from '../components/Ui';
import { shortDigest } from '../format';

type ManagedUser = { id: string; email: string; displayName: string; role: string; disabled: boolean; createdAt: string };

export function AccessPage() {
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
      toast.push({ tone: 'ok', title: 'User created', detail: `${newEmail} can now sign in as ${newRole}` });
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
      toast.push({ tone: 'ok', title: target.disabled ? 'User enabled' : 'User disabled' });
    } catch (cause: any) {
      toast.push({ tone: 'danger', title: 'User update failed', detail: cause.message });
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
      toast.push({ tone: 'ok', title: 'Publisher trusted', detail: publisherId });
      setAddOpen(false);
      setPublisherId(''); setPublicKey(''); setNote('');
      await reload();
    } catch (cause: any) {
      toast.push({ tone: 'danger', title: 'Could not add publisher', detail: cause.message });
    } finally { setBusy(false); }
  }

  async function revokePublisher() {
    if (!revoke) return;
    setBusy(true);
    try {
      await api.del(`/api/v1/publishers/${encodeURIComponent(revoke)}`);
      toast.push({ tone: 'ok', title: 'Publisher revoked', detail: 'New installs from this publisher are rejected.' });
      setRevoke(null);
      await reload();
    } catch (cause: any) {
      toast.push({ tone: 'danger', title: 'Revoke failed', detail: cause.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Access & trust"
        description="Users, node identity and publisher keys are separate trust domains. One never substitutes for another."
        actions={user?.role === 'admin' ? <button className="btn btn-primary" onClick={() => setAddOpen(true)}><Icon name="key" size={15} /> Add publisher</button> : undefined}
      />
      <div className="summary-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>User roles</h2><p>Single workspace RBAC for 0.0.1. Server-side checks always apply.</p></div></div>
          <div className="role-list">
            <div><span className="role-pill">Viewer</span><p>Read overview, plugins, nodes and activity. Cannot operate or read instance logs.</p></div>
            <div><span className="role-pill">Operator</span><p>Install, deploy, activate, disable, read logs. Cannot manage publisher trust or revoke nodes.</p></div>
            <div><span className="role-pill">Admin</span><p>Everything, including publisher keys, enrollment tokens, diagnostics and revocation.</p></div>
          </div>
          <div className="callout"><Icon name="access" size={16} /><p>Your session is a user session. It cannot be replayed as a Node credential or Workload Identity.</p></div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Trust boundaries</h2><p>Each credential has a single purpose.</p></div></div>
          <ul className="trust-list">
            <li><Icon name="access" size={16} /><div><strong>User session</strong><span>HttpOnly cookie, CSRF-protected, role-scoped.</span></div></li>
            <li><Icon name="server" size={16} /><div><strong>Node identity</strong><span>One-time enrollment, hashed control credential, revocable.</span></div></li>
            <li><Icon name="key" size={16} /><div><strong>Publisher key</strong><span>Ed25519 trust root for signed bundle manifests and payloads.</span></div></li>
            <li><Icon name="box" size={16} /><div><strong>Workload</strong><span>Instance identity minted for Gateway routes; no raw session token.</span></div></li>
          </ul>
        </section>
      </div>
      {user?.role === 'admin' && (
        <section className="panel table-panel">
          <div className="panel-head"><div><h2>Workspace users</h2><p>Roles are enforced server-side on every request. Disabling a user revokes their sessions immediately.</p></div><button className="btn btn-secondary" onClick={() => { setUserError(null); setUserOpen(true); }}><Icon name="plus" size={15} /> Add user</button></div>
          {!users?.length ? <p className="muted pad">No user records available.</p> : (
            <table className="data-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>
              {users.map((item) => <tr key={item.id}><td data-label="User"><strong>{item.displayName}</strong><div className="muted small">{item.email}</div></td><td data-label="Role"><span className="role-pill">{item.role}</span></td><td data-label="Status"><StatusBadge status={item.disabled ? 'DISABLED' : 'READY'} label={item.disabled ? 'Disabled' : 'Active'} /></td><td data-label="Created"><TimeAgo value={item.createdAt} /></td><td data-label="Actions">{item.id !== user?.id && <button className="btn btn-small" onClick={() => void toggleUser(item)}>{item.disabled ? 'Enable' : 'Disable'}</button>}</td></tr>)}
            </tbody></table>
          )}
        </section>
      )}
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>Trusted publishers</h2><p>Publisher revocation blocks new installs and preserves audit history.</p></div></div>
        {loading && !data ? <Skeleton rows={3} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : !data?.length ? <p className="muted pad">No publishers in the trust store.</p> : (
          <table className="data-table"><thead><tr><th>Publisher</th><th>Fingerprint</th><th>Trust</th><th>Added</th><th>Note</th>{user?.role === 'admin' && <th>Actions</th>}</tr></thead><tbody>
            {data.map((publisher) => <tr key={publisher.publisherId}><td data-label="Publisher"><strong>{publisher.publisherId}</strong></td><td data-label="Fingerprint"><span className="mono small">{shortDigest(publisher.fingerprint, 20)}</span><CopyButton value={publisher.fingerprint} /></td><td data-label="Trust"><StatusBadge status={publisher.trustState} /></td><td data-label="Added"><TimeAgo value={publisher.createdAt} /></td><td data-label="Note"><span className="muted small">{publisher.note || '—'}</span></td>{user?.role === 'admin' && <td data-label="Actions">{publisher.trustState === 'TRUSTED' && <button className="btn btn-small btn-danger" onClick={() => setRevoke(publisher.publisherId)}>Revoke</button>}</td>}</tr>)}
          </tbody></table>
        )}
      </section>
      <Modal open={userOpen} onClose={() => setUserOpen(false)} title="Add workspace user" footer={<><button className="btn btn-secondary" onClick={() => setUserOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={() => void createUser()} disabled={userBusy || !newEmail || !newName || newPassword.length < 10}>{userBusy ? 'Creating…' : 'Create user'}</button></>}>
        <div className="form-stack">
          {userError && <div className="inline-error"><Icon name="warning" size={16} /> {userError}</div>}
          <div className="form-grid">
            <Field label="Display name"><input value={newName} onChange={(event) => setNewName(event.target.value)} /></Field>
            <Field label="Email"><input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} /></Field>
          </div>
          <div className="form-grid">
            <Field label="Temporary password" hint="At least 10 characters"><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></Field>
            <Field label="Role"><select value={newRole} onChange={(event) => setNewRole(event.target.value)}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></Field>
          </div>
          <div className="callout"><Icon name="access" size={16} /><p>Users are not tenants. 0.0.1 is a single-workspace internal environment; production multi-tenant isolation is explicitly out of scope.</p></div>
        </div>
      </Modal>
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Trust a publisher" footer={<><button className="btn btn-secondary" onClick={() => setAddOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={() => void addPublisher()} disabled={busy || !publisherId || !publicKey}>{busy ? 'Adding…' : 'Trust publisher'}</button></>}>
        <div className="form-stack">
          <Field label="Publisher ID" hint="Must match the publisher field in signed manifests"><input value={publisherId} onChange={(event) => setPublisherId(event.target.value)} placeholder="trusted-team" /></Field>
          <Field label="Ed25519 public key" hint="64 hex characters; private keys never enter the Kernel"><input value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder="64 lowercase hex characters" className="mono" /></Field>
          <Field label="Note"><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Owner, rotation or approval context" /></Field>
          <div className="callout"><Icon name="alert" size={16} /><p>Trusting a key is a security decision. The platform verifies signatures, not the publisher's intent or code quality.</p></div>
        </div>
      </Modal>
      <ConfirmDialog open={Boolean(revoke)} title={`Revoke ${revoke}?`} description="New packages signed by this publisher will be rejected. Existing installed versions remain auditable; activation policy may still block them." confirmLabel="Revoke publisher" danger busy={busy} onConfirm={() => void revokePublisher()} onClose={() => setRevoke(null)} />
    </div>
  );
}
