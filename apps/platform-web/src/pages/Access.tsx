import React, { useId, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { usePolling } from '../hooks';
import type { Publisher } from '../types';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { CopyButton, ErrorState, PageHeader, Skeleton, TimeAgo, useToast } from '../components/Ui';
import { STATUS_MAP, badgeVariantForTone, glyphForTone } from '../components/status-tone';
import { shortDigest } from '../format';
import { useT } from '../i18n';
import { StackCell, StatusPill, stackBody, stackHead, stackRow, stackTable } from './table-kit';

type ManagedUser = { id: string; email: string; displayName: string; role: string; disabled: boolean; createdAt: string };

/**
 * A user's enabled/disabled state is not a lifecycle code: this page has always printed its own
 * copy for it (the `status.active`/`status.disabled` catalog keys), where StatusPill would print
 * STATUS_MAP's READY label. The tone still comes from the single mapping in status-tone.ts, so
 * the pill cannot drift from every other status in the shell.
 */
function UserStatusPill({ disabled }: { disabled: boolean }) {
  const t = useT();
  const code = disabled ? 'DISABLED' : 'READY';
  const tone = STATUS_MAP[code].tone;
  return (
    <Badge variant={badgeVariantForTone(tone)} data-status={code}>
      <Icon name={glyphForTone(tone)} size={12} />
      {disabled ? t('status.disabled') : t('status.active')}
    </Badge>
  );
}

/** Label + control + hint, the shadcn replacement for the shared Field wrapper. */
function FormField({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
    </div>
  );
}

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
  const nameFieldId = useId();
  const emailFieldId = useId();
  const passwordFieldId = useId();
  const roleFieldId = useId();
  const publisherFieldId = useId();
  const publicKeyFieldId = useId();
  const noteFieldId = useId();

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
        actions={user?.role === 'admin' ? <Button onClick={() => setAddOpen(true)}><Icon name="key" size={15} /> {t('access.action.addPublisher')}</Button> : undefined}
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
          <div className="panel-head"><div><h2>{t('access.users.title')}</h2><p>{t('access.users.description')}</p></div><Button variant="secondary" onClick={() => { setUserError(null); setUserOpen(true); }}><Icon name="plus" size={15} /> {t('access.users.add')}</Button></div>
          {!users?.length ? <p className="muted pad">{t('access.users.empty')}</p> : (
            <Table className={stackTable}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.user')}</TableHead>
                  <TableHead>{t('table.role')}</TableHead>
                  <TableHead>{t('table.status')}</TableHead>
                  <TableHead>{t('table.created')}</TableHead>
                  <TableHead>{t('table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {users.map((item) => (
                  <TableRow key={item.id} className={stackRow}>
                    <StackCell label={t('table.user')}><strong>{item.displayName}</strong><div className="text-sm text-muted-foreground">{item.email}</div></StackCell>
                    <StackCell label={t('table.role')}><span className="role-pill">{item.role}</span></StackCell>
                    <StackCell label={t('table.status')}><UserStatusPill disabled={item.disabled} /></StackCell>
                    <StackCell label={t('table.created')}><TimeAgo value={item.createdAt} /></StackCell>
                    <StackCell label={t('table.actions')}>{item.id !== user?.id && <Button size="sm" onClick={() => void toggleUser(item)}>{item.disabled ? t('action.enable') : t('action.disable')}</Button>}</StackCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      )}
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('access.publishers.title')}</h2><p>{t('access.publishers.description')}</p></div></div>
        {loading && !data ? <Skeleton rows={3} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : !data?.length ? <p className="muted pad">{t('access.publishers.empty')}</p> : (
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.publisher')}</TableHead>
                <TableHead>{t('table.fingerprint')}</TableHead>
                <TableHead>{t('table.trust')}</TableHead>
                <TableHead>{t('table.added')}</TableHead>
                <TableHead>{t('table.note')}</TableHead>
                {user?.role === 'admin' && <TableHead>{t('table.actions')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {data.map((publisher) => (
                <TableRow key={publisher.publisherId} className={stackRow}>
                  <StackCell label={t('table.publisher')}><strong>{publisher.publisherId}</strong></StackCell>
                  <StackCell label={t('table.fingerprint')}><span className="mono text-sm">{shortDigest(publisher.fingerprint, 20)}</span><CopyButton value={publisher.fingerprint} /></StackCell>
                  <StackCell label={t('table.trust')}><StatusPill status={publisher.trustState} /></StackCell>
                  <StackCell label={t('table.added')}><TimeAgo value={publisher.createdAt} /></StackCell>
                  <StackCell label={t('table.note')}><span className="text-sm text-muted-foreground">{publisher.note || '—'}</span></StackCell>
                  {user?.role === 'admin' && <StackCell label={t('table.actions')}>{publisher.trustState === 'TRUSTED' && <Button size="sm" variant="destructive" onClick={() => setRevoke(publisher.publisherId)}>{t('action.revoke')}</Button>}</StackCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <Dialog open={userOpen} onOpenChange={setUserOpen}>
        <DialogContent closeLabel={t('aria.closeDialog')}>
          <DialogHeader><DialogTitle>{t('access.modal.addUser.title')}</DialogTitle></DialogHeader>
          <div className="form-stack">
            {userError && <div className="inline-error"><Icon name="warning" size={16} /> {userError}</div>}
            <div className="form-grid">
              <FormField label={t('access.field.displayName')} htmlFor={nameFieldId}><Input id={nameFieldId} value={newName} onChange={(event) => setNewName(event.target.value)} /></FormField>
              <FormField label={t('access.field.email')} htmlFor={emailFieldId}><Input id={emailFieldId} type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} /></FormField>
            </div>
            <div className="form-grid">
              <FormField label={t('access.field.temporaryPassword')} hint={t('access.field.temporaryPassword.hint')} htmlFor={passwordFieldId}><Input id={passwordFieldId} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></FormField>
              <FormField label={t('access.field.role')} htmlFor={roleFieldId}>
                <Select value={newRole} onValueChange={setNewRole}>
                  <SelectTrigger id={roleFieldId} aria-label={t('access.field.role')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">Viewer</SelectItem>
                    <SelectItem value="operator">Operator</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <div className="callout"><Icon name="access" size={16} /><p>{t('access.usersNote')}</p></div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setUserOpen(false)}>{t('action.cancel')}</Button>
            <Button onClick={() => void createUser()} disabled={userBusy || !newEmail || !newName || newPassword.length < 10}>{userBusy ? t('access.modal.addUser.creating') : t('access.modal.addUser.submit')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent closeLabel={t('aria.closeDialog')}>
          <DialogHeader><DialogTitle>{t('access.modal.trustPublisher.title')}</DialogTitle></DialogHeader>
          <div className="form-stack">
            <FormField label={t('access.field.publisherId')} hint={t('access.field.publisherId.hint')} htmlFor={publisherFieldId}><Input id={publisherFieldId} value={publisherId} onChange={(event) => setPublisherId(event.target.value)} placeholder="trusted-team" /></FormField>
            <FormField label={t('access.field.publicKey')} hint={t('access.field.publicKey.hint')} htmlFor={publicKeyFieldId}><Input id={publicKeyFieldId} value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder={t('access.field.publicKey.placeholder')} className="mono" /></FormField>
            <FormField label={t('table.note')} htmlFor={noteFieldId}><Input id={noteFieldId} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('access.field.note.placeholder')} /></FormField>
            <div className="callout"><Icon name="alert" size={16} /><p>{t('access.trustNote')}</p></div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setAddOpen(false)}>{t('action.cancel')}</Button>
            <Button onClick={() => void addPublisher()} disabled={busy || !publisherId || !publicKey}>{busy ? t('access.modal.trustPublisher.adding') : t('access.modal.trustPublisher.submit')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Replaces the shared ConfirmDialog: same testid, same copy, same disabled-while-busy footer. */}
      <Dialog open={Boolean(revoke)} onOpenChange={(open) => { if (!open) setRevoke(null); }}>
        <DialogContent closeLabel={t('aria.closeDialog')} data-testid="confirm-dialog" className="max-w-[480px]">
          <DialogHeader><DialogTitle>{t('access.confirmRevoke.title', { id: revoke ?? '' })}</DialogTitle></DialogHeader>
          <div className="text-[var(--ow-text-secondary)] leading-relaxed">{t('access.confirmRevoke.description')}</div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRevoke(null)} disabled={busy}>{t('action.cancel')}</Button>
            <Button variant="destructive" onClick={() => void revokePublisher()} disabled={busy}>{busy ? t('action.working') : t('access.confirmRevoke.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
