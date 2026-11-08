import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '@opsweave/platform-client/auth';
import { ExtensionsProvider, ExtensionRoute } from '@opsweave/ui/extensions';
import { ToastProvider } from '@opsweave/ui/Ui';
import { TooltipProvider } from '@opsweave/ui/tooltip';
import { ForbiddenPage } from '@opsweave/ui/surface-chrome';
import { useT } from '@opsweave/platform-client/i18n';
import { WorkspaceShell } from './shells/WorkspaceShell';
import { WorkspaceHomePage, SurfaceNotYetPage } from './workspace';
import {
  lastSurface,
  useRememberSurface,
  workspaceEntryPath,
} from './routing';
import { LoginPage } from '@opsweave/ui/LoginPage';
import { NotFoundPage } from '@opsweave/ui/NotFoundPage';
import { IncidentsPage } from './Incidents';
import { IncidentDetailPage } from './IncidentDetail';
import { ObservabilityPage } from './Observability';
import { ObservabilityEntityPage } from './ObservabilityEntity';
import { SourcesPage } from './Sources';

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
 * The Ops Web's only guard: workspace access.
 *
 * There is no /admin route tree in this application (ADR-022). A platform
 * administrator who is not a member of any business workspace reaches nothing
 * here, which is the ruling D5 already made for business rows and this phase
 * carries to the application boundary.
 */
function RequireWorkspaceAccess() {
  const { user, access, loading } = useAuth();
  useRememberSurface('workspace');
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  if (!access?.allowedSurfaces?.includes('workspace')) return <Navigate to="/403" replace />;
  return <Outlet />;
}

function SurfaceEntry() {
  const { user, access, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  if (!access?.allowedSurfaces?.includes('workspace')) return <Navigate to="/403" replace />;
  void lastSurface();
  return <Navigate to={workspaceEntryPath()} replace />;
}

export function App() {
  return (
    <TooltipProvider>
      <BrowserRouter basename="/app">
        <AuthProvider>
          <ToastProvider>
            <ExtensionsProvider>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<RequireAuth />}>
                  <Route path="/403" element={<ForbiddenPage />} />
                  <Route index element={<SurfaceEntry />} />
                  <Route element={<RequireWorkspaceAccess />}>
                    <Route path="/" element={<WorkspaceShell />}>
                      <Route path="home" element={<WorkspaceHomePage />} />
                      <Route path="incidents" element={<IncidentsPage />} />
                      <Route path="incidents/:incidentId" element={<IncidentDetailPage />} />
                      <Route path="investigations" element={<SurfaceNotYetPage capability="investigations" />} />
                      <Route path="observability" element={<ObservabilityPage />} />
                      <Route path="observability/nodes/:nodeId" element={<ObservabilityEntityPage />} />
                      <Route path="resources" element={<SurfaceNotYetPage capability="resources" />} />
                      <Route path="sources" element={<SourcesPage />} />
                      <Route path="reports" element={<SurfaceNotYetPage capability="reports" />} />
                      <Route path="ext/*" element={<ExtensionRoute surface="workspace" />} />
                      <Route path="*" element={<NotFoundPage />} />
                    </Route>
                  </Route>
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </ExtensionsProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  );
}
