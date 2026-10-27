import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UserPlus, Search, Users } from 'lucide-react';
import { listExperts } from '@/services/experts';
import { useAuth } from '@/features/auth/AuthProvider';
import { assignRole, listInstitutions, listRegions, listUsers, revokeRole, type UserRow } from '@/services/admin';
import { Card } from '@/components/ui/Card';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { Input, SelectField, TextAreaField } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { humanize } from '@/lib/format';
import { responsibilityLabel } from '@/lib/responsibilities';
import type { Role } from '@/types/domain';

const CAPS: Record<Role, string[]> = {
  institution: [],
  officer: ['scrutiny', 'evc', 'committee', 'compliance', 'decision', 'assignment'],
  admin: ['assignment', 'workflow_config', 'user_admin', 'reports', 'audit', 'escalation', 'compliance'],
};

export function UsersPage() {
  const { session } = useAuth();
  const q = useQuery({ queryKey: ['users'], queryFn: listUsers });
  const [search, setSearch] = useState('');
  const [grant, setGrant] = useState<UserRow | null>(null);
  const [revoke, setRevoke] = useState<{ user: UserRow; id: string; label: string } | null>(null);
  const rows = (q.data ?? []).filter((u) => !search || `${u.full_name} ${u.email}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader title="Users and access" description="Roles, regions and responsibilities. Grants and revocations require a reason and are audited. Nobody can change their own access." />
      <Notice tone="info">New sign-in accounts are created through the controlled provisioning or invitation process (see README); there is no public sign-up. Access is granted here.</Notice>
      <Card className="mt-5">
        <div className="border-b border-line p-4">
          <div className="relative max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
            <Input className="pl-9" placeholder="Search name or email" aria-label="Search users" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        </div>
        {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !rows.length ? <EmptyState title="No users found" /> : (
          <DataTable>
            <thead><tr><Th>User</Th><Th>Active access</Th><Th>Institution</Th><Th /></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <Td><p className="font-medium">{u.full_name || '—'}</p><p className="text-xs text-ink-soft">{u.email}</p>
                    <div className="mt-1 flex gap-1">{!u.is_active && <Badge tone="danger">Inactive</Badge>}{u.is_demo && <Badge tone="warning">Demo</Badge>}</div></Td>
                  <Td>
                    <ul className="space-y-1.5">
                      {u.user_role_assignments.filter((r) => r.is_active).map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-1.5 text-[13px]">
                          <Badge tone={r.role === 'admin' ? 'accent' : r.role === 'officer' ? 'primary' : 'neutral'}>{humanize(r.role)} · {r.role === 'institution' ? 'member' : r.region_code ?? 'National'}</Badge>
                          <span className="text-xs text-ink-soft">{r.capabilities.map(responsibilityLabel).join(', ')}</span>
                        </li>
                      ))}
                      {!u.user_role_assignments.some((r) => r.is_active) && <li className="text-xs text-ink-soft">No active role</li>}
                    </ul>
                  </Td>
                  <Td className="text-[13px]">{u.institution_memberships.filter((m) => m.is_active).map((m) => m.institutions?.name).join(', ') || '—'}</Td>
                  <Td className="text-right">{u.id !== session?.user.id && (() => {
                    // one state-aware action: revoke while access is active, grant once it is not
                    const active = u.user_role_assignments.find((r) => r.is_active);
                    return active
                      ? <Button size="sm" variant="secondary" onClick={() => setRevoke({ user: u, id: active.id, label: `${humanize(active.role)} ${active.region_code ?? ''}`.trim() })}>Revoke access</Button>
                      : <Button size="sm" variant="secondary" icon={<UserPlus className="h-3.5 w-3.5" />} onClick={() => setGrant(u)}>Grant access</Button>;
                  })()}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
      <ExpertRegistry />
      {grant && <GrantDialog user={grant} onClose={() => setGrant(null)} />}
      {revoke && <RevokeDialog {...revoke} onClose={() => setRevoke(null)} />}
    </div>
  );
}

/** Experts hold the "Expert" role for panel selection only. They have no sign-in access unless an account is granted above. */
function ExpertRegistry() {
  const q = useQuery({ queryKey: ['experts'], queryFn: listExperts });
  const rows = q.data ?? [];
  return (
    <Card className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Badge tone="accent">Expert</Badge>Expert registry</h2>
          <p className="mt-0.5 text-[13px] text-ink-soft">People recommended for expert visit panels. Home district, employer and declared conflicts decide who is excluded for each institute.</p>
        </div>
        <ButtonLink to="/app/evc/experts" variant="secondary" icon={<Users className="h-4 w-4" />}>Manage experts</ButtonLink>
      </div>
      {q.isLoading ? <LoadingRows rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !rows.length ? <EmptyState title="No experts yet" /> : (
        <ul className="divide-y divide-line">
          {rows.slice(0, 8).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-[13px]">
              <span><span className="font-medium">{e.full_name}</span> <span className="text-ink-soft">· {e.home_district}, {e.home_state}</span></span>
              <span className="flex flex-wrap items-center gap-1.5"><Badge tone="accent">Expert · {e.region_code}</Badge>{e.specializations.map((s) => <Badge key={s} tone="primary">{s}</Badge>)}</span>
            </li>
          ))}
          {rows.length > 8 && <li className="px-5 py-2.5 text-xs text-ink-soft">+{rows.length - 8} more in the registry</li>}
        </ul>
      )}
    </Card>
  );
}

function GrantDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { isNational, regions: myRegions } = useAuth();
  const regions = useQuery({ queryKey: ['regions'], queryFn: listRegions });
  const insts = useQuery({ queryKey: ['institutions'], queryFn: listInstitutions });
  const [role, setRole] = useState<Role>('officer');
  const [region, setRegion] = useState(isNational ? '' : myRegions[0] ?? '');
  const [caps, setCaps] = useState<string[]>([]);
  const [inst, setInst] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction(() => assignRole({ userId: user.id, role, region: region || null, capabilities: caps, reason, institutionId: inst || null }),
    { success: 'Access granted and recorded in the audit log.', invalidate: [['users']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Grant access" description={`${user.full_name || user.email}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={reason.trim().length < 10 || (role === 'institution' && !inst)} onClick={() => act.mutate(undefined)}>Grant</Button></>}>
      <div className="space-y-4">
        <SelectField label="Role" required value={role} onChange={(e) => { setRole(e.target.value as Role); setCaps([]); }}>
          <option value="officer">AICTE officer</option>
          {isNational && <option value="admin">Administrator</option>}
          <option value="institution">Institution representative</option>
        </SelectField>
        {role === 'institution' ? (
          <SelectField label="Institution" required value={inst} onChange={(e) => setInst(e.target.value)}>
            <option value="">Select…</option>
            {(insts.data ?? []).filter((i) => isNational || myRegions.includes(i.region_code)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </SelectField>
        ) : (
          <>
            <SelectField label="Region scope" required={!isNational} value={region} onChange={(e) => setRegion(e.target.value)}>
              {isNational && <option value="">National (all regions)</option>}
              {(regions.data ?? []).filter((r) => isNational || myRegions.includes(r.code)).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
            </SelectField>
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium">Responsibilities</legend>
              <div className="flex flex-wrap gap-2">
                {CAPS[role].map((c) => (
                  <label key={c} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] ${caps.includes(c) ? 'border-primary bg-primary-soft' : 'border-line'}`}>
                    <input type="checkbox" className="accent-[#1e3a8a]" checked={caps.includes(c)} onChange={() => setCaps(caps.includes(c) ? caps.filter((x) => x !== c) : [...caps, c])} />{responsibilityLabel(c)}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}
        <TextAreaField label="Reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} hint="e.g. the order or request that authorises this access." />
      </div>
    </Dialog>
  );
}

function RevokeDialog({ user, id, label, onClose }: { user: UserRow; id: string; label: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const act = useAction(() => revokeRole(id, reason), { success: 'Access revoked.', invalidate: [['users']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Revoke access" description={`${label} for ${user.full_name || user.email}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={act.isPending} disabled={reason.trim().length < 10} onClick={() => act.mutate(undefined)}>Revoke</Button></>}>
      <TextAreaField label="Reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}
