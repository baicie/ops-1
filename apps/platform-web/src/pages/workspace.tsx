import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { canEnterSurface, surfaceEntryPath } from '../surface';
import { EmptyState, KV, PageHeader } from '../components/Ui';
import { Icon } from '../components/Icons';
import { buttonVariants } from '../components/ui/button';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n';

/**
 * Business Workspace pages.
 *
 * Only `/app/home` carries content, and every fact on it comes from the session this
 * browser actually holds. The six capability pages are explicit statements of absence:
 * they name what is missing and what would have to be built. No sample incident, no
 * fabricated RCA, no placeholder trend - a business page that invents data is worse than
 * one that admits it has none.
 */

export type SurfaceCapability = 'incidents' | 'investigations' | 'observability' | 'resources' | 'sources' | 'reports';

export type SurfaceNavGroup = 'work' | 'discover';

interface CapabilityCopy {
  to: string;
  labelKey: MessageKey;
  missingKey: MessageKey;
  icon: string;
  /** Sidebar group; the shell derives its navigation from this registry. */
  navGroup: SurfaceNavGroup;
}

/** One registry behind the sidebar, the roadmap and the "not shipped" pages. */
export const SURFACE_CAPABILITIES: Record<SurfaceCapability, CapabilityCopy> = {
  incidents: { to: '/app/incidents', labelKey: 'workspace.nav.incidents', missingKey: 'workspace.notYet.incidents.missing', icon: 'alert', navGroup: 'work' },
  investigations: { to: '/app/investigations', labelKey: 'workspace.nav.investigations', missingKey: 'workspace.notYet.investigations.missing', icon: 'search', navGroup: 'work' },
  observability: { to: '/app/observability', labelKey: 'workspace.nav.observability', missingKey: 'workspace.notYet.observability.missing', icon: 'activity', navGroup: 'discover' },
  resources: { to: '/app/resources', labelKey: 'workspace.nav.resources', missingKey: 'workspace.notYet.resources.missing', icon: 'box', navGroup: 'discover' },
  sources: { to: '/app/sources', labelKey: 'workspace.nav.sources', missingKey: 'workspace.notYet.sources.missing', icon: 'upload', navGroup: 'discover' },
  reports: { to: '/app/reports', labelKey: 'workspace.nav.reports', missingKey: 'workspace.notYet.reports.missing', icon: 'file', navGroup: 'discover' },
};

export const SURFACE_CAPABILITY_ORDER: SurfaceCapability[] = ['incidents', 'investigations', 'observability', 'resources', 'sources', 'reports'];

/** `/app/home` - the signed-in user's own view; nothing here is inferred or sampled. */
export function WorkspaceHomePage() {
  const { t } = useI18n();
  const { user, access } = useAuth();
  const canReachAdmin = canEnterSurface(access, 'admin');

  return (
    <div className="page-stack" data-testid="workspace-home">
      <PageHeader
        eyebrow={t('workspace.home.eyebrow')}
        title={t('page.workspaceHome')}
        description={t('workspace.home.description')}
      />

      <section className="panel" aria-labelledby="workspace-home-account">
        <div className="panel-head">
          <div>
            <h2 id="workspace-home-account">{t('workspace.home.account.title')}</h2>
            <p>{t('workspace.home.account.description')}</p>
          </div>
        </div>
        <div className="kv-grid">
          <KV label={t('access.field.displayName')}>{user?.displayName ?? '-'}</KV>
          <KV label={t('login.field.email')} mono>{user?.email ?? '-'}</KV>
          <KV label={t('table.role')}>{user?.role ?? '-'}</KV>
          <KV label={t('common.capabilities')} mono>
            {access.capabilities.length > 0 ? access.capabilities.join(', ') : t('workspace.home.account.none')}
          </KV>
        </div>
      </section>

      <section className="panel" aria-labelledby="workspace-home-surface">
        <div className="panel-head">
          <div>
            <h2 id="workspace-home-surface">{t('workspace.home.surface.title')}</h2>
            <p>{t('workspace.home.surface.description')}</p>
          </div>
        </div>
        {canReachAdmin ? (
          <div className="quick-grid">
            <Link className="quick-card" to={surfaceEntryPath('admin')} data-testid="workspace-to-admin">
              <Icon name="server" />
              <div>
                <strong>{t('surface.admin.name')}</strong>
                <span>{t('workspace.home.surface.openAdmin')}</span>
              </div>
              <Icon name="arrowRight" size={15} />
            </Link>
          </div>
        ) : (
          <div className="callout" data-testid="workspace-no-admin">
            <Icon name="access" size={16} />
            <p>{t('workspace.home.surface.noAdmin')}</p>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="workspace-home-roadmap">
        <div className="panel-head">
          <div>
            <h2 id="workspace-home-roadmap">{t('workspace.home.roadmap.title')}</h2>
            <p>{t('workspace.home.roadmap.description')}</p>
          </div>
        </div>
        <div className="quick-grid">
          {SURFACE_CAPABILITY_ORDER.map((capability) => {
            const copy = SURFACE_CAPABILITIES[capability];
            return (
              <Link
                key={capability}
                className="quick-card"
                to={copy.to}
                data-capability={capability}
                data-surface-status="not-shipped"
              >
                <Icon name={copy.icon} />
                <div>
                  <strong>{t(copy.labelKey)}</strong>
                  <span>{t('workspace.home.roadmap.status')} · {t(copy.missingKey)}</span>
                </div>
                <Icon name="arrowRight" size={15} />
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/**
 * One page for every workspace capability that does not exist yet: it states the absence,
 * names the missing dependency and offers the only truthful action - go back.
 */
export function SurfaceNotYetPage({ capability }: { capability: SurfaceCapability }) {
  const { t } = useI18n();
  const copy = SURFACE_CAPABILITIES[capability];
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t('workspace.notYet.eyebrow')}
        title={t(copy.labelKey)}
        description={t(copy.missingKey)}
      />
      <section
        className="panel"
        data-testid="surface-not-yet"
        data-surface-status="not-shipped"
        data-capability={capability}
      >
        <div className="panel-head">
          <div>
            <h2 data-testid="surface-not-yet-status">{t('workspace.notYet.status')}</h2>
            <p>{t('workspace.notYet.description')}</p>
          </div>
        </div>
        <div className="callout">
          <Icon name="warning" size={16} />
          <p>{t('workspace.notYet.missingLabel')} {t(copy.missingKey)}</p>
        </div>
        <EmptyState
          icon="inbox"
          title={t('workspace.notYet.empty.title')}
          description={t('workspace.notYet.empty.description')}
          action={<Link className={buttonVariants({ variant: 'secondary' })} to="/app/home">{t('workspace.notYet.back')}</Link>}
        />
      </section>
    </div>
  );
}
