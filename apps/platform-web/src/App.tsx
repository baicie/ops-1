import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { ExtensionsProvider, ExtensionRoute } from './extensions';
import { ToastProvider } from './components/Ui';
import { Layout } from './components/Layout';
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

function Splash() {
  return (
    <div className="splash">
      <div className="brand brand-large"><span className="brand-mark"><span /><span /><span /></span><span className="brand-word">OpsWeave</span></div>
      <span className="spinner" />
      <p>Establishing authorized session…</p>
    </div>
  );
}

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Layout />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <ExtensionsProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route element={<RequireAuth />}>
                <Route index element={<OverviewPage />} />
                <Route path="/plugins" element={<PluginsPage />} />
                <Route path="/plugins/install" element={<InstallWizardPage />} />
                <Route path="/plugins/:id" element={<PluginDetailPage />} />
                <Route path="/pipelines" element={<PipelinesPage />} />
                <Route path="/pipelines/:pipelineId" element={<PipelineDetailPage />} />
                <Route path="/pipelines/:pipelineId/editor" element={<PipelineEditorPage />} />
                <Route path="/pipelines/:pipelineId/run" element={<JobSubmitPage />} />
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/jobs/:jobId" element={<JobDetailPage />} />
                <Route path="/nodes" element={<NodesPage />} />
                <Route path="/nodes/:id" element={<NodeDetailPage />} />
                <Route path="/instances/:id/logs" element={<InstanceLogsPage />} />
                <Route path="/activity" element={<ActivityPage />} />
                <Route path="/access" element={<AccessPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/diagnostics" element={<DiagnosticsPage />} />
                <Route path="/ops-center" element={<OpsCenterPage />} />
                <Route path="/ext/*" element={<ExtensionRoute />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </ExtensionsProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
