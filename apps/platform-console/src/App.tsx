import React from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from '@opsweave/platform-client/auth';
import { ExtensionsProvider, ExtensionRoute } from '@opsweave/ui/extensions';
import { ToastProvider } from '@opsweave/ui/Ui';
import { TooltipProvider } from '@opsweave/ui/tooltip';
import { ForbiddenPage } from '@opsweave/ui/surface-chrome';
import {
  canEnterSurface,
  legacyRedirect,
  surfaceEntryPath,
} from '@opsweave/platform-client/surface';
import { useT } from '@opsweave/platform-client/i18n';
import { AdminShell } from './AdminShell';
import { LoginPage } from '@opsweave/ui/LoginPage';
import { NotFoundPage } from '@opsweave/ui/NotFoundPage';
import { OverviewPage } from './Overview';
import { PluginsPage } from './Plugins';
import { PluginDetailPage } from './PluginDetail';
import { InstallWizardPage } from './InstallWizard';
import { NodesPage, NodeDetailPage } from './Nodes';
import { InstanceLogsPage } from './InstanceLogs';
import { ActivityPage } from './Activity';
import { AccessPage } from './Access';
import { DiagnosticsPage } from './Diagnostics';
import { SettingsPage } from './Settings';
import { OpsCenterPage } from './OpsCenter';
import { PipelinesPage, PipelineDetailPage, PipelineEditorPage } from './Pipelines';
import { JobsPage, JobDetailPage, JobSubmitPage } from './Jobs';
import { GovernancePage } from './Governance';

function Splash() {
  const t = useT();
  return (
    <div className="splash">
      <div className="brand brand-large"><span className="brand-mark"><span /><span /><span /></span><span className="brand-word">{t('app.brand')}</span></div>
      <span className="spinner" />
      <p>{t('app.splash.establishing')}</p>
    </div>
  );
}

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/admin/login" replace />;
  return <Outlet />;
}

/**
 * The Platform Console's only guard: platform access.
 *
 * This app has no workspace route tree at all, which is what makes it the
 * console rather than a console section of a larger SPA (ADR-022). A caller
 * without platform access is sent to /403 before any shell mounts, so no
 * platform data request is ever fired on its behalf.
 */
function RequirePlatformAccess() {
  const { user, access, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/admin/login" replace />;
  if (!access?.allowedSurfaces?.includes('admin')) return <Navigate to="/admin/403" replace />;
  return <Outlet />;
}

/**
 * The bare `/` for a caller that is ALREADY signed in.
 *
 * Signing in is a platform act, so `/` is served by the console's bundle; but a
 * caller may be granted the workspace surface and not the console.
 *
 * The login form no longer routes through here - `LoginPage` picks its
 * destination from the grant the login response carried, exactly once, so a
 * fresh sign-in takes one navigation. What remains is the case a sign-in cannot
 * cover: a reload or a bookmark on `/` with a session already established.
 *
 * That case still needs a document navigation (the two bundles are separate
 * documents, so there is no client-side route into `/app/...`), and it belongs
 * in an effect rather than the render body: `location.replace` during render
 * re-fires on every re-render, and a second one interrupts a navigation already
 * in flight. The effect runs once, after the decision is final.
 */
function SurfaceEntry() {
  const { user, access, loading } = useAuth();
  const externalTarget =
    !loading && user && !canEnterSurface(access, 'admin') && canEnterSurface(access, 'workspace')
      ? surfaceEntryPath('workspace')
      : null;
  React.useEffect(() => {
    if (externalTarget) window.location.replace(externalTarget);
  }, [externalTarget]);

  if (loading) return <Splash />;
  if (!user) return <Navigate to="/admin/login" replace />;
  if (canEnterSurface(access, 'admin')) {
    return <Navigate to={surfaceEntryPath('admin')} replace />;
  }
  if (externalTarget) return <Splash />;
  return <Navigate to="/admin/403" replace />;
}

/**
 * Pre-G04 bookmarks: `/nodes`, `/plugins`, `/jobs` and friends.
 *
 * The redirect table lives in the shared client (`legacyRedirect`) because it is
 * a compatibility promise about URLs, not about a component. A closed list, so
 * anything unmapped stays a 404 rather than being swallowed into a page.
 */
function LegacyOrNotFound() {
  const { pathname, search } = useLocation();
  const target = legacyRedirect(pathname, search);
  if (target) return <Navigate to={target} replace />;
  return <NotFoundPage />;
}

export function App() {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <ExtensionsProvider>
              <Routes>
                <Route path="/admin/login" element={<LoginPage surface="admin" />} />
                <Route element={<RequireAuth />}>
                  {/* `/` is the only path that has to choose between the two
                      applications, and the grant decides. */}
                  <Route path="/" element={<SurfaceEntry />} />
                  <Route path="/admin/403" element={<ForbiddenPage />} />
                  <Route element={<RequirePlatformAccess />}>
                    <Route path="/admin" element={<AdminShell />}>
                      <Route index element={<Navigate to="overview" replace />} />
                      <Route path="overview" element={<OverviewPage />} />
                      <Route path="plugins" element={<PluginsPage />} />
                      <Route path="plugins/install" element={<InstallWizardPage />} />
                      <Route path="plugins/:id" element={<PluginDetailPage />} />
                      <Route path="pipelines" element={<PipelinesPage />} />
                      <Route path="pipelines/:pipelineId" element={<PipelineDetailPage />} />
                      <Route path="pipelines/:pipelineId/editor" element={<PipelineEditorPage />} />
                      <Route path="pipelines/:pipelineId/run" element={<JobSubmitPage />} />
                      <Route path="jobs" element={<JobsPage />} />
                      <Route path="jobs/:jobId" element={<JobDetailPage />} />
                      <Route path="nodes" element={<NodesPage />} />
                      <Route path="nodes/:id" element={<NodeDetailPage />} />
                      <Route path="governance" element={<GovernancePage />} />
                      <Route path="instances/:id/logs" element={<InstanceLogsPage />} />
                      <Route path="activity" element={<ActivityPage />} />
                      <Route path="access" element={<AccessPage />} />
                      <Route path="settings" element={<SettingsPage />} />
                      <Route path="settings/diagnostics" element={<DiagnosticsPage />} />
                      <Route path="ops-center" element={<OpsCenterPage />} />
                      <Route path="ext/*" element={<ExtensionRoute surface="admin" />} />
                      <Route path="*" element={<NotFoundPage />} />
                    </Route>
                  </Route>
                </Route>
                <Route path="*" element={<LegacyOrNotFound />} />
              </Routes>
            </ExtensionsProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  );
}
