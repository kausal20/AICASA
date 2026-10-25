import { Component, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { RequireAuth, RequireWorkspace } from '@/features/auth/guards';
import { ForgotPasswordPage, NotFoundPage, ResetPasswordPage, SignInPage, UnauthorisedPage } from '@/features/auth/AuthPages';
import { AppShell } from '@/components/layout/AppShell';
import { LandingPage } from '@/features/landing/LandingPage';
import { InstitutionDashboard } from '@/features/dashboards/InstitutionDashboard';
import { OfficerDashboard } from '@/features/dashboards/OfficerDashboard';
import { AdminDashboard } from '@/features/dashboards/AdminDashboard';
import { ApplicationsListPage } from '@/features/applications/ApplicationsListPage';
import { ApplicationDetailPage } from '@/features/applications/ApplicationDetailPage';
import { NewApplicationPage } from '@/features/applications/NewApplicationPage';
import { DocumentCentrePage, PrecheckPage } from '@/features/documents/DocumentCentrePage';
import { DeficienciesPage } from '@/features/deficiencies/DeficienciesPage';
import { EvcPage } from '@/features/evc/EvcPage';
import { ExpertsPage } from '@/features/evc/ExpertsPage';
import { CompliancePage } from '@/features/compliance/CompliancePage';
import { ExpiryPage } from '@/features/compliance/ExpiryPage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { TasksPage } from '@/features/tasks/TasksPage';
import { EscalationsPage } from '@/features/escalations/EscalationsPage';
import { ProfilePage } from '@/features/profile/ProfilePage';
import { WorkflowsPage } from '@/features/admin/WorkflowsPage';
import { UsersPage } from '@/features/admin/UsersPage';
import { RulesPage } from '@/features/admin/RulesPage';
import { AuditPage } from '@/features/admin/AuditPage';
import { ReportsPage } from '@/features/admin/ReportsPage';
import { SystemPage } from '@/features/admin/SystemPage';
import { ErrorState } from '@/components/ui/States';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      retry: (count, err) => count < 2 && !String((err as { code?: string })?.code ?? '').startsWith('42'),
      refetchOnWindowFocus: true,
    },
  },
});

class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    if (this.state.error) {
      return <div className="mx-auto max-w-lg p-8"><ErrorState title="This page failed to render" error={this.state.error} onRetry={() => this.setState({ error: null })} /></div>;
    }
    return this.props.children;
  }
}

/** One home route, three dashboards: chosen from the verified workspace. */
function Home() {
  const { workspace } = useAuth();
  if (workspace === 'admin') return <AdminDashboard />;
  if (workspace === 'officer') return <OfficerDashboard />;
  return <InstitutionDashboard />;
}

const I = (el: ReactNode) => <RequireWorkspace roles={['institution']}>{el}</RequireWorkspace>;
const S = (el: ReactNode) => <RequireWorkspace roles={['officer', 'admin']}>{el}</RequireWorkspace>;
const O = (el: ReactNode) => <RequireWorkspace roles={['officer']}>{el}</RequireWorkspace>;
const A = (el: ReactNode, cap?: Parameters<typeof RequireWorkspace>[0]['capability']) => <RequireWorkspace roles={['admin']} capability={cap}>{el}</RequireWorkspace>;

const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/unauthorised', element: <UnauthorisedPage /> },
  {
    path: '/app',
    element: <RequireAuth><ErrorBoundary><AppShell /></ErrorBoundary></RequireAuth>,
    children: [
      { index: true, element: <Home /> },
      { path: 'applications', element: <ApplicationsListPage /> },
      { path: 'applications/new', element: I(<NewApplicationPage />) },
      { path: 'applications/:id', element: <ApplicationDetailPage /> },
      { path: 'queue', element: O(<ApplicationsListPage mode="mine" />) },
      { path: 'documents', element: I(<DocumentCentrePage />) },
      { path: 'precheck', element: I(<PrecheckPage />) },
      { path: 'deficiencies', element: <RequireWorkspace roles={['institution', 'officer']}><DeficienciesPage /></RequireWorkspace> },
      { path: 'compliance', element: <CompliancePage /> },
      { path: 'expiry', element: <ExpiryPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'evc', element: S(<EvcPage />) },
      { path: 'evc/experts', element: S(<ExpertsPage />) },
      { path: 'tasks', element: O(<TasksPage />) },
      { path: 'escalations', element: S(<EscalationsPage />) },
      { path: 'admin/workflows', element: A(<WorkflowsPage />) },
      { path: 'admin/rules', element: A(<RulesPage />) },
      { path: 'admin/users', element: A(<UsersPage />, 'user_admin') },
      { path: 'admin/audit', element: A(<AuditPage />, 'audit') },
      { path: 'admin/reports', element: A(<ReportsPage />, 'reports') },
      { path: 'admin/system', element: A(<SystemPage />) },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={300}>
          <AuthProvider>
            <RouterProvider router={router} />
            <Toaster position="top-right" closeButton toastOptions={{ duration: 5000, classNames: { toast: 'font-sans text-[13px]' } }} />
          </AuthProvider>
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
