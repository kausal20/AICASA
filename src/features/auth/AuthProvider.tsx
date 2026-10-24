import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isConfigured } from '@/lib/supabase';
import type { Capability, InstitutionRef, Role, RoleAssignment, SessionContext } from '@/types/domain';

interface AuthState {
  status: 'loading' | 'signed_out' | 'ready' | 'no_access' | 'error';
  session: Session | null;
  context: SessionContext | null;
  /** The workspace the user is currently viewing. Always one of their verified roles. */
  workspace: Role | null;
  setWorkspace: (r: Role) => void;
  roles: Role[];
  activeAssignments: RoleAssignment[];
  institution: InstitutionRef | null;
  setInstitution: (id: string) => void;
  can: (cap: Capability) => boolean;
  isNational: boolean;
  regions: string[];
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  error: string | null;
}

const Ctx = createContext<AuthState | null>(null);

const WS_KEY = 'aicasa.workspace';
const INST_KEY = 'aicasa.institution';
function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* preference only */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [context, setContext] = useState<SessionContext | null>(null);
  const [status, setStatus] = useState<AuthState['status']>(isConfigured ? 'loading' : 'signed_out');
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWs] = useState<Role | null>(null);
  const [institutionId, setInstitutionId] = useState<string | null>(readPref(INST_KEY));

  const loadContext = useCallback(async (s: Session | null) => {
    if (!s) { setContext(null); setStatus('signed_out'); return; }
    const { data, error: e } = await supabase.rpc('get_my_context');
    if (e) { setError(e.message); setStatus('error'); return; }
    const ctx = data as SessionContext | null;
    setContext(ctx);
    if (!ctx || !ctx.profile.is_active || ctx.roles.length === 0) { setStatus('no_access'); return; }
    const roles = [...new Set(ctx.roles.map((r) => r.role))];
    const pref = readPref(WS_KEY) as Role | null;
    setWs(pref && roles.includes(pref) ? pref : roles.includes('admin') ? 'admin' : roles.includes('officer') ? 'officer' : 'institution');
    setStatus('ready');
  }, []);

  useEffect(() => {
    if (!isConfigured) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); loadContext(data.session); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        qc.clear();
        loadContext(s);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [loadContext, qc]);

  const value = useMemo<AuthState>(() => {
    const active = context?.roles ?? [];
    const roles = [...new Set(active.map((r) => r.role))];
    const wsAssignments = active.filter((r) => r.role === workspace);
    const insts = context?.institutions ?? [];
    const institution = insts.find((i) => i.id === institutionId) ?? insts[0] ?? null;
    return {
      status, session, context, workspace, roles, activeAssignments: wsAssignments, institution, error,
      setWorkspace: (r) => { if (roles.includes(r)) { setWs(r); writePref(WS_KEY, r); } },
      setInstitution: (id) => { setInstitutionId(id); writePref(INST_KEY, id); },
      // UI hints only — every action is re-checked by the database.
      can: (cap) => wsAssignments.some((a) => a.capabilities.includes(cap)),
      isNational: wsAssignments.some((a) => a.region_code === null),
      regions: [...new Set(wsAssignments.map((a) => a.region_code).filter(Boolean) as string[])],
      refresh: () => loadContext(session),
      signOut: async () => { await supabase.auth.signOut(); qc.clear(); },
    };
  }, [status, session, context, workspace, institutionId, error, loadContext, qc]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
