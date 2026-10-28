import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { canEnterSurface, surfaceEntryPath } from '../surface';
import { EmptyState, KV, PageHeader } from '../components/Ui';
import { Icon } from '../components/Icons';
import { InvestigationLayout, type InvestigationRegion } from '../components/app/investigation-layout';
import { buttonVariants } from '../components/ui/button';
import { BusinessPluginCard, BusinessStatePanel, PlatformVersionCard } from '../shells/workspace/business-states';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n';

/**
 * Business Workspace pages (G04, reworked for G07).
 *
 * Two rules run through this file:
 *
 *   1. Nothing on these pages is a sample. The business data sources (incidents,
 *      investigations, evidence, resource topology) do not exist yet, so every area that
 *      will show them states the interface it is waiting for instead of showing a zero.
 *      "0 open incidents" is a claim that the system is healthy; "the incident service is
 *      not connected" is a fact about the system.
 *   2. What *is* real is shown as real: the signed-in identity, the business plugin entries
 *      the server actually granted, and the kernel version this browser is talking to.
 *
 * The navigation lives in one registry below, which the workspace shell renders - a page can
 * therefore never appear in the rail without a destination behind it.
 */

export type SurfaceCapability = 'incidents' | 'investigations' | 'observability' | 'resources' | 'sources' | 'reports';

export type SurfaceNavGroup = 'work' | 'discover' | 'results';

interface CapabilityCopy {
  to: string;
  labelKey: MessageKey;
  /** The interface this page is waiting for; the only thing an unshipped page may say. */
  missingKey: MessageKey;
  icon: string;
  /** Sidebar group; the shell derives its navigation from this registry. */
  navGroup: SurfaceNavGroup;
  /**
   * Whether the capability deserves a rail entry. `sources` does not: the design pack lists
   * it as an authorized business destination, and no authorization scope exists for it yet,
   * so it is offered from the capability list (with its missing dependency spelled out)
   * rather than dressed up as a destination in the primary navigation.
   */
  inNavigation: boolean;
}

/** One registry behind the sidebar, the task space and the "not shipped" pages. */
export const SURFACE_CAPABILITIES: Record<SurfaceCapability, CapabilityCopy> = {
  incidents: { to: '/app/incidents', labelKey: 'workspace.nav.incidents', missingKey: 'workspace.notYet.incidents.missing', icon: 'alert', navGroup: 'work', inNavigation: true },
  investigations: { to: '/app/investigations', labelKey: 'workspace.nav.investigations', missingKey: 'workspace.notYet.investigations.missing', icon: 'search', navGroup: 'work', inNavigation: true },
  observability: { to: '/app/observability', labelKey: 'workspace.nav.observability', missingKey: 'workspace.notYet.observability.missing', icon: 'activity', navGroup: 'discover', inNavigation: true },
  resources: { to: '/app/resources', labelKey: 'workspace.nav.resources', missingKey: 'workspace.notYet.resources.missing', icon: 'box', navGroup: 'discover', inNavigation: true },
  sources: { to: '/app/sources', labelKey: 'workspace.nav.sources', missingKey: 'workspace.notYet.sources.missing', icon: 'upload', navGroup: 'results', inNavigation: false },
  reports: { to: '/app/reports', labelKey: 'workspace.nav.reports', missingKey: 'workspace.notYet.reports.missing', icon: 'file', navGroup: 'results', inNavigation: true },
};

export const SURFACE_CAPABILITY_ORDER: SurfaceCapability[] = ['incidents', 'investigations', 'observability', 'resources', 'sources', 'reports'];

/**
 * The four areas of the home task space. Each names the capability whose interface it needs,
 * so the section and the "not shipped" page can never disagree about what is missing.
 */
interface TaskArea {
  id: string;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  capability: SurfaceCapability;
  to: string;
  /** An extra scope statement, printed only where the scope itself is the honest answer. */
  noteKey?: MessageKey;
}

const TASK_AREAS: TaskArea[] = [
  {
    id: 'awaiting',
    titleKey: 'workspace.tasks.awaiting.title',
    descriptionKey: 'workspace.tasks.awaiting.description',
    capability: 'incidents',
    to: '/app/incidents',
  },
  {
    id: 'investigations',
    titleKey: 'workspace.tasks.investigations.title',
    descriptionKey: 'workspace.tasks.investigations.description',
    capability: 'investigations',
    to: '/app/investigations',
  },
  {
    id: 'services',
    titleKey: 'workspace.tasks.services.title',
    descriptionKey: 'workspace.tasks.services.description',
    capability: 'resources',
    to: '/app/resources',
    noteKey: 'workspace.tasks.services.scope',
  },
  {
    id: 'evidence',
    titleKey: 'workspace.tasks.evidence.title',
    descriptionKey: 'workspace.tasks.evidence.description',
    capability: 'sources',
    to: '/app/investigations',
  },
];

