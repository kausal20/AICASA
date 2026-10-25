import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import { useAuth } from '@/features/auth/AuthProvider';
import { getPreferences, setPreference } from '@/services/operations';
import { listInstitutions } from '@/services/admin';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TextField, TextAreaField } from '@/components/ui/Field';
import { KeyValue, PageHeader } from '@/components/ui/Page';
import { Notice } from '@/components/ui/States';
import { Badge } from '@/components/ui/Badge';
import { useAction } from '@/hooks/useAction';
import { humanize } from '@/lib/format';
import { responsibilityLabel } from '@/lib/responsibilities';
import { ROLE_LABEL } from '@/components/layout/nav';

const KINDS = ['stage_changed', 'assignment', 'submitted', 'deficiency', 'correction_received', 'evc', 'compliance', 'reminder', 'escalation', 'decision'];

export function ProfilePage() {
  const { context, workspace, institution, refresh } = useAuth();
  const p = context?.profile;
  const [name, setName] = useState(p?.full_name ?? '');
  const [designation, setDesignation] = useState(p?.designation ?? '');
  const [phone, setPhone] = useState(p?.phone ?? '');
  const save = useAction(async () => unwrap(await supabase.rpc('update_my_profile', { p_full_name: name, p_designation: designation, p_phone: phone })),
    { success: 'Profile saved.', onSuccess: () => refresh() });

  return (
    <div>
      <PageHeader title={workspace === 'institution' ? 'Institution profile' : 'My profile'} description="Your role and scope are assigned by an administrator and cannot be changed here." />
      <div className="grid gap-6 lg:grid-cols-2">
        {workspace === 'institution' && institution && <InstitutionCard id={institution.id} canEdit={institution.member_role === 'representative'} />}
        <Card>
          <CardHeader title="Your details" description={p?.email} />
          <CardBody className="space-y-4">
            <TextField label="Full name" required value={name} onChange={(e) => setName(e.target.value)} />
            <TextField label="Designation" value={designation} onChange={(e) => setDesignation(e.target.value)} />
            <TextField label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Access" description="Granted by an authorised administrator." />
          <CardBody>
            <ul className="space-y-3">
              {context?.roles.map((r) => (
                <li key={r.id} className="text-[13px]">
                  <p className="font-medium">{ROLE_LABEL[r.role]} · {r.role === 'institution' ? 'institution membership' : r.region_code ?? 'National scope'}</p>
                  <div className="mt-1 flex flex-wrap gap-1">{r.capabilities.map((c) => <Badge key={c} tone="neutral">{responsibilityLabel(c)}</Badge>)}</div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <PreferencesCard />
      </div>
    </div>
  );
}

function InstitutionCard({ id, canEdit }: { id: string; canEdit: boolean }) {
  const q = useQuery({ queryKey: ['institutions'], queryFn: listInstitutions });
  const inst = q.data?.find((i) => i.id === id);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  useEffect(() => { if (inst) { setEmail(inst.contact_email ?? ''); setPhone(inst.contact_phone ?? ''); setAddress(inst.address ?? ''); } }, [inst]);
  const save = useAction(async () => unwrap(await supabase.rpc('update_institution_contact', { p_institution_id: id, p_contact_email: email, p_contact_phone: phone, p_address: address })),
    { success: 'Institution contact details saved.', invalidate: [['institutions']] });
  if (!inst) return null;
  return (
    <Card className="lg:col-span-2">
      <CardHeader title={inst.name} description={`${inst.code} · ${humanize(inst.kind)} · ${inst.city}, ${inst.state} · Region ${inst.region_code}`} action={inst.is_demo && <Badge tone="warning">Synthetic demo institution</Badge>} />
      <CardBody className="grid gap-6 md:grid-cols-2">
        <KeyValue items={[{ label: 'Registered name', value: inst.name }, { label: 'Identifier (demo)', value: inst.code }, { label: 'Region', value: inst.region_code }, { label: 'Type', value: humanize(inst.kind) }]} />
        <div className="space-y-3">
          <TextField label="Contact email" value={email} disabled={!canEdit} onChange={(e) => setEmail(e.target.value)} />
          <TextField label="Contact phone" value={phone} disabled={!canEdit} onChange={(e) => setPhone(e.target.value)} />
          <TextAreaField label="Address" rows={2} value={address} disabled={!canEdit} onChange={(e) => setAddress(e.target.value)} />
          {canEdit ? <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save contact details</Button> : <Notice tone="info">Only institution representatives can edit contact details.</Notice>}
          <p className="text-xs text-ink-soft">Name, region and identifiers are official records and change only through an authorised process.</p>
        </div>
      </CardBody>
    </Card>
  );
}

function PreferencesCard() {
  const q = useQuery({ queryKey: ['prefs'], queryFn: getPreferences });
  const save = useAction(({ kind, inApp, email }: { kind: string; inApp: boolean; email: boolean }) => setPreference(kind, inApp, email), { invalidate: [['prefs']], success: 'Preference saved.' });
  const pref = (k: string) => q.data?.find((x) => x.kind === k) ?? { kind: k, in_app: true, email: false };
  return (
    <Card>
      <CardHeader title="Notification preferences" description="Email is recorded as skipped while no email provider is configured." />
      <CardBody>
        <table className="w-full text-[13px]">
          <thead><tr className="text-left text-xs text-ink-soft"><th className="pb-2 font-medium">Type</th><th className="pb-2 text-center font-medium">In-app</th><th className="pb-2 text-center font-medium">Email</th></tr></thead>
          <tbody>
            {KINDS.map((k) => {
              const p = pref(k);
              return (
                <tr key={k} className="border-t border-line">
                  <td className="py-2">{humanize(k)}</td>
                  <td className="py-2 text-center"><input type="checkbox" aria-label={`${humanize(k)} in-app`} className="accent-[#1e3a8a]" checked={p.in_app} onChange={(e) => save.mutate({ kind: k, inApp: e.target.checked, email: p.email })} /></td>
                  <td className="py-2 text-center"><input type="checkbox" aria-label={`${humanize(k)} email`} className="accent-[#1e3a8a]" checked={p.email} onChange={(e) => save.mutate({ kind: k, inApp: p.in_app, email: e.target.checked })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}
