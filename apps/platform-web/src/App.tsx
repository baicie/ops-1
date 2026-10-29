import React from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import {
  canEnterSurface,
  lastSurface,
  legacyRedirect,
  surfaceEntryPath,
  useRememberSurface,
  type Surface,
} from './surface';
import { ExtensionsProvider, ExtensionRoute } from './extensions';
import { ToastProvider } from './components/Ui';
import { TooltipProvider } from './components/ui/tooltip';
import { AdminShell } from './shells/admin/AdminShell';
import { WorkspaceShell } from './shells/workspace/WorkspaceShell';
import { ForbiddenPage } from './shells/surface/SurfaceChrome';
import { IncidentWorkspacePage, WorkspaceHomePage, SurfaceNotYetPage } from './pages/workspace';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { PluginsPage } from './pages/Plugins';
import { PluginDetailPage } from './pages/PluginDetail';
import { InstallWizardPage } from './pages/InstallWizard';
import { NodesPage, NodeDetailPage } from './pages/Nodes';
import { InstanceLogsPage } from './pages/InstanceLogs';
import { ActivityPage } from './pages/Activity';
import { AccessPage } from './pages/Access';
import { DiagnosticsPage } from './pages/Diagnostics';
import { SettingsPage } from './pages/Settings';
import { OpsCenterPage } from './pages/OpsCenter';
import { NotFoundPage } from './pages/NotFound';
import { PipelinesPage, PipelineDetailPage, PipelineEditorPage } from './pages/Pipelines';
import { JobsPage, JobDetailPage, JobSubmitPage } from './pages/Jobs';
import { GovernancePage } from './pages/Governance';
import { useT } from './i18n';

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

/**
 * Authentication only: this route renders no chrome, so a surface shell is mounted by the
 * surface route below it - and never before its guard has cleared the user.
 */
function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

/**
 * The surface gate. It decides *before* rendering `<Outlet />`, which is what keeps an
 * unauthorized visit from mounting the shell (and firing its data requests) for a frame
 * and then bouncing: on denial the child route tree is never created at all.
 *
 * `RequirePlatformAccess` is the named admin gate the design pack requires; the workspace
 * gate is the same body with the other surface, because "authenticated" is not the same
 * claim as "allowed into this surface" once the server starts saying so.
 */
function SurfaceGuard({ surface }: { surface: Surface }) {
  const { user, access, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  if (!canEnterSurface(access, surface)) return <Navigate to="/403" replace />;
  return (
    <>
      <RememberSurface surface={surface} />
      <Outlet />
    </>
  );
}

/** Remembers the last legal path per surface; mounted only past the guard. */
function RememberSurface({ surface }: { surface: Surface }) {
  useRememberSurface(surface);
  return null;
}

export function RequirePlatformAccess() {
  return <SurfaceGuard surface="admin" />;
}

function RequireWorkspaceAccess() {
  return <SurfaceGuard surface="workspace" />;
}

/**
 * `/` - the only entry point that has to choose. The grant decides which surfaces exist for
 * this user; the remembered surface only breaks the tie between two surfaces they may use.
 */
function SurfaceEntry() {
  const { user, access, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  const remembered = lastSurface();
  if (remembered === 'workspace' && canEnterSurface(access, 'workspace')) {
    return <Navigate to={surfaceEntryPath('workspace')} replace />;
  }
  if (canEnterSurface(access, 'admin')) return <Navigate to={surfaceEntryPath('admin')} replace />;
  if (canEnterSurface(access, 'workspace')) return <Navigate to={surfaceEntryPath('workspace')} replace />;
  return <Navigate to="/403" replace />;
}

/**
 * Pre-G04 bookmarks. A closed redirect table (see `surface.tsx`) answers them with
 * `replace`, so Back does not ping-pong; the target is always an /admin path, which means
 * the platform guard still runs before anything is rendered. Anything unmapped is a 404.
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
                <Route path="/login" element={<LoginPage />} />
                <Route element={<RequireAuth />}>
                  <Route path="/403" element={<ForbiddenPage />} />
                  <Route index element={<SurfaceEntry />} />

                  <Route element={<RequirePlatformAccess />}>
                    <Route path="/admin" element={<AdminShell />}>
                      <Route index element={<Navigate to="/admin/overview" replace />} />
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

                  <Route element={<RequireWorkspaceAccess />}>
                    <Route path="/app" element={<WorkspaceShell />}>
                      <Route index element={<Navigate to="/app/home" replace />} />
                      <Route path="home" element={<WorkspaceHomePage />} />
                      {/* G07: the absence banner plus the investigation layout it will use. */}
                      <Route path="incidents" element={<IncidentWorkspacePage />} />
                      <Route path="investigations" element={<SurfaceNotYetPage capability="investigations" />} />
                      <Route path="observability" element={<SurfaceNotYetPage capability="observability" />} />
                      <Route path="resources" element={<SurfaceNotYetPage capability="resources" />} />
                      <Route path="sources" element={<SurfaceNotYetPage capability="sources" />} />
                      <Route path="reports" element={<SurfaceNotYetPage capability="reports" />} />
                      {/* G06: plugins whose contribution declares surface "workspace" (guard already ran). */}
                      <Route path="ext/*" element={<ExtensionRoute surface="workspace" />} />
                      <Route path="*" element={<NotFoundPage />} />
                    </Route>
                  </Route>

                  <Route path="*" element={<LegacyOrNotFound />} />
                </Route>
              </Routes>
            </ExtensionsProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  );
}