/**
 * `/app/home` - the task space.
 *
 * The four areas open the page, because "what needs me" is the first question a business
 * user has. They are followed by what can actually be done today, and last by the honest
 * availability board for the six business destinations.
 */
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

      <section className="task-space" aria-labelledby="workspace-task-space">
        <div className="task-space-head">
          <h2 id="workspace-task-space">{t('workspace.home.taskSpace.title')}</h2>
          <p>{t('workspace.home.taskSpace.description')}</p>
        </div>
        <div className="task-grid">
          {TASK_AREAS.map((area) => {
            const copy = SURFACE_CAPABILITIES[area.capability];
            const headingId = `workspace-task-${area.id}`;
            return (
              <section
                key={area.id}
                className="panel task-panel"
                aria-labelledby={headingId}
                data-testid={`home-${area.id}`}
                data-task={area.id}
                data-source-status="unavailable"
                data-missing-capability={area.capability}
              >
                <div className="panel-head">
                  <div>
                    <h3 id={headingId}>{t(area.titleKey)}</h3>
                    <p>{t(area.descriptionKey)}</p>
                  </div>
                </div>
                <BusinessStatePanel
                  state="unavailable"
                  title={t('workspace.state.notConnected')}
                  detail={(
                    <>
                      {t('workspace.notYet.missingLabel')} {t(copy.missingKey)}
                      {area.noteKey ? <span className="task-scope"> {t(area.noteKey)}</span> : null}
                    </>
                  )}
                  action={(
                    <Link className="task-link" to={area.to}>
                      {t('workspace.tasks.open', { name: t(copy.labelKey) })}
                    </Link>
                  )}
                />
              </section>
            );
          })}
        </div>
      </section>

      <section className="panel" aria-labelledby="workspace-available">
        <div className="panel-head">
          <div>
            <h2 id="workspace-available">{t('workspace.home.available.title')}</h2>
            <p>{t('workspace.home.available.description')}</p>
          </div>
        </div>
        <div className="business-card-grid">
          <div className="business-card-slot">
            <h3>{t('workspace.home.plugins.title')}</h3>
            <p className="business-card-hint">{t('workspace.home.plugins.description')}</p>
            <BusinessPluginCard />
          </div>
          <div className="business-card-slot">
            <h3>{t('workspace.home.platform.title')}</h3>
            <p className="business-card-hint">{t('workspace.home.platform.description')}</p>
            <PlatformVersionCard />
          </div>
          <div className="business-card-slot">
            <h3>{t('workspace.home.surface.title')}</h3>
            <p className="business-card-hint">{t('workspace.home.surface.description')}</p>
            {canReachAdmin ? (
              <Link className="quick-card business-surface-card" to={surfaceEntryPath('admin')} data-testid="workspace-to-admin">
                <Icon name="server" />
                <div>
                  <strong>{t('surface.admin.name')}</strong>
                  <span>{t('workspace.home.surface.openAdmin')}</span>
                </div>
                <Icon name="arrowRight" size={15} />
              </Link>
            ) : (
              <div className="callout" data-testid="workspace-no-admin">
                <Icon name="access" size={16} />
                <p>{t('workspace.home.surface.noAdmin')}</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="workspace-account">
        <div className="panel-head">
          <div>
            <h2 id="workspace-account">{t('workspace.home.account.title')}</h2>
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

      <section className="panel" aria-labelledby="workspace-capabilities">
        <div className="panel-head">
          <div>
            <h2 id="workspace-capabilities">{t('workspace.home.capabilities.title')}</h2>
            <p>{t('workspace.home.capabilities.description')}</p>
          </div>
        </div>
        <ul className="capability-status-list">
          {SURFACE_CAPABILITY_ORDER.map((capability) => {
            const copy = SURFACE_CAPABILITIES[capability];
            return (
              <li key={capability} data-surface-status="not-shipped" data-capability={capability}>
                <Icon name={copy.icon} size={15} />
                <Link to={copy.to}>{t(copy.labelKey)}</Link>
                <span className="capability-status-code">{t('workspace.home.capabilities.status')}</span>
                <span className="capability-status-missing">{t(copy.missingKey)}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/**
 * `/app/incidents` - the incident list and the investigation workspace behind it.
 *
 * The absence panel stays: the page owes the reader the name of the missing dependency before
 * it shows a layout. Under it the investigation workspace is laid out for real - three
 * regions with their owners and their empty slots - so the shape is settled while the data
 * contract is not. No event, no timestamp, no hypothesis and no model conclusion is rendered
 * here, and the empty slots say why rather than looking like a successful empty query.
 */
export function IncidentWorkspacePage() {
  const { t } = useI18n();
  const copy = SURFACE_CAPABILITIES.incidents;

  const regions: InvestigationRegion[] = [
    { id: 'timeline', title: t('workspace.region.timeline'), plan: t('workspace.region.timeline.plan'), requirement: t('workspace.notYet.incidents.missing') },
    { id: 'analysis', title: t('workspace.region.analysis'), plan: t('workspace.region.analysis.plan'), requirement: t('workspace.notYet.investigations.missing') },
    { id: 'detail', title: t('workspace.region.detail'), plan: t('workspace.region.detail.plan'), requirement: t('workspace.notYet.incidents.missing') },
  ];

  return (
    <div className="page-stack" data-testid="incidents-page">
      <PageHeader
        eyebrow={t('workspace.incidents.eyebrow')}
        title={t(copy.labelKey)}
        description={t('workspace.incidents.description')}
      />

      <section
        className="panel"
        data-testid="surface-not-yet"
        data-surface-status="not-shipped"
        data-capability="incidents"
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
      </section>

      <section className="panel" aria-labelledby="workspace-incident-layout">
        <div className="panel-head">
          <div>
            <h2 id="workspace-incident-layout">{t('workspace.incidents.layout.title')}</h2>
            <p>{t('workspace.incidents.layout.description')}</p>
          </div>
        </div>
        <InvestigationLayout label={t('workspace.incidents.layout.title')} regions={regions} />
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
