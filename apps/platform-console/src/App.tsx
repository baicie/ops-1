import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '@opsweave/platform-client/auth';
import { ExtensionsProvider, ExtensionRoute } from '@opsweave/ui/extensions';
import { ToastProvider } from '@opsweave/ui/Ui';
import { TooltipProvider } from '@opsweave/ui/tooltip';
import { ForbiddenPage } from '@opsweave/ui/surface-chrome';
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
  if (!user) return <Navigate to="/login" replace />;
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
  if (!user) return <Navigate to="/login" replace />;
  if (!access?.allowedSurfaces?.includes('admin')) return <Navigate to="/403" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <TooltipProvider>
      <BrowserRouter basename="/admin">
        <AuthProvider>
          <ToastProvider>
            <ExtensionsProvider>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<RequireAuth />}>
                  <Route path="/403" element={<ForbiddenPage />} />
                  <Route element={<RequirePlatformAccess />}>
                    <Route path="/" element={<AdminShell />}>
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
              </Routes>
            </ExtensionsProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  );
}
