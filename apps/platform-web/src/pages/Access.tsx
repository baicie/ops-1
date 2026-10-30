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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { CopyButton, EmptyState, TimeAgo, useToast } from '../components/Ui';
import { AsyncBoundary } from '../components/app/async-boundary';
import { ConfirmAction } from '../components/app/confirm-action';
import { PageHeader } from '../components/app/page-header';
import { NoData } from '../components/app/status-indicator';
import { STATUS_MAP, badgeVariantForTone, glyphForTone } from '../components/status-tone';
import { shortDigest } from '../format';
import { useI18n, useT } from '../i18n';
import { cn } from '../lib/utils';
import { ABSENT_STATE, verifiedWriteDetail, verifiedWriteFailure, verifyAfterWrite } from '../lib/verify-after-write';
import {
  describePublisherTrust,
  describeUserRole,
  describeUserState,
  publisherTrustedLanded,
  userCreatedLanded,
  userStateLanded,
} from '../lib/verified-writes';
import { IdentityCell, RowActions, StackCell, StatusPill, cardActionCell, cardCellClass, copyIdAction, formatIdentity, rankCardFacts, stackBody, stackHead, stackRow, stackTable, type RowAction } from './table-kit';

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
  const { locale } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = usePolling(() => api.get<Publisher[]>('/api/v1/publishers'), 0);
  const { data: users, error: usersError, loading: usersLoading, reload: reloadUsers } = usePolling<ManagedUser[]>(
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
  /** The account whose enabled/disabled state a confirmation is open for, and the target state. */
  const [userTarget, setUserTarget] = useState<{ account: ManagedUser; disabled: boolean } | null>(null);
  const nameFieldId = useId();
  const emailFieldId = useId();
  const passwordFieldId = useId();
  const roleFieldId = useId();
  const publisherFieldId = useId();
  const publicKeyFieldId = useId();
  const noteFieldId = useId();

  /** The account list is the only route that answers "who exists": there is no GET /users/{id}. */
  const readUsers = () => api.get<ManagedUser[]>('/api/v1/users');

  /**
   * table-spec §2.1: the fingerprint is this row's identifier, and copying it is the first thing
   * the row menu offers - a 67-character key cannot be transcribed by eye. Revoking stays one
   * confirmation away and is only offered while the trust can still be withdrawn.
   */
  function publisherActions(publisher: Publisher): RowAction[] {
    const actions: RowAction[] = [copyIdAction(publisher.fingerprint, t('table.copyIdentifier'))];
    if (user?.role === 'admin' && publisher.trustState === 'TRUSTED') {
      actions.push({ id: 'revoke', label: t('action.revoke'), icon: 'trash', danger: true, divider: true, onSelect: () => setRevoke(publisher.publisherId) });
    }
    return actions;
  }

  /** table-spec §2.5: the three facts the 390 card keeps, ranked by §2.2's distinct ratio. */
  const publisherCardFacts = rankCardFacts({
    fingerprint: (data || []).map((publisher) => shortDigest(publisher.fingerprint, 20)),
    trust: (data || []).map((publisher) => publisher.trustState),
    note: (data || []).map((publisher) => publisher.note || ''),
  });

  async function createUser() {
    setUserBusy(true);
    setUserError(null);
    try {
      // A created account is not proven by the POST's 201: the list has to carry it, with the
      // role that was requested. An account created as admin when operator was asked is a lie
      // the old 201 toast told in full confidence.
      const result = await verifyAfterWrite<ManagedUser[]>({
        write: () => api.post('/api/v1/users', { email: newEmail, displayName: newName, password: newPassword, role: newRole }),
        read: readUsers,
        expected: (users) => userCreatedLanded(users, newEmail, newRole),
        describe: (users) => describeUserRole(users, newEmail),
      });
      const failure = verifiedWriteFailure(result, t);
      await reloadUsers();
      if (failure) throw failure;
      toast.push({ tone: 'ok', title: t('access.toast.userCreated'), detail: t('access.toast.userCreated.detail', { email: newEmail, role: newRole }) });
      setUserOpen(false); setNewEmail(''); setNewName(''); setNewPassword(''); setNewRole('viewer');
    } catch (cause: any) {
      setUserError(cause.message);
    } finally { setUserBusy(false); }
  }

  /**
   * Enabling or disabling a user revokes their sessions on the next request, so it is a
   * privilege change: it goes through ConfirmAction and only a server answer ends the dialog.
   */
  async function applyUserState(target: { account: ManagedUser; disabled: boolean }) {
    // The PATCH is a request. The list is the truth, and it is what the row above prints: only a
    // row that reports `disabled` as asked proves the account really lost or regained access.
    const result = await verifyAfterWrite<ManagedUser[]>({
      write: () => api.patch(`/api/v1/users/${target.account.id}`, { disabled: target.disabled }),
      read: readUsers,
      expected: (users) => userStateLanded(users, target.account.id, target.disabled),
      describe: (users) => describeUserState(users, target.account.id),
    });
    const failure = verifiedWriteFailure(result, t);
    await reloadUsers();
    // ConfirmAction keeps the dialog (and its retry) open when the state did not move.
    if (failure) throw failure;
    toast.push({
      tone: 'ok',
      title: target.disabled ? t('access.toast.userDisabled') : t('access.toast.userEnabled'),
      detail: verifiedWriteDetail(result, t),
    });
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
      // Trusting a key is proven by the publisher list: a POST that answered 201 while the
      // publisher stayed untrusted would let unsigned bundles through on the strength of a toast.
      const result = await verifyAfterWrite<Publisher[]>({
        write: () => api.post('/api/v1/publishers', { publisherId, publicKeyHex: publicKey.trim(), note }),
        read: () => api.get<Publisher[]>('/api/v1/publishers'),
        expected: (publishers) => publisherTrustedLanded(publishers, publisherId),
        describe: (publishers) => describePublisherTrust(publishers, publisherId),
      });
      const failure = verifiedWriteFailure(result, t);
      await reload();
      if (failure) throw failure;
      toast.push({ tone: 'ok', title: t('access.toast.publisherTrusted'), detail: publisherId + ' · ' + verifiedWriteDetail(result, t) });
      setAddOpen(false);
      setPublisherId(''); setPublicKey(''); setNote('');
    } catch (cause: any) {
      toast.push({ tone: 'danger', title: t('access.toast.addPublisherFailed'), detail: cause.message });
    } finally { setBusy(false); }
  }

  /** Revoking trust is verified by what the publisher list says next, not by the DELETE status. */
  async function revokePublisher() {
    if (!revoke) return;
    const publisherId = revoke;
    const result = await verifyAfterWrite<Publisher[]>({
      write: () => api.del(`/api/v1/publishers/${encodeURIComponent(publisherId)}`),
      read: () => api.get<Publisher[]>('/api/v1/publishers'),
      expected: (publishers) => !publishers.some((item) => item.publisherId === publisherId && item.trustState === 'TRUSTED'),
      describe: (publishers) => publishers.find((item) => item.publisherId === publisherId)?.trustState || ABSENT_STATE,
      absentIsExpected: true,
    });
    const failure = verifiedWriteFailure(result, t);
    await reload();
    // ConfirmAction keeps the dialog (and its retry) open when the trust state did not move.
    if (failure) throw failure;
    toast.push({ tone: 'ok', title: t('access.toast.publisherRevoked'), detail: t('access.toast.publisherRevoked.detail') + ' ' + verifiedWriteDetail(result, t) });
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
          <AsyncBoundary
            loading={usersLoading}
            error={usersError}
            hasData={Boolean(users)}
            isEmpty={Boolean(users && users.length === 0)}
            emptyState={<EmptyState icon="access" title={t('access.users.empty')} />}
            onRetry={() => void reloadUsers()}
            skeletonRows={3}
          >
            <Table className={stackTable}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.user')}</TableHead>
                  <TableHead>{t('table.role')}</TableHead>
                  <TableHead>{t('table.status')}</TableHead>
                  <TableHead>{t('table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {(users || []).map((item) => (
                  <TableRow key={item.id} className={stackRow} data-user={item.id}>
                    {/* §2.1: the row opens with one identity in human language; the email is its
                        qualifier line. It used to be a labelled cell, which also made the user card
                        carry four facts where §2.5 allows three. */}
                    <IdentityCell label={t('table.user')} identity={formatIdentity({ name: item.displayName, id: item.id, at: item.createdAt, locale, rowsOnPage: (users || []).length })} cardFact>
                      <span>{item.email}</span>
                    </IdentityCell>
                    <StackCell label={t('table.role')}><span className="role-pill">{item.role}</span></StackCell>
                    <StackCell label={t('table.status')}><UserStatusPill disabled={item.disabled} /></StackCell>
                    <StackCell label={t('table.actions')}>{item.id !== user?.id && <Button size="sm" variant={item.disabled ? 'default' : 'destructive'} onClick={() => setUserTarget({ account: item, disabled: !item.disabled })}>{item.disabled ? t('action.enable') : t('action.disable')}</Button>}</StackCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </AsyncBoundary>
        </section>
      )}
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('access.publishers.title')}</h2><p>{t('access.publishers.description')}</p></div></div>
        <AsyncBoundary
          loading={loading}
          error={error}
          hasData={Boolean(data)}
          isEmpty={Boolean(data && data.length === 0)}
          emptyState={<EmptyState icon="key" title={t('access.publishers.empty')} action={user?.role === 'admin' ? <Button variant="secondary" onClick={() => setAddOpen(true)}><Icon name="key" size={15} /> {t('access.action.addPublisher')}</Button> : undefined} />}
          onRetry={() => void reload()}
          skeletonRows={3}
        >
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.publisher')}</TableHead>
                <TableHead>{t('table.fingerprint')}</TableHead>
                <TableHead>{t('table.trust')}</TableHead>
                <TableHead>{t('table.note')}</TableHead>
                <TableHead aria-label={t('table.actions')} />
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {(data || []).map((publisher) => (
                <TableRow key={publisher.publisherId} className={stackRow}>
                  <IdentityCell label={t('table.publisher')} identity={formatIdentity({ name: publisher.publisherId, id: publisher.fingerprint, at: publisher.createdAt, locale, rowsOnPage: (data || []).length })} cardFact />
                  <StackCell label={t('table.fingerprint')} className={cardCellClass(publisherCardFacts.includes('fingerprint'))}><span className="mono text-sm">{shortDigest(publisher.fingerprint, 20)}</span><CopyButton value={publisher.fingerprint} /></StackCell>
                  <StackCell label={t('table.trust')} className={cardCellClass(publisherCardFacts.includes('trust'))}><StatusPill status={publisher.trustState} /></StackCell>
                  {/* An absent note is a missing record, not an empty one: the reserved token, never a dash. */}
                  <StackCell label={t('table.note')} className={cardCellClass(publisherCardFacts.includes('note'))}>{publisher.note ? <span className="text-sm text-muted-foreground">{publisher.note}</span> : <NoData detail={t('ui.noData.detail')} />}</StackCell>
                  {/* §2.5: a labelled cell IS a fact, so the verb menu is a plain cell - and at 390 it
                      rides the identity line instead of spending a line of the card. */}
                  <TableCell className={cn('w-8 text-right text-muted-foreground', cardActionCell)}>
                    <RowActions label={t('access.action.menu', { name: publisher.publisherId })} actions={publisherActions(publisher)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </AsyncBoundary>
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
      <ConfirmAction
        open={Boolean(userTarget)}
        title={userTarget?.disabled
          ? t('access.confirmDisable.title', { name: userTarget.account.displayName })
          : t('access.confirmEnable.title', { name: userTarget?.account.displayName ?? '' })}
        description={userTarget?.disabled ? t('access.confirmDisable.description') : t('access.confirmEnable.description')}
        confirmLabel={userTarget?.disabled ? t('access.confirmDisable.confirm') : t('access.confirmEnable.confirm')}
        danger={Boolean(userTarget?.disabled)}
        onConfirm={() => applyUserState(userTarget!)}
        onClose={() => setUserTarget(null)}
      />
      <ConfirmAction
        open={Boolean(revoke)}
        title={t('access.confirmRevoke.title', { id: revoke ?? '' })}
        description={t('access.confirmRevoke.description')}
        confirmLabel={t('access.confirmRevoke.confirm')}
        onConfirm={revokePublisher}
        onClose={() => setRevoke(null)}
      />
    </div>
  );
}
