import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './AuthProvider';
import type { Capability, Role } from '@/types/domain';
import { PermissionState } from '@/components/ui/States';
import { responsibilityLabel } from '@/lib/responsibilities';

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page" role="status">
      <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
      <span className="ml-2 text-sm text-ink-soft">{label}…</span>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <FullPageSpinner label="Checking your session" />;
  if (status === 'signed_out') return <Navigate to="/sign-in" replace state={{ from: loc.pathname }} />;
  if (status === 'no_access' || status === 'error') return <Navigate to="/unauthorised" replace />;
  return <>{children}</>;
}

/** Hides areas outside the current workspace. The database enforces the same boundary independently. */
export function RequireWorkspace({ roles, capability, children }: { roles: Role[]; capability?: Capability; children: ReactNode }) {
  const { workspace, can } = useAuth();
  if (!workspace || !roles.includes(workspace)) return <PermissionState />;
  if (capability && !can(capability)) {
    return <PermissionState body={`This area needs the "${responsibilityLabel(capability)}" responsibility, which your account does not hold.`} />;
  }
  return <>{children}</>;
}
